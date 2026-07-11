const express = require("express");
let compression = null;
try { compression = require("compression"); } catch { /* optional; install with `npm install` */ }
const path = require("path");
const http = require("http");
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const zlib = require("zlib");
const { URL } = require("url");
const { execSync } = require("child_process");
const { buildLibraryFromM3U } = require("./playlist-lib");

function ipv4ToInt(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function isTailscaleIP(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return (n & 0xffc00000) === 0x64400000; // 100.64.0.0/10 (Tailscale CGNAT)
}

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n) || n < 0 || n > 255)) return false;
  if (isTailscaleIP(ip)) return true;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

function collectIPv4() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === "IPv4" && !i.internal) out.push({ address: i.address, name });
    }
  }
  return out;
}

function tailscaleIP() {
  const hit = collectIPv4().find(i => isTailscaleIP(i.address) || /^tailscale/i.test(i.name));
  return hit ? hit.address : null;
}

function tailscaleDNS() {
  try {
    const out = execSync("tailscale status --json", { encoding: "utf8", timeout: 4000, windowsHide: true });
    const dns = ((JSON.parse(out).Self || {}).DNSName || "").replace(/\.$/, "");
    return dns || null;
  } catch {
    return null;
  }
}

function tailscaleCmd(args) {
  try {
    return execSync("tailscale " + args, { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
  } catch {
    return null;
  }
}

function urlWithPort(proto, host, port) {
  const p = Number(port);
  if (!host) return null;
  if ((proto === "http" && p === 80) || (proto === "https" && p === 443)) return proto + "://" + host;
  return proto + "://" + host + ":" + p;
}

function parseTailscaleProxy(jsonText) {
  if (!jsonText) return { serve: false, funnel: false };
  try {
    const j = JSON.parse(jsonText);
    if (!j || (typeof j === "object" && !Object.keys(j).length)) return { serve: false, funnel: false };
    const web = j.Web || j.web || {};
    const hosts = Object.keys(web);
    const httpsHost = hosts.find(h => /:443$/.test(h)) || hosts[0] || null;
    const hostOnly = httpsHost ? httpsHost.replace(/:443$/, "").replace(/:\d+$/, "") : null;
    const handlers = httpsHost && web[httpsHost] && (web[httpsHost].Handlers || web[httpsHost].handlers);
    const proxy = handlers && (handlers["/"] || handlers[""]);
    const target = proxy && (proxy.Proxy || proxy.proxy || "");
    return {
      serve: !!(hostOnly || Object.keys(j.TCP || j.tcp || {}).length || hosts.length),
      funnel: !!j.Funnel,
      host: hostOnly,
      target: target || null,
    };
  } catch {
    return { serve: false, funnel: false };
  }
}

function tailscaleNodeId() {
  try {
    const st = JSON.parse(tailscaleCmd("status --json") || "{}");
    return (st.Self || {}).ID || "";
  } catch {
    return "";
  }
}

function tailscaleAccess() {
  const serve = parseTailscaleProxy(tailscaleCmd("serve status --json"));
  const funnel = parseTailscaleProxy(tailscaleCmd("funnel status --json"));
  const dns = tailscaleDNS();
  const host = funnel.host || serve.host || dns;
  const active = serve.serve || funnel.funnel;
  const isPublic = !!funnel.funnel;
  const publicUrl = active && host ? "https://" + host : null;
  const node = tailscaleNodeId();
  let serveEnableUrl = null;
  let funnelEnableUrl = null;
  if (!serve.serve && node) serveEnableUrl = "https://login.tailscale.com/f/serve?node=" + node;
  if (!funnel.funnel && node) funnelEnableUrl = "https://login.tailscale.com/f/funnel?node=" + node;
  return { serve, funnel, dns, host, active, isPublic, publicUrl, serveEnableUrl, funnelEnableUrl };
}

function port80Forwarded() {
  try {
    const out = execSync("netsh interface portproxy show v4tov4", { encoding: "utf8", timeout: 3000, windowsHide: true });
    const flat = out.replace(/\s+/g, " ");
    return /0\.0\.0\.0 80 127\.0\.0\.1 3000/.test(flat);
  } catch {
    return false;
  }
}

function lanIP() {
  const hit = collectIPv4().find(i => !isTailscaleIP(i.address) && isPrivateIPv4(i.address));
  return hit ? hit.address : null;
}

function isAllowedOrigin(origin) {
  if (!origin || origin.startsWith("file://")) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host.startsWith("127.")) return true;
    if (host.endsWith(".ts.net")) return true;
    if (host.endsWith(".trycloudflare.com")) return true;
    const brand = (CFG.publicDomain || "").replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
    if (brand && (host === brand || host.endsWith("." + brand))) return true;
    return isPrivateIPv4(host) || isTailscaleIP(host);
  } catch {
    return false;
  }
}

function readTunnelFile() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "tunnel.json"), "utf8");
    const j = JSON.parse(raw);
    if (j && j.url && /^https?:\/\//.test(j.url)) return j;
  } catch { /* no tunnel */ }
  return null;
}

function normalizePublicUrl(u) {
  if (!u || typeof u !== "string") return null;
  const s = u.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[a-zA-Z0-9._-]+/.test(s)) return null;
  return s;
}

function isAllowedStreamUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (/^(localhost|127\.|0\.0\.0\.0)$/i.test(u.hostname) || u.hostname === "::1") return false;
    return true;
  } catch {
    return false;
  }
}

let _networkCache = null;
let _networkCacheAt = 0;
const NETWORK_CACHE_MS = 15000;

function cachedNetworkUrls(port) {
  const now = Date.now();
  if (_networkCache && now - _networkCacheAt < NETWORK_CACHE_MS) return _networkCache;
  _networkCache = networkUrls(port);
  _networkCacheAt = now;
  return _networkCache;
}

function networkUrls(port) {
  const urls = { local: urlWithPort("http", "localhost", port) };
  const lan = lanIP();
  const ts = tailscaleIP();
  const access = tailscaleAccess();
  const dns = access.dns || tailscaleDNS();
  const lan80 = port80Forwarded();
  const tunnel = readTunnelFile();
  const brand = normalizePublicUrl(CFG.publicDomain || "");

  if (lan) {
    urls.lan = lan80 ? urlWithPort("http", lan, 80) : urlWithPort("http", lan, port);
    if (lan80) urls.lanDirect = urlWithPort("http", lan, port);
  }

  if (access.publicUrl) {
    urls.tailscaleDns = access.publicUrl;
    urls.tailscale = access.publicUrl;
    urls.remote = access.publicUrl;
    urls.public = access.publicUrl;
    if (access.isPublic) urls.wan = access.publicUrl;
  } else if (dns) {
    const legacy = urlWithPort("http", dns, port);
    urls.tailscaleDns = legacy;
    urls.remote = legacy;
  }
  if (ts && !urls.tailscale) urls.tailscale = access.publicUrl || urlWithPort("http", ts, port);

  if (tunnel && tunnel.url) {
    urls.tunnel = tunnel.url;
    if (/^cloudflare/.test(tunnel.provider || "")) urls.cloudflare = tunnel.url;
    if (access.isPublic) {
      urls.wanFallback = tunnel.url;
    } else if (!access.active) {
      urls.public = tunnel.url;
      urls.remote = tunnel.url;
      urls.wan = tunnel.url;
    } else {
      urls.wan = tunnel.url;
      urls.wanFallback = tunnel.url;
    }
  }

  if (brand) {
    urls.domain = brand;
    urls.canonical = brand;
  }
  if (!urls.canonical) urls.canonical = urls.public || urls.remote || urls.lan || urls.local;
  urls.legacyPort = port;
  return {
    lan, tailscale: ts, tailscaleDns: dns, urls,
    serve: access.serve.serve, funnel: access.funnel.funnel,
    serveEnableUrl: access.serveEnableUrl, funnelEnableUrl: access.funnelEnableUrl,
    lanPort80: lan80, tunnel: tunnel || null, brandDomain: brand || null,
  };
}

