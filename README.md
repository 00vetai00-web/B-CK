# BÄCK — Stream Smarter

A **private, self-hosted IPTV player** with a Netflix-style interface. You run one small
Node server (on a PC, a Raspberry Pi, or your Android phone via Termux) and every stream is
routed through it:

```
You  →  BÄCK Player  →  THIS SERVER  →  your IPTV source
```

Your device never talks to the IPTV provider directly, and your provider credentials stay on
the server. No accounts, no telemetry, no cloud.

---

## What it does

**Your playlist, organized like Netflix.** BÄCK reads your M3U/Xtream playlist and
automatically splits it into **Live TV**, **Movies** and **Series** using its classification
engine (URL paths, `SxxExx` naming, group titles and file extensions). On first run you pick
which categories to keep in each type.

**Everything a modern player should have:**

- **Live TV** with EPG now/next + a full guide (from your XMLTV url)
- **Movies** with posters, resume, and Continue Watching
- **Series** grouped into shows → seasons → episodes, with per-episode resume, **watched**
  marks and **next-episode autoplay**
- **In-player episode picker** (season switcher + jump to any episode), **Skip Intro**,
  next-episode countdown, **playback speed**, **subtitles/audio** track menu, **Picture-in-Picture**,
  10-second skip, and full keyboard control
- **Info + trailers for every title** — plot, rating, cast, genres, runtime and the official
  trailer, fetched live through your server from **TMDB** (see below)
- Top 10 rows, Shuffle / "Play something", cross-type search, My List, multiple profiles
- **Virtualized UI** that stays smooth on libraries of tens of thousands of items
- **Installable** as a PWA (Add to Home Screen) and mobile-friendly

The privacy core: the server rewrites **every** URL inside HLS manifests — segments, keys,
sub-playlists, `EXT-X-MAP` — so all playback traffic goes through your server, and it forwards
HTTP `Range` requests so VOD seeking/resume works.

---

## Quick start (PC / Mac / Linux / Raspberry Pi)

1. Install **Node.js 18+** (https://nodejs.org)
2. In this folder, run:

   ```bash
   npm install
   npm start
   ```
3. Open **http://localhost:3000** and paste your M3U playlist URL to connect.

That's it. Other devices on the same Wi-Fi can open the LAN address the server prints on start
(e.g. `http://192.168.1.20:3000`).

## Run it on your Android phone (Termux)

Your phone becomes the server — you keep the privacy proxy even on mobile.

1. Install **Termux** (from F-Droid — the Play Store build is outdated)
2. In Termux:
   ```bash
   pkg update && pkg install nodejs
   cd /path/to/back-proxy
   bash start.sh
   ```
3. Open **http://localhost:3000** in your phone's browser and **Add to Home Screen** to install
   it like an app.

`start.sh` handles the first-run `npm install` and keeps the CPU awake while streaming.

---

## Configuration (optional)

Copy `config.example.json` to `config.json` to set defaults:

```json
{
  "port": 3000,
  "playlistCacheMinutes": 10,
  "epgCacheMinutes": 60,
  "epgUrl": "http://your-provider/xmltv.php?username=USER&password=PASS",
  "tmdbKey": "YOUR_TMDB_KEY",
  "playlists": [
    { "name": "My Provider", "url": "http://your-provider/get.php?username=USER&password=PASS&type=m3u_plus" }
  ]
}
```

- **playlists** appear as one-tap presets on the connect screen.
- **epgUrl** is used as the default TV guide if you don't enter one.
- **tmdbKey** enables info + trailers (below).

You can also set these with environment variables: `PORT`, `TMDB_KEY`, and — to password-protect
the whole server — `BACK_USER` and `BACK_PASS`.

### Enabling info + trailers (TMDB)

Metadata and trailers come from **The Movie Database (TMDB)**, fetched **server-side** so your
key stays private and it works for every title in your playlist.

1. Make a free account at https://www.themoviedb.org and request an API key
   (Settings → API). Either the **v3 API key** or the **v4 Read Access Token** works.
2. Put it in `config.json` as `tmdbKey` (or set the `TMDB_KEY` environment variable) and restart.

The server caches results, so repeat lookups are instant. Without a key, BÄCK still works fully —
it just skips the extended info panel. Trailers play from YouTube, so that part uses the internet
directly (it's promotional content, not your IPTV traffic).

---

## Included files

- `server.js` — the proxy + API + static server (Express)
- `public/index.html` — the player (single-file React app)
- `public/demo.html` — a **standalone demo** (no server, no playlist needed) that showcases the
  full UI on sample content — open it directly in any browser to try the interface
- `public/manifest.json`, `public/icon.svg` — PWA assets
- `start.sh` — Termux/desktop launcher
- `config.example.json` — configuration template

## API (for the curious)

`/api/health` · `/api/config` · `/api/playlist?url=` · `/api/stream?url=` (HLS rewrite + Range) ·
`/api/epg/now?url=` · `/api/epg/schedule?url=&channel=` · `/api/meta?type=&title=&year=`

---

**www.backstream.app** · v2.2
