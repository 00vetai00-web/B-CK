// Shared M3U → library builder (used by server /api/playlist/library)

const RX = /[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})/;

function clean(s) {
  return (s || "").replace(/[._]+/g, " ").replace(/\s*[-–—|:]+\s*/g, " ").replace(/\s+/g, " ").trim();
}

function parseEpisode(name) {
  if (!name) return null;
  let m;
  m = name.match(/^(.*?)[\s._:-]*[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})\b(.*)$/);
  if (m) return { show: clean(m[1]), season: +m[2], episode: +m[3], episodeTitle: clean(m[4]) };
  m = name.match(/^(.*?)[\s._:-]+(\d{1,2})x(\d{1,3})\b(.*)$/);
  if (m) return { show: clean(m[1]), season: +m[2], episode: +m[3], episodeTitle: clean(m[4]) };
  return null;
}

function classify(it) {
  if (!it) return "live";
  const u = (it.url || "").toLowerCase();
  const g = (it.group || "").toLowerCase();
  const n = it.name || "";
  if (u.indexOf("/series/") >= 0) return "series";
  if (/\/(movie|movies|vod)\//.test(u)) return "movie";
  if (u.indexOf("/live/") >= 0) return "live";
  if (RX.test(n) || /\b\d{1,2}x\d{1,3}\b/.test(n)) return "series";
  if (/\b(series|tv\s?shows?|shows)\b/.test(g)) return "series";
  if (/\b(movies?|films?|vod|cinema)\b/.test(g)) return "movie";
  const ext = ((u.split("?")[0].match(/\.([a-z0-9]{2,4})$/) || [])[1]) || "";
  if (["mp4", "mkv", "avi", "mov", "m4v", "flv", "wmv"].indexOf(ext) >= 0) return "movie";
  return "live";
}

function yearOf(n) {
  const m = (n || "").match(/\b(19|20)\d{2}\b/);
  return m ? +m[0] : null;
}

function titleClean(n) {
  return (n || "").replace(/\s*[\(\[]?(19|20)\d{2}[\)\]]?\s*$/, "").replace(/\s*\((?:HD|FHD|4K|SD)\)\s*/gi, "").trim();
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.indexOf("#EXTINF") === 0) {
      const attrs = {};
      const re = /([\w-]+)="([^"]*)"/g;
      let m, lastEnd = -1;
      while ((m = re.exec(line))) {
        attrs[m[1].toLowerCase()] = m[2];
        lastEnd = re.lastIndex;
      }
      const commaIdx = lastEnd >= 0 ? line.indexOf(",", lastEnd) : line.indexOf(",");
      let name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : "";
      if (!name) name = attrs["tvg-name"] || "Unknown";
      cur = { name, logo: attrs["tvg-logo"] || "", group: attrs["group-title"] || "Uncategorized", tvgId: attrs["tvg-id"] || "", url: "" };
    } else if (line.indexOf("#EXTGRP") === 0) {
      const g = line.split(":")[1];
      if (cur && g) cur.group = g.trim();
    } else if (line[0] === "#") {
      // skip
    } else if (cur) {
      cur.url = line;
      items.push(cur);
      cur = null;
    }
  }
  return items;
}

function buildLibrary(items) {
  const live = { cats: {} };
  const movie = { cats: {} };
  const series = { cats: {}, shows: {} };
  for (const it of items) {
    const t = classify(it);
    it.type = t;
    if (t === "live") {
      (live.cats[it.group] || (live.cats[it.group] = [])).push(it);
    } else if (t === "movie") {
      it.year = yearOf(it.name);
      it.title = titleClean(it.name);
      (movie.cats[it.group] || (movie.cats[it.group] = [])).push(it);
    } else {
      const ep = parseEpisode(it.name) || { show: clean(it.name), season: 1, episode: 0, episodeTitle: "" };
      it.show = ep.show || clean(it.name);
      it.season = ep.season || 1;
      it.episode = ep.episode || 0;
      it.episodeTitle = ep.episodeTitle || "";
      let sh = series.shows[it.show];
      if (!sh) {
        sh = { id: "show:" + it.show, name: it.show, group: it.group, type: "series", seasons: {}, count: 0, logo: "" };
        series.shows[it.show] = sh;
        (series.cats[it.group] || (series.cats[it.group] = [])).push(sh);
      }
      if (it.logo && !sh.logo) sh.logo = it.logo;
      (sh.seasons[it.season] || (sh.seasons[it.season] = [])).push(it);
      sh.count++;
    }
  }
  for (const sh of Object.values(series.shows)) {
    for (const s of Object.keys(sh.seasons)) sh.seasons[s].sort((a, b) => a.episode - b.episode);
  }
  return { live, movie, series };
}

function finalizeLibrary(lib) {
  let i = 0;
  Object.values(lib.live.cats).forEach(a => a.forEach(it => { if (!it.id) it.id = "L" + (i++); }));
  Object.values(lib.movie.cats).forEach(a => a.forEach(it => { if (!it.id) it.id = "M" + (i++); }));
  Object.values(lib.series.shows).forEach(sh => Object.values(sh.seasons).forEach(a => a.forEach(ep => { if (!ep.id) ep.id = "E" + (i++); })));
  const live = Object.values(lib.live.cats).reduce((a, c) => a + c.length, 0);
  const movie = Object.values(lib.movie.cats).reduce((a, c) => a + c.length, 0);
  const shows = Object.keys(lib.series.shows).length;
  const eps = Object.values(lib.series.shows).reduce((a, s) => a + s.count, 0);
  lib.counts = { live, movie, shows, eps, entries: live + movie + eps };
  return lib;
}

function buildLibraryFromM3U(text) {
  if (!/#EXTINF/i.test(text) && !/#EXTM3U/i.test(text)) {
    throw new Error("Not an M3U playlist");
  }
  const items = parseM3U(text);
  if (!items.length) throw new Error("No channels found");
  return finalizeLibrary(buildLibrary(items));
}

module.exports = {
  parseM3U,
  buildLibrary,
  finalizeLibrary,
  buildLibraryFromM3U,
};