let CFG = { port: 3000, playlistCacheMinutes: 10, epgCacheMinutes: 60, playlists: [], epgUrl: "", tmdbKey: "", opensubtitlesKey: "", publicDomain: "" };
try {
  const raw = fs.readFileSync(path.join(__dirname, "config.json"), "utf8");
  CFG = { ...CFG, ...JSON.parse(raw) };
  console.log("[config] Loaded config.json");
} catch (e) {
  console.log("[config] No config.json or parse error — using defaults. Copy config.example.json to config.json to customize.");
  if (e.code !== "ENOENT") console.log("[config] Error:", e.message);
}

const PORT = process.env.PORT || CFG.port || 3000;
const USER = process.env.BACK_USER || "";
const PASS = process.env.BACK_PASS || "";
const TMDB_KEY = process.env.TMDB_KEY || CFG.tmdbKey || "";
const TMDB_V4 = /\./.test(TMDB_KEY) && TMDB_KEY.length > 60;
const OS_KEY = process.env.OPENSUBTITLES_KEY || CFG.opensubtitlesKey || "";

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

if (compression) {
  // Skip the HLS proxy path — video traffic must stream raw and would be
  // pointlessly re-compressed. Static assets, JSON APIs and playlists all
  // benefit hugely (JS/HTML/JSON typically shrink ~70%).
  app.use(compression({
    threshold: 1024,
    filter: (req, res) => {
      if (req.path.startsWith("/api/stream")) return false;
      return compression.filter(req, res);
    },
  }));
}

if (USER && PASS) {
  app.use((req, res, next) => {
    const h = req.headers.authorization || "";
    const [type, enc] = h.split(" ");
    if (type === "Basic" && enc) {
      const decoded = Buffer.from(enc, "base64").toString();
      const sep = decoded.indexOf(":");
      const u = sep >= 0 ? decoded.slice(0, sep) : decoded;
      const p = sep >= 0 ? decoded.slice(sep + 1) : "";
      if (u === USER && p === PASS) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="BACK"');
    return res.status(401).send("Authentication required");
  });
  console.log("[auth]   Password protection ENABLED");
}

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const allowed = isAllowedOrigin(origin);
  const allowedOrigin = allowed ? (origin || "*") : "";
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, Authorization, X-Back-Session");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, X-Cache");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    // HTML: revalidate every load so a redeploy is picked up.
    if (ext === ".html" || ext === ".htm") {
      res.setHeader("Cache-Control", "no-cache");
      return;
    }
    // Immutable buckets (versioned/content-addressed) — safe to cache long.
    if (filePath.includes(`${path.sep}js${path.sep}`) ||
        filePath.includes(`${path.sep}brand${path.sep}`) ||
        filePath.includes(`${path.sep}design${path.sep}`) ||
        ext === ".svg" || ext === ".woff" || ext === ".woff2" || ext === ".ico") {
      res.setHeader("Cache-Control", "public, max-age=2592000, immutable"); // 30d
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=3600");
  },
}));

function proxyBase(req) {
  const rawProto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const proto = rawProto === "https" ? "https" : "http";
  const rawHost = (req.headers["x-forwarded-host"] || req.get("host") || "localhost").split(",")[0].trim();
  const host = /^[a-zA-Z0-9._:\[\]-]+$/.test(rawHost) ? rawHost : "localhost";
  return proto + "://" + host;
}

function maybeGunzip(buf) {
  if (buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return zlib.gunzipSync(buf); } catch { return buf; }
  }
  return buf;
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 45000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 45000 });
const manifestCache = new Map();

function doGet(url, headers, onResponse, onError, redirects = 0, timeoutMs = 20000) {
  let parsed;
  try { parsed = new URL(url); } catch { return onError(new Error("Invalid URL")); }
  const client = parsed.protocol === "https:" ? https : http;
  const r = client.get(url, {
    headers: { "User-Agent": "BACK-Player/1.1", Accept: "*/*", Connection: "keep-alive", ...headers },
    agent: parsed.protocol === "https:" ? httpsAgent : httpAgent,
    timeout: timeoutMs,
  }, (up) => {
    if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location && redirects < 5) {
      up.resume();
      const next = new URL(up.headers.location, url).toString();
      return doGet(next, headers, onResponse, onError, redirects + 1, timeoutMs);
    }
    onResponse(up, url);
  });
  r.on("error", onError);
  r.on("timeout", () => { r.destroy(); onError(new Error("Upstream timeout")); });
}

function fetchBuffer(url, headers, timeoutMs) {
  return new Promise((res, rej) => {
    doGet(url, headers || {}, (up) => {
      if (up.statusCode >= 400) { up.resume(); return rej(new Error("Upstream " + up.statusCode)); }
      const chunks = [];
      up.on("data", c => chunks.push(c));
      up.on("end", () => res({ buf: maybeGunzip(Buffer.concat(chunks)), headers: up.headers }));
      up.on("error", rej);
    }, rej, 0, timeoutMs || 20000);
  });
}

function fetchBufferDeadline(url, headers, maxMs) {
  maxMs = maxMs || 90000;
  let timer;
  const work = fetchBuffer(url, headers, Math.min(maxMs, 30000));
  const deadline = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error("Playlist timeout after " + Math.round(maxMs / 1000) + "s")), maxMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function isHls(url, ct) {
  if (url.split("?")[0].toLowerCase().endsWith(".m3u8")) return true;
  return (ct || "").toLowerCase().includes("mpegurl");
}

function resolveUrl(base, ref) {
  try { return new URL(ref, base).toString(); } catch { return ref; }
}

function rewriteM3U8(body, baseUrl, pBase) {
  return body.split("\n").map(line => {
    const t = line.trim();
    if (t === "") return line;
    if (t.startsWith("#")) {
      if (t.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_m, u) => {
          const abs = resolveUrl(baseUrl, u);
          return 'URI="' + pBase + "/api/stream?url=" + encodeURIComponent(abs) + '"';
        });
      }
      return line;
    }
    const abs = resolveUrl(baseUrl, t);
    return pBase + "/api/stream?url=" + encodeURIComponent(abs);
  }).join("\n");
}

function xmltvDate(str) {
  if (!str) return null;
  const m = str.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{2})(\d{2}))?/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, zh, zm] = m;
  const tz = zh ? `${zh}:${zm}` : "Z";
  const d = new Date(`${Y}-${Mo}-${D}T${H}:${Mi}:${S}${tz}`).getTime();
  return isNaN(d) ? null : d;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n));
}

function parseXMLTV(xml) {
  const map = new Map();
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1], inner = m[2];
    const ch = (attrs.match(/channel="([^"]+)"/) || [])[1];
    const start = (attrs.match(/start="([^"]+)"/) || [])[1];
    const stop = (attrs.match(/stop="([^"]+)"/) || [])[1];
    if (!ch || !start) continue;
    const parsedStart = xmltvDate(start);
    if (!parsedStart) continue;
    const parsedStop = stop ? xmltvDate(stop) : null;
    const title = decodeXml(((inner.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || "").trim());
    const category = decodeXml(((inner.match(/<category[^>]*>([\s\S]*?)<\/category>/) || [])[1] || "").trim());
    const desc = decodeXml(((inner.match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1] || "").trim());
    const iconMatch = inner.match(/<icon\s+src="([^"]+)"/);
    const ratingMatch = inner.match(/<rating[^>]*>[\s\S]*?<value>([\s\S]*?)<\/value>[\s\S]*?<\/rating>/);
    if (!map.has(ch)) map.set(ch, []);
    map.get(ch).push({ start: parsedStart, stop: parsedStop, title, category, desc, icon: iconMatch ? iconMatch[1] : "", rating: ratingMatch ? ratingMatch[1].trim() : "" });
  }
  for (const arr of map.values()) arr.sort((a, b) => a.start - b.start);
  return map;
}

const plCache = new Map();
const plLibCache = new Map();
const epgCache = new Map();
const metaCache = new Map();
const dvrSchedule = new Map(); // id -> { item, channel, start, stop, recurring }

// ─── Cache eviction: prune expired entries every 5 minutes ───
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of epgCache) { if (v.exp <= now) epgCache.delete(k); }
  for (const [k, v] of plCache) { if (v.exp <= now) plCache.delete(k); }
  for (const [k, v] of plLibCache) { if (v.exp <= now) plLibCache.delete(k); }
  for (const [k, v] of metaCache) { if (v.exp <= now) metaCache.delete(k); }
  for (const [k, v] of dvrSchedule) { if (v.stop < now - 86400000) dvrSchedule.delete(k); }
  // Hard cap cache sizes as safety net
  const cap = (m, max) => { if (m.size > max) { const keys = [...m.keys()]; for (let i = 0; i < m.size - max; i++) m.delete(keys[i]); } };
  cap(plCache, 20);
  cap(plLibCache, 10);
  cap(epgCache, 20);
  cap(metaCache, 500);
  cap(dvrSchedule, 200);
  cap(manifestCache, 80);
  cap(subCache, 200);
}, 300000);

function fmtVotes(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

function tmdbGet(pathq) {
  const sep = pathq.includes("?") ? "&" : "?";
  const url = "https://api.themoviedb.org/3" + pathq + (TMDB_V4 ? "" : sep + "api_key=" + encodeURIComponent(TMDB_KEY));
  const headers = TMDB_V4 ? { Authorization: "Bearer " + TMDB_KEY, Accept: "application/json" } : { Accept: "application/json" };
  return fetchBuffer(url, headers).then(r => JSON.parse(r.buf.toString("utf8")));
}

function cleanMetaTitle(title) {
  return (title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:MULTI|SUB|DUB|HD|FHD|4K|SD|UHD|HEVC|x264|x265)[^)]*\)/gi, " ")
    .replace(/\b(?:SE|DK|NO|FI|EN|SV|MULTI)\s*[|:]\s*/gi, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s*[-–—|:]+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSim(a, b) {
  const x = normName(cleanMetaTitle(a));
  const y = normName(cleanMetaTitle(b));
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.82;
  const ax = new Set(x.split(" "));
  const by = new Set(y.split(" "));
  let hit = 0;
  for (const w of ax) if (by.has(w) && w.length > 2) hit++;
  return hit / Math.max(ax.size, by.size, 1);
}

function pickTmdbResult(results, title, year, tv) {
  let best = null, bestScore = -1;
  for (const r of results || []) {
    let score = titleSim(title, r.title || r.name || "");
    const ry = ((tv ? r.first_air_date : r.release_date) || "").slice(0, 4);
    if (year && ry && String(year) === ry) score += 0.35;
    if (r.popularity) score += Math.min(r.popularity / 200, 0.15);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore >= 0.45 ? best : (results || [])[0] || null;
}

async function wikiMeta(title) {
  const clean = cleanMetaTitle(title);
  if (!clean) return null;
  for (const lang of ["sv", "en"]) {
    try {
      const url = "https://" + lang + ".wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(clean);
      const { buf } = await fetchBuffer(url, { Accept: "application/json" });
      const d = JSON.parse(buf.toString("utf8"));
      if (d.type === "disambiguation" || d.type === "https") continue;
      const thumb = d.thumbnail && d.thumbnail.source ? d.thumbnail.source.replace(/\/\d+px-/, "/500px-") : null;
      if (d.extract || thumb) return { overview: d.extract || "", poster: thumb, source: "wikipedia", lang };
    } catch { /* try next lang */ }
  }
  return null;
}

async function lookupMeta(type, title, year, logo) {
  const tv = type === "series";
  const clean = cleanMetaTitle(title) || title;
  const q = encodeURIComponent(clean);
  const s = await tmdbGet(tv
    ? "/search/tv?query=" + q + (year ? "&first_air_date_year=" + year : "") + "&include_adult=false"
    : "/search/movie?query=" + q + (year ? "&year=" + year : "") + "&include_adult=false");
  const first = pickTmdbResult(s.results, clean, year, tv);
  if (!first) {
    const wiki = await wikiMeta(clean);
    if (wiki) return { found: true, title: clean, year: year || "", overview: wiki.overview, poster: wiki.poster || logo || null, backdrop: null, trailer: null, genres: [], cast: [], rating: null, votes: "", runtime: "", cert: "", source: wiki.source };
    if (logo) return { found: true, title: clean, year: year || "", overview: "", poster: logo, backdrop: null, trailer: null, genres: [], cast: [], rating: null, votes: "", runtime: "", cert: "", source: "playlist" };
    return { found: false };
  }
  const d = await tmdbGet(tv
    ? "/tv/" + first.id + "?append_to_response=videos,credits,content_ratings,external_ids"
    : "/movie/" + first.id + "?append_to_response=videos,credits,release_dates,external_ids");
  const vids = (d.videos && d.videos.results) || [];
  const yt = vids.filter(v => v.site === "YouTube");
  const pick = yt.find(v => v.type === "Trailer" && v.official) || yt.find(v => v.type === "Trailer") || yt.find(v => v.type === "Teaser") || yt[0];
  let cert = "";
  if (tv) {
    const us = ((d.content_ratings && d.content_ratings.results) || []).find(x => x.iso_3166_1 === "US");
    cert = us ? us.rating : "";
  } else {
    const us = ((d.release_dates && d.release_dates.results) || []).find(x => x.iso_3166_1 === "US");
    if (us) cert = ((us.release_dates || []).map(r => r.certification).filter(Boolean))[0] || "";
  }
  const rel = (tv ? d.first_air_date : d.release_date) || "";
  const runtime = tv
    ? ((d.episode_run_time && d.episode_run_time[0]) ? d.episode_run_time[0] + "m" : "")
    : (d.runtime ? Math.floor(d.runtime / 60) + "h " + (d.runtime % 60) + "m" : "");
  let overview = d.overview || "";
  if (!overview) {
    const wiki = await wikiMeta(clean);
    if (wiki && wiki.overview) overview = wiki.overview;
  }
  const imdbRaw = d.external_ids && d.external_ids.imdb_id;
  return {
    found: true, source: "tmdb", tmdbId: d.id, imdbId: imdbRaw ? ("tt" + imdbRaw) : null, title: d.title || d.name || title,
    year: rel.slice(0, 4),
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    votes: d.vote_count ? fmtVotes(d.vote_count) : "",
    runtime, cert,
    genres: (d.genres || []).map(g => g.name).slice(0, 4),
    overview,
    cast: ((d.credits && d.credits.cast) || []).slice(0, 6).map(c => c.name),
    backdrop: d.backdrop_path ? "https://image.tmdb.org/t/p/w1280" + d.backdrop_path : null,
    poster: d.poster_path ? "https://image.tmdb.org/t/p/w500" + d.poster_path : (logo || null),
    trailer: pick ? pick.key : null,
  };
}

function normName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9\u00e5\u00e4\u00f6 ]/gi, "").replace(/\s+/g, " ").trim();
}

function stripChannelName(name) {
  return normName((name || "")
    .replace(/^(SE|DK|VIP\s+DK|VIP\s+SE)\s*[:|]\s*/i, "")
    .replace(/\s*\[[^\]]*\]/gi, "")
    .replace(/\b(HD|FHD|UHD|4K|SD|HEVC|MULTI)\b/gi, "")
    .trim());
}

function channelSim(a, b) {
  const x = stripChannelName(a);
  const y = stripChannelName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const xc = x.replace(/\s+/g, "");
  const yc = y.replace(/\s+/g, "");
  if (xc && yc && xc === yc) return 0.95;
  if (x.includes(y) || y.includes(x)) return 0.88;
  if (xc.includes(yc) || yc.includes(xc)) return 0.85;
  const ax = new Set(x.split(" ").filter(w => w.length > 1));
  const by = new Set(y.split(" ").filter(w => w.length > 1));
  let hit = 0;
  for (const w of ax) if (by.has(w)) hit++;
  return hit / Math.max(ax.size, by.size, 1);
}

function epgCandidates(chNames, parsed) {
  const out = [];
  const seen = new Set();
  for (const [id, names] of chNames) {
    if (!parsed.has(id)) continue;
    for (const nm of names) {
      const norm = stripChannelName(nm);
      const key = id + "|" + norm;
      if (!norm || seen.has(key)) continue;
      seen.add(key);
      out.push({ id, name: nm, norm });
    }
  }
  return out;
}

function autoMatchChannel(ch, candidates, parsed, overrides) {
  const oid = ch.id || ch.name;
  if (overrides && overrides[oid]) {
    const key = overrides[oid];
    return { channelId: oid, epgKey: key, epgId: key.startsWith("name:") ? null : key, confidence: 1, source: "override", matchedName: ch.name };
  }
  if (ch.tvgId && parsed.has(ch.tvgId)) {
    return { channelId: oid, epgKey: ch.tvgId, epgId: ch.tvgId, confidence: 1, source: "tvg-id", matchedName: ch.name };
  }
  const want = stripChannelName(ch.name);
  if (!want) return { channelId: oid, epgKey: null, confidence: 0, source: "none", matchedName: ch.name };
  let best = null, bestScore = 0;
  for (const c of candidates) {
    let score = channelSim(ch.name, c.name);
    if (ch.tvgId && c.id === ch.tvgId) score = Math.max(score, 0.95);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (best && bestScore >= 0.55) {
    const epgKey = best.id;
    return { channelId: oid, epgKey, epgId: best.id, confidence: Math.round(bestScore * 100) / 100, source: "auto", matchedName: best.name };
  }
  const nameKey = "name:" + want;
  for (const c of candidates) {
    if (c.norm === want) {
      return { channelId: oid, epgKey: c.id, epgId: c.id, confidence: 0.9, source: "name", matchedName: c.name };
    }
  }
  return { channelId: oid, epgKey: null, confidence: 0, source: "none", matchedName: ch.name };
}

function autoMatchEpg(channels, chNames, parsed, overrides) {
  const candidates = epgCandidates(chNames, parsed);
  const matches = {};
  const unmatched = [];
  let matched = 0;
  for (const ch of channels) {
    const m = autoMatchChannel(ch, candidates, parsed, overrides);
    if (m.epgKey) {
      matches[ch.id || ch.name] = m;
      matched++;
    } else unmatched.push(m);
  }
  const total = channels.length || 1;
  return { matches, unmatched, stats: { total: channels.length, matched, accuracy: Math.round((matched / total) * 1000) / 10 } };
}

// ─── Accounts & single-session auth ───
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
const SESSION_TTL_MS = 3 * 60 * 1000;
const TAKEOVER_TTL_MS = 2 * 60 * 1000;
const MAX_ACCOUNTS = 8;
const AVATAR_COLORS = ["#00E5FF", "#7C3AED", "#E50914", "#10B981", "#F59E0B", "#EC4899"];

let authStore = null;

function loadAuthStore() {
  if (authStore) return authStore;
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, "utf8");
    authStore = JSON.parse(raw);
  } catch {
    authStore = { accounts: [], session: null, takeoverResults: {} };
  }
  if (!Array.isArray(authStore.accounts)) authStore.accounts = [];
  if (!authStore.takeoverResults || typeof authStore.takeoverResults !== "object") authStore.takeoverResults = {};
  return authStore;
}

function saveAuthStore() {
  try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(authStore, null, 2), "utf8"); } catch (e) { console.log("[auth]", e.message); }
}

function hashPin(pin, salt) {
  return crypto.createHash("sha256").update(salt + ":" + String(pin)).digest("hex");
}

function verifyPin(account, pin) {
  if (!account || !account.pinHash || !account.pinSalt) return false;
  return hashPin(pin, account.pinSalt) === account.pinHash;
}

function genToken() {
  return crypto.randomBytes(24).toString("hex");
}

function genAccountId() {
  return "u" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
}

function publicAccount(a) {
  return { id: a.id, name: a.name, avatar: a.avatar || AVATAR_COLORS[0] };
}

function normalizePin(pin) {
  const p = String(pin || "").replace(/\D/g, "");
  return p.length >= 4 && p.length <= 6 ? p : null;
}

function normalizeAvatar(avatar) {
  const a = (avatar || "").trim();
  return AVATAR_COLORS.includes(a) ? a : AVATAR_COLORS[0];
}

function sessionExpired(sess) {
  return !sess || Date.now() - (sess.lastSeen || 0) > SESSION_TTL_MS;
}

function pruneExpiredSession() {
  const store = loadAuthStore();
  if (store.session && sessionExpired(store.session)) {
    store.session = null;
    saveAuthStore();
  }
}

function activeSessionInfo() {
  pruneExpiredSession();
  const sess = loadAuthStore().session;
  if (!sess) return null;
  return { accountId: sess.accountId, name: sess.accountName, avatar: sess.avatar };
}

function getSessionFromReq(req) {
  const token = (req.headers["x-back-session"] || "").trim();
  if (!token) return null;
  pruneExpiredSession();
  const store = loadAuthStore();
  const sess = store.session;
  if (!sess || sess.token !== token) return null;
  sess.lastSeen = Date.now();
  saveAuthStore();
  return sess;
}

function findAccount(id) {
  return loadAuthStore().accounts.find(a => a.id === id) || null;
}

function createSession(account) {
  const store = loadAuthStore();
  store.session = {
    token: genToken(),
    accountId: account.id,
    accountName: account.name,
    avatar: account.avatar,
    lastSeen: Date.now(),
    takeoverRequest: null,
  };
  saveAuthStore();
  return store.session;
}

function pruneTakeoverResults() {
  const store = loadAuthStore();
  const now = Date.now();
  for (const [k, v] of Object.entries(store.takeoverResults || {})) {
    if (!v || now - (v.at || 0) > TAKEOVER_TTL_MS) delete store.takeoverResults[k];
  }
}

const PROFILE_FILE = path.join(__dirname, "profile-sync.json");
function loadProfileStore() {
  try {
    const raw = fs.readFileSync(PROFILE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function saveProfileStore(data) {
  try { fs.writeFileSync(PROFILE_FILE, JSON.stringify(data, null, 2), "utf8"); } catch (e) { console.log("[profile]", e.message); }
}

function parseXMLTVChannels(xml) {
  const m = new Map();
  const re = /<channel\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
  let x;
  while ((x = re.exec(xml))) {
    const id = x[1], names = [];
    const nr = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
    let n;
    while ((n = nr.exec(x[2]))) { const nm = decodeXml(n[1].trim()); if (nm) names.push(nm); }
    m.set(id, names);
  }
  return m;
}

async function getEpg(url) {
  const now = Date.now();
  const hit = epgCache.get(url);
  if (hit && hit.exp > now) return hit;
  const { buf } = await fetchBuffer(url, { Accept: "*/*" });
  const xml = buf.toString("utf8");
  const parsed = parseXMLTV(xml);
  const chNames = parseXMLTVChannels(xml);
  const entry = { parsed, chNames, exp: now + (CFG.epgCacheMinutes || 60) * 60000 };
  epgCache.set(url, entry);
  console.log("[epg]    Parsed " + parsed.size + " programme channels, " + chNames.size + " channel names");
  return entry;
}

// ─── API ───

app.get("/api/health", (_req, res) => {
  const net = cachedNetworkUrls(PORT);
  res.json({
    status: "ok",
    server: "BACK-Proxy",
    version: "3.2.0",
    port: PORT,
    features: ["hls-rewrite", "range", "cache", "epg", "epg-auto-match", "config", "auth", "tmdb", "xtream", "multi-playlist", "subtitles", "cast", "chromecast", "vpn-check", "tailscale", "tailscale-serve", "profile-sync", "recommend", "dvr"],
    tmdb: !!TMDB_KEY,
    subtitles: true,
    xtream: true,
    network: {
      lan: net.lan, tailscale: net.tailscale, tailscaleDns: net.tailscaleDns,
      serve: net.serve, funnel: net.funnel, lanPort80: net.lanPort80,
      serveEnableUrl: net.serveEnableUrl || null,
      funnelEnableUrl: net.funnelEnableUrl || null,
      brandDomain: net.brandDomain || null,
      tunnel: net.tunnel ? { provider: net.tunnel.provider, url: net.tunnel.url, domain: net.tunnel.domain || null } : null,
    },
    urls: net.urls,
  });
});

// Mullvad VPN connection check (proxies official am.i.mullvad.net for clients blocked by CORS)
app.get("/api/vpn/mullvad", async (_req, res) => {
  try {
    const { buf } = await fetchBuffer("https://am.i.mullvad.net/json", { Accept: "application/json", "User-Agent": "BACK-Proxy v3.1" });
    const data = JSON.parse(buf.toString("utf8"));
    const connected = !!(data.mullvad_exit_ip || data.mullvad_server_type);
    res.json({
      connected,
      ip: data.ip || null,
      country: data.country || null,
      city: data.city || null,
      server: data.mullvad_exit_ip_hostname || data.mullvad_server_type || null,
      organization: data.organization || null,
      provider: "mullvad",
    });
  } catch (e) {
    res.status(502).json({ connected: false, error: e.message, provider: "mullvad" });
  }
});

app.get("/api/config", (_req, res) => {
  res.json({
    playlists: (CFG.playlists || []).map(p => ({ name: p.name, url: p.url, epg: p.epg || "" })),
    epgUrl: CFG.epgUrl || "",
    auth: !!(USER && PASS),
    tmdb: !!TMDB_KEY,
  });
});

// Fetch M3U playlist (cached, supports multiple playlists via ?name=)
app.get("/api/playlist", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });
  const now = Date.now();
  const hit = plCache.get(url);
  if (hit && hit.exp > now) {
    res.setHeader("Content-Type", "audio/x-mpegurl");
    res.setHeader("X-Cache", "HIT");
    return res.end(hit.body);
  }
  try {
    console.log("[playlist]", url.substring(0, 80));
    const { buf } = await fetchBufferDeadline(url, { Accept: "*/*" }, 90000);
    const body = buf.toString("utf8");
    plCache.set(url, { body, exp: now + (CFG.playlistCacheMinutes || 10) * 60000 });
    res.setHeader("Content-Type", "audio/x-mpegurl");
    res.setHeader("X-Cache", "MISS");
    res.end(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Fetch + parse M3U into library JSON (offloads heavy work from mobile browsers)
app.get("/api/playlist/library", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });
  const now = Date.now();
  const ttl = (CFG.playlistCacheMinutes || 10) * 60000;
  const hit = plLibCache.get(url);
  if (hit && hit.exp > now) {
    res.setHeader("X-Cache", "HIT");
    return res.json(hit.data);
  }
  try {
    let body = "";
    const rawHit = plCache.get(url);
    if (rawHit && rawHit.exp > now) {
      body = rawHit.body;
      res.setHeader("X-Cache", "RAW-HIT");
    } else {
      console.log("[playlist/library]", url.substring(0, 80));
      const { buf } = await fetchBufferDeadline(url, { Accept: "*/*" }, 90000);
      body = buf.toString("utf8");
      plCache.set(url, { body, exp: now + ttl });
      res.setHeader("X-Cache", "MISS");
    }
    const library = buildLibraryFromM3U(body);
    const data = { library, counts: library.counts };
    plLibCache.set(url, { data, exp: now + ttl });
    res.json(data);
  } catch (e) {
    console.log("[playlist/library] error:", e.message);
    res.status(502).json({ error: e.message });
  }
});

// Xtream Codes API login + playlist fetch
app.post("/api/xtream/connect", async (req, res) => {
  const { server, username, password } = req.body || {};
  if (!server || !username || !password) return res.status(400).json({ error: "Missing server, username, or password" });
  try {
    const base = server.replace(/\/+$/, "") + "/player_api.php";
    const testUrl = base + "?username=" + encodeURIComponent(username) + "&password=" + encodeURIComponent(password) + "&action=user";
    const { buf } = await fetchBuffer(testUrl);
    const data = JSON.parse(buf.toString("utf8"));
    if (!data || data.user_info === undefined) return res.status(502).json({ error: "Invalid credentials or server" });
    // Fetch live categories
    const catUrl = base + "?username=" + encodeURIComponent(username) + "&password=" + encodeURIComponent(password) + "&action=get_live_categories";
    const catBuf = await fetchBuffer(catUrl);
    const cats = JSON.parse(catBuf.buf.toString("utf8"));
    res.json({
      authenticated: true,
      username: data.user_info.username || username,
      auth: data.user_info.auth || 1,
      expDate: data.user_info.exp_date,
      isTrial: !!data.user_info.is_trial,
      maxConnections: data.user_info.max_connections,
      liveCategories: (cats || []).map(c => ({ id: c.category_id, name: c.category_name })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Xtream: fetch live channels
app.get("/api/xtream/live", async (req, res) => {
  const { server, username, password, category_id } = req.query;
  if (!server || !username || !password) return res.status(400).json({ error: "Missing parameters" });
  try {
    const base = server.replace(/\/+$/, "") + "/player_api.php";
    let url = base + "?username=" + encodeURIComponent(username) + "&password=" + encodeURIComponent(password) + "&action=get_live_streams";
    if (category_id) url += "&category_id=" + encodeURIComponent(category_id);
    const { buf } = await fetchBuffer(url);
    res.json(JSON.parse(buf.toString("utf8")));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Xtream: fetch VOD
app.get("/api/xtream/vod", async (req, res) => {
  const { server, username, password, category_id } = req.query;
  if (!server || !username || !password) return res.status(400).json({ error: "Missing parameters" });
  try {
    const base = server.replace(/\/+$/, "") + "/player_api.php";
    let url = base + "?username=" + encodeURIComponent(username) + "&password=" + encodeURIComponent(password) + "&action=get_vod_streams";
    if (category_id) url += "&category_id=" + encodeURIComponent(category_id);
    const { buf } = await fetchBuffer(url);
    res.json(JSON.parse(buf.toString("utf8")));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Xtream: fetch series
app.get("/api/xtream/series", async (req, res) => {
  const { server, username, password, category_id } = req.query;
  if (!server || !username || !password) return res.status(400).json({ error: "Missing parameters" });
  try {
    const base = server.replace(/\/+$/, "") + "/player_api.php";
    let url = base + "?username=" + encodeURIComponent(username) + "&password=" + encodeURIComponent(password) + "&action=get_series";
    if (category_id) url += "&category_id=" + encodeURIComponent(category_id);
    const { buf } = await fetchBuffer(url);
    res.json(JSON.parse(buf.toString("utf8")));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Warm upstream TCP/TLS for faster channel zap (client prefetch)
app.head("/api/stream/warm", (req, res) => {
  const src = req.query.url;
  if (!src || !isAllowedStreamUrl(src)) return res.sendStatus(400);
  let done = false;
  const finish = (code) => {
    if (done || res.headersSent) return;
    done = true;
    res.setHeader("X-Warm", "1");
    res.sendStatus(code);
  };
  doGet(src, { Accept: "*/*", Range: "bytes=0-1" }, (up) => {
    up.resume();
    up.on("error", () => {});
    finish(up.statusCode >= 400 ? 502 : 204);
  }, () => finish(204), 0, 8000);
});

// Proxy stream — handles Range + HLS rewrite
app.get("/api/stream", (req, res) => {
  const src = req.query.url;
  if (!src) return res.status(400).json({ error: "Missing ?url=" });
  if (!isAllowedStreamUrl(src)) return res.status(400).json({ error: "Invalid or blocked stream URL" });
  const isManifest = src.split("?")[0].toLowerCase().endsWith(".m3u8");
  const headers = { Accept: "*/*" };
  if (req.headers.range && !isManifest) headers.Range = req.headers.range;
  if (res.socket) { try { res.socket.setNoDelay(true); res.socket.setKeepAlive(true, 15000); } catch (e) {} }
  if (typeof res.setTimeout === "function") res.setTimeout(0);
  const upTimeout = isManifest ? 12000 : 60000;
  const pBase = proxyBase(req);
  if (isManifest) {
    const hit = manifestCache.get(src);
    if (hit && hit.exp > Date.now()) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, max-age=1");
      res.setHeader("X-Cache", "HIT");
      return res.end(hit.body);
    }
  }
  doGet(src, headers, (up, finalUrl) => {
    if (up.statusCode >= 400) { up.resume(); return res.status(up.statusCode).json({ error: "Upstream " + up.statusCode }); }
    const ct = up.headers["content-type"] || "";
    if (isHls(finalUrl, ct)) {
      const chunks = [];
      up.on("data", c => chunks.push(c));
      up.on("end", () => {
        const body = maybeGunzip(Buffer.concat(chunks)).toString("utf8");
        const rewritten = rewriteM3U8(body, finalUrl, pBase);
        manifestCache.set(src, { body: rewritten, exp: Date.now() + 1500 });
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "no-cache, max-age=1");
        res.end(rewritten);
      });
      up.on("error", () => { if (!res.headersSent) res.status(502).end(); });
    } else {
      res.status(up.statusCode);
      res.setHeader("X-Accel-Buffering", "no");
      ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"].forEach(h => {
        if (up.headers[h]) res.setHeader(h, up.headers[h]);
      });
      if (!up.headers["content-type"]) res.setHeader("Content-Type", "application/octet-stream");
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      up.pipe(res);
      up.on("error", () => { res.destroy(); });
      req.on("close", () => up.destroy());
    }
  }, (err) => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }, 0, upTimeout);
});

// EPG now/next
app.get("/api/epg/now", async (req, res) => {
  const url = req.query.url || CFG.epgUrl;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });
  try {
    const { parsed: map, chNames } = await getEpg(url);
    const now = Date.now();
    const out = {};
    for (const [ch, arr] of map) {
      let cur = null, next = null;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].start <= now && (!arr[i].stop || arr[i].stop > now)) { cur = arr[i]; next = arr[i + 1] || null; break; }
        if (arr[i].start > now) { next = arr[i]; break; }
      }
      if (cur || next) out[ch] = {
        now: cur ? { title: cur.title, start: cur.start, stop: cur.stop, category: cur.category, desc: cur.desc } : null,
        next: next ? { title: next.title, start: next.start, stop: next.stop, category: next.category, desc: next.desc } : null,
      };
    }
    // Also key by normalized display-name so channels without tvg-id can match by name
    for (const [id, names] of chNames) {
      if (!out[id]) continue;
      for (const nm of names) {
        const k = "name:" + normName(nm);
        if (k !== "name:" && !out[k]) out[k] = out[id];
      }
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

function resolveEpgChannel(map, chNames, ch) {
  let arr = map.get(ch);
  if (!arr && ch && ch.indexOf("name:") === 0) {
    const want = ch.slice(5);
    for (const [id, names] of chNames) {
      if (names.some(nm => normName(nm) === want)) { arr = map.get(id); break; }
    }
  }
  return arr || [];
}

function scheduleForChannel(arr, opts = {}) {
  const now = Date.now();
  const pastMs = (opts.pastHours || 6) * 3600000;
  const futureMs = (opts.futureHours || 24) * 3600000;
  const limit = opts.limit || 48;
  return (arr || [])
    .filter(p => p.start >= now - pastMs && p.start <= now + futureMs)
    .slice(0, limit)
    .map(p => ({ title: p.title, start: p.start, stop: p.stop, category: p.category, desc: p.desc }));
}

// EPG full schedule for one channel
app.get("/api/epg/schedule", async (req, res) => {
  const url = req.query.url || CFG.epgUrl;
  const ch = req.query.channel;
  if (!url || !ch) return res.status(400).json({ error: "Missing ?url= and ?channel=" });
  try {
    const { parsed: map, chNames } = await getEpg(url);
    const arr = resolveEpgChannel(map, chNames, ch);
    res.json(scheduleForChannel(arr, {
      pastHours: +(req.query.pastHours || 12),
      futureHours: +(req.query.futureHours || 24),
      limit: +(req.query.limit || 48),
    }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// EPG bulk schedule for TV guide grid (up to 80 channels per request)
app.get("/api/epg/bulk", async (req, res) => {
  const url = req.query.url || CFG.epgUrl;
  const raw = (req.query.channels || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 80);
  if (!url || !raw.length) return res.status(400).json({ error: "Missing ?url= and ?channels=" });
  try {
    const { parsed: map, chNames } = await getEpg(url);
    const out = {};
    for (const ch of raw) {
      const arr = resolveEpgChannel(map, chNames, ch);
      out[ch] = scheduleForChannel(arr, { pastHours: 8, futureHours: 18, limit: 32 });
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// EPG programme search across all channels
app.get("/api/epg/search", async (req, res) => {
  const url = req.query.url || CFG.epgUrl;
  const q = (req.query.q || "").toLowerCase().trim();
  if (!url || !q) return res.status(400).json({ error: "Missing ?url= and ?q=" });
  try {
    const { parsed: map } = await getEpg(url);
    const now = Date.now();
    const results = [];
    for (const [ch, arr] of map) {
      for (const p of arr) {
        if (p.start > now + 86400000 * 7) continue; // only next 7 days
        if (p.title.toLowerCase().includes(q) || (p.category && p.category.toLowerCase().includes(q))) {
          results.push({ channel: ch, title: p.title, start: p.start, stop: p.stop, category: p.category, desc: p.desc });
          if (results.length >= 100) break;
        }
      }
      if (results.length >= 100) break;
    }
    res.json(results);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── Subtitle search (OpenSubtitles + Wyzie fallback) ───
const subCache = new Map();

function srtToVtt(srt) {
  const lines = srt.replace(/\r/g, "").split("\n");
  let out = "WEBVTT\n\n";
  let i = 0;
  while (i < lines.length) {
    if (/^\d+$/.test(lines[i].trim())) { i++; continue; }
    const ts = lines[i];
    if (ts && ts.includes("-->")) {
      out += ts.replace(/,/g, ".") + "\n";
      i++;
      while (i < lines.length && lines[i].trim()) { out += lines[i] + "\n"; i++; }
      out += "\n";
    }
    i++;
  }
  return out;
}

async function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function searchOpenSubtitles({ title, year, season, episode, imdbId, langs }) {
  if (!OS_KEY) return [];
  const params = new URLSearchParams();
  if (imdbId) params.set("imdb_id", imdbId.replace(/^tt/, ""));
  else if (title) params.set("query", title);
  if (year) params.set("year", year);
  if (season) params.set("season_number", season);
  if (episode) params.set("episode_number", episode);
  params.set("languages", langs || "sv,en");
  const data = await fetchJson("https://api.opensubtitles.com/api/v1/subtitles?" + params, {
    "Api-Key": OS_KEY,
    "User-Agent": "BACK-Proxy v3.0",
    "Accept": "application/json",
  });
  return (data.data || []).slice(0, 8).map(s => ({
    id: String(s.id),
    lang: (s.attributes && s.attributes.language) || "und",
    name: (s.attributes && s.attributes.release) || title,
    source: "opensubtitles",
    download: s.links && s.links[0] && s.links[0].url,
  }));
}

async function searchWyzie({ title, imdbId, season, episode, langs }) {
  const want = (langs || "sv,en").split(",");
  let url = "https://sub.wyzie.ru/search?";
  if (imdbId) url += "id=" + encodeURIComponent(imdbId);
  else if (title) url += "query=" + encodeURIComponent(title);
  else return [];
  if (season) url += "&season=" + season;
  if (episode) url += "&episode=" + episode;
  const data = await fetchJson(url);
  const list = Array.isArray(data) ? data : (data.subtitles || data.results || []);
  return list.slice(0, 10).map((s, i) => ({
    id: "wyzie_" + i,
    lang: s.lang || s.language || "und",
    name: s.label || s.name || title,
    source: "wyzie",
    download: s.url || s.link,
  })).filter(s => want.some(l => s.lang === l || s.lang.startsWith(l)));
}

app.get("/api/subtitles/search", async (req, res) => {
  const title = (req.query.title || "").trim();
  const year = (req.query.year || "").trim();
  const season = (req.query.season || "").trim();
  const episode = (req.query.episode || "").trim();
  const imdbId = (req.query.imdb || req.query.imdbId || "").trim();
  const langs = (req.query.langs || "sv,en").trim();
  if (!title && !imdbId) return res.status(400).json({ error: "Missing ?title= or ?imdb=" });
  const key = [title, year, season, episode, imdbId, langs].join("|").toLowerCase();
  const now = Date.now();
  const hit = subCache.get(key);
  if (hit && hit.exp > now) { res.setHeader("X-Cache", "HIT"); return res.json(hit.data); }
  try {
    let results = [];
    if (OS_KEY) {
      try { results = await searchOpenSubtitles({ title, year, season, episode, imdbId, langs }); } catch (e) { console.log("[subs]   OpenSubtitles:", e.message); }
    }
    if (!results.length) {
      try { results = await searchWyzie({ title, imdbId, season, episode, langs }); } catch (e) { console.log("[subs]   Wyzie:", e.message); }
    }
    const data = { found: results.length > 0, results, opensubtitles: !!OS_KEY, query: { title, year, season, episode, imdbId, langs } };
    subCache.set(key, { data, exp: now + 3600000 });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message, found: false, results: [] });
  }
});

app.get("/api/subtitles/file", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });
  try {
    const { buf } = await fetchBuffer(url, { Accept: "*/*", "User-Agent": "BACK-Proxy v3.0" });
    let text = buf.toString("utf8");
    if (!/^WEBVTT/m.test(text) && /-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(text)) text = srtToVtt(text);
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// TMDB / Wikipedia / playlist-logo metadata
app.get("/api/meta", async (req, res) => {
  const type = req.query.type === "series" ? "series" : "movie";
  const title = (req.query.title || "").trim();
  const year = (req.query.year || "").trim();
  const logo = (req.query.logo || "").trim();
  if (!title) return res.status(400).json({ error: "Missing ?title=" });
  const key = type + "|" + cleanMetaTitle(title).toLowerCase() + "|" + year;
  const now = Date.now();
  const hit = metaCache.get(key);
  if (hit && hit.exp > now) { res.setHeader("X-Cache", "HIT"); return res.json(hit.data); }
  try {
    let data;
    if (TMDB_KEY) data = await lookupMeta(type, title, year, logo);
    else if (logo) {
      const wiki = await wikiMeta(cleanMetaTitle(title) || title);
      data = wiki
        ? { found: true, source: wiki.source, title, year, overview: wiki.overview, poster: wiki.poster || logo, backdrop: null, trailer: null, genres: [], cast: [], rating: null, votes: "", runtime: "", cert: "" }
        : { found: true, source: "playlist", title, year, overview: "", poster: logo, backdrop: null, trailer: null, genres: [], cast: [], rating: null, votes: "", runtime: "", cert: "" };
    } else {
      const wiki = await wikiMeta(cleanMetaTitle(title) || title);
      data = wiki ? { found: true, source: wiki.source, title, year, overview: wiki.overview, poster: wiki.poster, backdrop: null, trailer: null, genres: [], cast: [], rating: null, votes: "", runtime: "", cert: "" } : { found: false, disabled: !TMDB_KEY };
    }
    metaCache.set(key, { data, exp: now + (data.found ? 24 : 6) * 3600000 });
    res.json(data);
  } catch (e) {
    if (logo) return res.json({ found: true, source: "playlist", title, year, poster: logo, overview: "", backdrop: null, trailer: null, genres: [], cast: [], rating: null, votes: "", runtime: "", cert: "" });
    res.json({ found: false, error: e.message });
  }
});

app.post("/api/meta/batch", async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 60) : [];
  const out = {};
  const now = Date.now();
  await Promise.all(items.map(async (it) => {
    const type = it.type === "series" ? "series" : "movie";
    const title = (it.title || "").trim();
    const year = String(it.year || "").trim();
    const logo = (it.logo || "").trim();
    if (!title) return;
    const id = it.id || (type + "|" + title);
    const key = type + "|" + cleanMetaTitle(title).toLowerCase() + "|" + year;
    const hit = metaCache.get(key);
    if (hit && hit.exp > now) { out[id] = hit.data; return; }
    try {
      let data;
      if (TMDB_KEY) data = await lookupMeta(type, title, year, logo);
      else if (logo) {
        const wiki = await wikiMeta(cleanMetaTitle(title) || title);
        data = { found: true, source: wiki ? wiki.source : "playlist", title, year, overview: wiki ? wiki.overview : "", poster: (wiki && wiki.poster) || logo, backdrop: null, trailer: null, genres: [], cast: [], rating: null, votes: "", runtime: "", cert: "" };
      } else {
        const wiki = await wikiMeta(cleanMetaTitle(title) || title);
        data = wiki ? { found: true, source: wiki.source, title, year, overview: wiki.overview, poster: wiki.poster, backdrop: null, trailer: null, genres: [], cast: [], rating: null, votes: "", runtime: "", cert: "" } : { found: false };
      }
      metaCache.set(key, { data, exp: now + (data.found ? 24 : 6) * 3600000 });
      out[id] = data;
    } catch {
      if (logo) out[id] = { found: true, source: "playlist", title, year, poster: logo, overview: "" };
      else out[id] = { found: false };
    }
  }));
  res.json(out);
});

// EPG auto-matching with learning overrides
app.post("/api/epg/match", async (req, res) => {
  const url = (req.body && req.body.url) || req.query.url || CFG.epgUrl;
  const channels = Array.isArray(req.body && req.body.channels) ? req.body.channels.slice(0, 500) : [];
  const overrides = (req.body && req.body.overrides) || {};
  if (!url || !channels.length) return res.status(400).json({ error: "Missing url or channels" });
  try {
    const { parsed, chNames } = await getEpg(url);
    const result = autoMatchEpg(channels, chNames, parsed, overrides);
    res.json({ ...result, epgChannels: parsed.size });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Accounts (server-backed login)
app.get("/api/accounts", (_req, res) => {
  const store = loadAuthStore();
  res.json({ accounts: store.accounts.map(publicAccount), active: activeSessionInfo() });
});

app.post("/api/accounts", (req, res) => {
  const store = loadAuthStore();
  const name = ((req.body && req.body.name) || "").trim().slice(0, 16);
  const pin = normalizePin(req.body && req.body.pin);
  const avatar = normalizeAvatar(req.body && req.body.avatar);
  if (!name) return res.status(400).json({ error: "Namn krävs" });
  if (!pin) return res.status(400).json({ error: "PIN måste vara 4–6 siffror" });
  if (store.accounts.length >= MAX_ACCOUNTS) return res.status(400).json({ error: "Max antal konton nått" });
  const salt = crypto.randomBytes(16).toString("hex");
  const account = {
    id: genAccountId(),
    name,
    avatar,
    pinSalt: salt,
    pinHash: hashPin(pin, salt),
    createdAt: Date.now(),
  };
  store.accounts.push(account);
  saveAuthStore();
  res.json({ account: publicAccount(account) });
});

app.post("/api/auth/login", (req, res) => {
  const accountId = ((req.body && req.body.accountId) || "").trim();
  const pin = normalizePin(req.body && req.body.pin);
  if (!accountId || !pin) return res.status(400).json({ error: "Konto och PIN krävs" });
  const account = findAccount(accountId);
  if (!account || !verifyPin(account, pin)) return res.status(401).json({ error: "Fel PIN" });
  pruneExpiredSession();
  const active = activeSessionInfo();
  if (active && active.accountId !== accountId) {
    return res.status(409).json({ blocked: true, active });
  }
  const sess = createSession(account);
  res.json({ token: sess.token, account: publicAccount(account) });
});

app.get("/api/auth/session", (req, res) => {
  const sess = getSessionFromReq(req);
  if (!sess) return res.json({ active: false });
  res.json({
    active: true,
    account: { id: sess.accountId, name: sess.accountName, avatar: sess.avatar },
    token: sess.token,
  });
});

app.post("/api/auth/logout", (req, res) => {
  const sess = getSessionFromReq(req);
  if (sess) {
    loadAuthStore().session = null;
    saveAuthStore();
  }
  res.json({ success: true });
});

app.post("/api/auth/heartbeat", (req, res) => {
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ active: false });
  res.json({ active: true, account: { id: sess.accountId, name: sess.accountName, avatar: sess.avatar } });
});

app.post("/api/auth/takeover/request", (req, res) => {
  const accountId = ((req.body && req.body.accountId) || "").trim();
  const pin = normalizePin(req.body && req.body.pin);
  if (!accountId || !pin) return res.status(400).json({ error: "Konto och PIN krävs" });
  const account = findAccount(accountId);
  if (!account || !verifyPin(account, pin)) return res.status(401).json({ error: "Fel PIN" });
  pruneExpiredSession();
  const store = loadAuthStore();
  const active = store.session;
  if (!active || active.accountId === accountId) {
    const sess = createSession(account);
    return res.json({ immediate: true, token: sess.token, account: publicAccount(account) });
  }
  const requestId = "tk_" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  active.takeoverRequest = {
    requestId,
    requesterId: account.id,
    requesterName: account.name,
    requesterAvatar: account.avatar,
    requestedAt: Date.now(),
  };
  saveAuthStore();
  res.json({ pending: true, requestId, active: { name: active.accountName, avatar: active.avatar } });
});

app.get("/api/auth/takeover/pending", (req, res) => {
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ error: "Ingen aktiv session" });
  const tr = sess.takeoverRequest;
  if (!tr) return res.json({ pending: false });
  if (Date.now() - (tr.requestedAt || 0) > TAKEOVER_TTL_MS) {
    sess.takeoverRequest = null;
    saveAuthStore();
    return res.json({ pending: false, expired: true });
  }
  res.json({
    pending: true,
    request: {
      requestId: tr.requestId,
      name: tr.requesterName,
      avatar: tr.requesterAvatar,
      requestedAt: tr.requestedAt,
    },
  });
});

app.post("/api/auth/takeover/respond", (req, res) => {
  const sess = getSessionFromReq(req);
  if (!sess) return res.status(401).json({ error: "Ingen aktiv session" });
  const accept = !!(req.body && req.body.accept);
  const requestId = ((req.body && req.body.requestId) || "").trim();
  const tr = sess.takeoverRequest;
  if (!tr || (requestId && tr.requestId !== requestId)) {
    return res.status(404).json({ error: "Ingen väntande begäran" });
  }
  const store = loadAuthStore();
  pruneTakeoverResults();
  if (!accept) {
    store.takeoverResults[tr.requestId] = { status: "denied", at: Date.now() };
    sess.takeoverRequest = null;
    saveAuthStore();
    return res.json({ success: true, accepted: false });
  }
  const requester = findAccount(tr.requesterId);
  if (!requester) {
    sess.takeoverRequest = null;
    saveAuthStore();
    return res.status(404).json({ error: "Begärande konto hittades inte" });
  }
  const newSess = createSession(requester);
  newSess.takeoverRequest = null;
  saveAuthStore();
  store.takeoverResults[tr.requestId] = {
    status: "accepted",
    at: Date.now(),
    token: newSess.token,
    account: publicAccount(requester),
  };
  saveAuthStore();
  res.json({ success: true, accepted: true });
});

app.get("/api/auth/takeover/status", (req, res) => {
  const requestId = (req.query.requestId || "").trim();
  if (!requestId) return res.status(400).json({ error: "Missing requestId" });
  pruneTakeoverResults();
  const hit = loadAuthStore().takeoverResults[requestId];
  if (!hit) return res.json({ status: "pending" });
  if (hit.status === "accepted") {
    return res.json({ status: "accepted", token: hit.token, account: hit.account });
  }
  return res.json({ status: hit.status || "denied" });
});

// Profile state sync (continue watching, favorites, play counts, EPG overrides)
app.get("/api/profile/sync", (req, res) => {
  const id = (req.query.id || "").trim();
  if (!id) return res.status(400).json({ error: "Missing ?id=" });
  const store = loadProfileStore();
  res.json(store[id] || { id, updatedAt: null, cw: [], favorites: [], plays: [], epgOverrides: {}, channelOrder: [] });
});

app.post("/api/profile/sync", (req, res) => {
  const { id, cw, favorites, plays, epgOverrides, channelOrder } = req.body || {};
  if (!id) return res.status(400).json({ error: "Missing id" });
  const store = loadProfileStore();
  store[id] = {
    id,
    updatedAt: Date.now(),
    cw: Array.isArray(cw) ? cw.slice(0, 200) : (store[id] && store[id].cw) || [],
    favorites: Array.isArray(favorites) ? favorites.slice(0, 500) : (store[id] && store[id].favorites) || [],
    plays: Array.isArray(plays) ? plays.slice(0, 500) : (store[id] && store[id].plays) || [],
    epgOverrides: epgOverrides && typeof epgOverrides === "object" ? epgOverrides : (store[id] && store[id].epgOverrides) || {},
    channelOrder: Array.isArray(channelOrder) ? channelOrder.slice(0, 500) : (store[id] && store[id].channelOrder) || [],
  };
  saveProfileStore(store);
  res.json({ success: true, updatedAt: store[id].updatedAt });
});

// Genre-affinity recommendations from watch history
app.post("/api/recommend", (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 400) : [];
  const history = Array.isArray(req.body && req.body.history) ? req.body.history.slice(0, 100) : [];
  const exclude = new Set(Array.isArray(req.body && req.body.exclude) ? req.body.exclude : []);
  const histMap = new Map(history.map(h => [h.id, h.count || 1]));
  const genreW = new Map();
  for (const h of history) {
    const w = h.count || 1;
    for (const g of (h.genres || [])) {
      const k = (g || "").toLowerCase();
      if (k) genreW.set(k, (genreW.get(k) || 0) + w);
    }
  }
  const scored = items.filter(it => !exclude.has(it.id)).map(it => {
    let score = (histMap.get(it.id) || 0) * 0.5;
    for (const g of (it.genres || [])) {
      const k = (g || "").toLowerCase();
      if (genreW.has(k)) score += genreW.get(k) * 2.2;
    }
    if (it.rating) score += Math.min(it.rating, 10) * 0.35;
    if (it.popularity) score += Math.min(it.popularity, 1);
    return { id: it.id, score, type: it.type, title: it.title || it.name };
  }).filter(x => x.score > 0.5).sort((a, b) => b.score - a.score).slice(0, 24);
  res.json({ recommendations: scored });
});

// DVR: schedule a recording
app.post("/api/dvr/schedule", (req, res) => {
  const { id, channel, title, start, stop, recurring } = req.body || {};
  if (!id || !channel || !start || !stop) return res.status(400).json({ error: "Missing required fields" });
  const recordId = "dvr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  dvrSchedule.set(recordId, { id: recordId, itemId: id, channel, title: title || "Untitled", start, stop, recurring: recurring || false, createdAt: Date.now() });
  // Check for conflicts
  const conflicts = [];
  for (const [rid, item] of dvrSchedule) {
    if (rid === recordId) continue;
    if (item.channel === channel && item.start < stop && item.stop > start) {
      conflicts.push({ id: rid, title: item.title, channel: item.channel });
    }
  }
  res.json({ success: true, recordId, conflicts });
});

// DVR: list all scheduled recordings
app.get("/api/dvr/list", (_req, res) => {
  const now = Date.now();
  const items = [];
  for (const [id, item] of dvrSchedule) {
    items.push({ ...item, status: item.stop < now ? "completed" : item.start > now ? "scheduled" : "recording" });
  }
  items.sort((a, b) => a.start - b.start);
  res.json(items);
});

// DVR: remove a scheduled recording
app.post("/api/dvr/remove", (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "Missing id" });
  const existed = dvrSchedule.delete(id);
  res.json({ success: existed });
});

// DVR: get recording stats
app.get("/api/dvr/stats", (_req, res) => {
  const now = Date.now();
  const total = dvrSchedule.size;
  let scheduled = 0, completed = 0, recording = 0;
  for (const [, item] of dvrSchedule) {
    if (item.stop < now) completed++;
    else if (item.start > now) scheduled++;
    else recording++;
  }
  res.json({ total, scheduled, completed, recording });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  const net = cachedNetworkUrls(PORT);
  console.log("");
  console.log("  ┌────────────────────────────────────────────┐");
  console.log("  │         BÄCK — Stream Smarter  v3.2         │");
  console.log("  └────────────────────────────────────────────┘");
  console.log("");
  console.log("   On this device : " + (net.urls.local || ("http://localhost:" + PORT)));
  if (net.urls.lan) console.log("   On your LAN    : " + net.urls.lan + (net.lanPort80 ? "" : "   (same Wi-Fi)"));
  if (net.urls.public) console.log("   Outside LAN    : " + net.urls.public + (net.funnel ? "   (public WAN)" : "   (Tailscale HTTPS)"));
  else if (net.urls.remote) console.log("   Outside LAN    : " + net.urls.remote + "   (enable: .\\setup-complete.ps1)");
  if (net.urls.wan && net.urls.wan !== net.urls.public) console.log("   Public WAN     : " + net.urls.wan + (net.funnel ? "" : "   (Cloudflare fallback)"));
  if (net.serveEnableUrl) console.log("   Enable Serve   : " + net.serveEnableUrl);
  if (net.funnelEnableUrl && !net.funnel) console.log("   Enable Funnel  : " + net.funnelEnableUrl);
  console.log("");
  console.log("   Metadata/trailers : " + (TMDB_KEY ? "ON (TMDB)" : "off — add a tmdbKey to enable"));
  console.log("   Xtream Codes API : ✓");
  console.log("   Subtitles        : " + (OS_KEY ? "ON (OpenSubtitles)" : "ON (Wyzie fallback)"));
  console.log("   Flow: You -> Player -> THIS SERVER -> IPTV Source");
  console.log("   Stop: press Ctrl+C");
  console.log("");
});
