# 📡 Vectorhome Reader

A self-hosted RSS reader — a Google Reader / Feedly substitute for a single user.
Fetches RSS/Atom feeds, tracks read/unread, organizes feeds into categories,
imports/exports OPML, and **turns almost any link into a feed** — including pages
that have no RSS at all (via auto-discovery with a scraping fallback).

Built to run on your own server/VPS with **zero external services**: a single Node
process plus a SQLite file. No native build step (uses Node's built-in `node:sqlite`).

> ### 🤖 Built entirely by AI
> This project — all of the code, tests, and documentation — was written **end to
> end by an AI coding assistant** (Anthropic's Claude, via Claude Code), working
> from a human's plain-language feature requests. No line was hand-written by a
> person. It's shared as a real-world example of what agentic AI development can
> produce; review it with that context in mind before running it anywhere
> sensitive.

## Features

- **Add feeds by URL** — paste a feed URL *or* a normal site URL.
- **Auto-discovery + scrape fallback** — when you paste `https://example.com`, it:
  1. checks if the URL is already a feed,
  2. reads `<link rel="alternate">` feed declarations on the page,
  3. probes common paths (`/feed`, `/rss`, `/atom.xml`, …),
  4. and if there's still no feed, **scrapes the page into a synthetic feed**
     (e.g. `https://ici.radio-canada.ca/decrypteurs/infolettre`).
- **Categories / folders** with per-feed and per-category unread counts.
- **Read / unread tracking** + **starred** items, stored server-side in SQLite.
- **OPML import & export** — bring your subscriptions over from Feedly/Reeder/etc.
- **Background auto-refresh** every `REFRESH_MINUTES` (default 30), plus a manual ⟳.
- **Keyboard shortcuts:** `j`/`k` next/prev, `m` toggle read, `s` star.
- **Full-text search** (SQLite FTS5, diacritics-insensitive, search-as-you-type).
- **Infinite scroll** — no article cap; pages load as you read.
- **PWA** — installable on mobile, app-shell caching, offline reading of loaded articles.
- **Built-in login** with optional TOTP 2FA (QR enrollment) — see Authentication.
- **Nightly DB backups** (rotating gzip snapshots, rclone-to-B2 friendly).
- Clean UI, light/dark automatic, English/French, no build tooling. `npm test` runs the suite.

## Requirements

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite`). Tested on Node 24.

## Run locally

```bash
npm install
npm start            # http://localhost:3000
```

`npm run dev` restarts on file changes.

## Configuration (env vars)

| Variable          | Default              | Meaning                                  |
|-------------------|----------------------|------------------------------------------|
| `PORT`            | `3000`               | HTTP port                                |
| `HOST`            | `0.0.0.0`            | Bind address (`127.0.0.1` behind a proxy)|
| `REFRESH_MINUTES` | `30`                 | Background feed refresh interval         |
| `READER_DB`       | `./data/reader.db`   | SQLite database path                     |
| `READER_USERNAME` | `admin`              | Login username (first-run bootstrap)     |
| `READER_PASSWORD` | _(unset)_            | First-run login password (hashed into the DB; removable after) |
| `SESSION_DAYS`    | `30`                 | Session cookie lifetime (days)           |
| `READER_TRUST_DAYS` | `60`               | "Remember this browser" (skip TOTP) lifetime (days) |
| `READER_BACKUP_DIR` | _(unset)_          | Nightly gzipped DB snapshots here (7 weekday + 1 monthly slot); unset = disabled |
| `SOLVER_URL`      | _(unset)_            | FlareSolverr endpoint for Cloudflare-protected feeds (e.g. `http://localhost:8191/v1`) |

## Deploy on a VPS

### Option A — systemd

```bash
sudo mkdir -p /opt/vectorhome-reader
sudo rsync -a --exclude node_modules --exclude data ./ /opt/vectorhome-reader/
cd /opt/vectorhome-reader && sudo npm install --omit=dev
sudo cp deploy/vectorhome-reader.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now vectorhome-reader
```

Put it behind nginx/Caddy with TLS. The app has its **own login** (set
`READER_USERNAME`/`READER_PASSWORD` for the first run — see "Authentication"
below), so the proxy only needs to terminate TLS and forward to the app.

### Option B — Docker

```bash
docker build -t vectorhome-reader .
docker run -d --name reader -p 3000:3000 -v reader-data:/app/data vectorhome-reader
```

## Cloudflare-protected feeds (FlareSolverr)

Some sites put their RSS feed behind a Cloudflare "Just a moment…" browser
challenge. A plain HTTP fetch can't pass it (the reader will mark such feeds
`[Unreachable]` with *"Blocked by a Cloudflare browser challenge"*). To read
them, the reader can route a feed through **[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)**,
an open-source proxy that loads the URL in a real (anti-detection) browser,
solves the challenge, and returns the content.

1. Run FlareSolverr (easiest: use the bundled `docker-compose.yml`, or
   `docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest`).
2. Set `SOLVER_URL` on the reader, e.g. `SOLVER_URL=http://localhost:8191/v1`.
3. In the app: **☰ Settings → Edit** a feed → tick **“Fetch via Cloudflare
   challenge solver”**. That feed (only) will then be fetched through the solver.

Keep it sparing: solved feeds use a real browser, so they're slower and heavier.
The reader still polls on the normal interval and caches results. Use this for
feeds you have a legitimate reason to read; it won't defeat an interactive
(CAPTCHA) challenge, and isn't a substitute for a site's official API.

## Remote HTTPS access (free cert, blocked ports)

To reach the reader securely from outside your network — even if your ISP blocks
ports 80/443 — see [deploy/https-setup.md](deploy/https-setup.md). It documents a
working setup with a free auto‑renewing certificate (acme.sh DNS‑01 via DuckDNS),
Caddy terminating TLS on a non‑standard port, and the reader locked
to localhost behind it — plus a full troubleshooting section. The reader honors a
`HOST` env var (default `0.0.0.0`; set `HOST=127.0.0.1` to bind localhost‑only
behind the proxy).

## Authentication

The app has a built-in **login page + session cookie** (single user), with
**optional TOTP 2FA** (Bitwarden/Authy/Google Authenticator) and one-time
recovery codes — all dependency-free (`node:crypto`), no external auth service.

- On **first run** it bootstraps the credential from `READER_USERNAME` /
  `READER_PASSWORD` (stored **hashed** via scrypt). Afterwards you can change the
  password and enable 2FA in **Settings → Security**, and remove
  `READER_PASSWORD` from the environment.
- Sessions are signed (`HMAC-SHA256`), `HttpOnly` + `SameSite=Lax` + `Secure`
  (behind an HTTPS proxy). Auth secrets live in a separate `auth` table, never
  exposed by the API.
- Always run it behind **TLS** (it sets `Secure` cookies based on
  `X-Forwarded-Proto`). Keep `HOST=127.0.0.1` so it's only reachable via the proxy.

## A note on security

Feed content is sanitized (`<script>`/`style`/`iframe`/inline handlers and
dangerous URL schemes stripped) before rendering. Outbound feed fetches are
hardened (`lib/safefetch.js`: blocks cloud-metadata endpoints, caps body size).

## API (for reference)

| Method & path                  | Purpose                                  |
|--------------------------------|------------------------------------------|
| `GET  /api/state`              | Categories, feeds, unread/starred totals |
| `GET  /api/items`              | Items (`feed_id`,`category_id`,`filter`) |
| `POST /api/discover`           | Preview feed candidates for a URL        |
| `POST /api/feeds`              | Subscribe (rss or `kind:"scrape"`)       |
| `PATCH/DELETE /api/feeds/:id`  | Rename/recategorize / unsubscribe        |
| `POST /api/feeds/:id/refresh`  | Refresh one feed                         |
| `POST /api/items/:id/read`     | Mark read/unread                         |
| `POST /api/items/:id/star`     | Star/unstar                              |
| `POST /api/items/read-all`     | Mark all read (optional feed/category)   |
| `POST /api/refresh`            | Refresh all feeds now                    |
| `POST /api/opml/import`        | Import OPML (XML body)                    |
| `GET  /api/opml/export`        | Download OPML                            |

## Project layout

```
server.js          Express API + static hosting + background refresh
db.js              SQLite schema (node:sqlite)
lib/discover.js    URL → feed: discovery + scraping fallback
lib/feeds.js       Fetch & parse feeds, persist items
lib/opml.js        OPML import/export
public/            Frontend SPA (index.html, app.js, style.css)
data/reader.db     SQLite database (created on first run)
```

## Development

This app was built by a human and an AI assistant (Claude, via Claude Code)
working together in conversation. The split of responsibilities was roughly:

**The human collaborator:**
- **Set the goals and constraints** — what to build and the rules it had to live
  within: self-hosted single-user, zero external services, runs on a home VPS
  behind an ISP that blocks ports 80/443, colorblind-safe status indicators,
  bilingual (English / French-Canadian), Backblaze B2 for backups, and so on.
- **Drove the product** — requested each feature, prioritized, chose between
  design options the AI offered, and decided the trade-offs (e.g. how aggressive
  the SSRF protection should be, whether 2FA is opt-in).
- **Tested in the real world** — used the app daily on desktop and mobile and
  reported the bugs that mattered: newsletters scraped as link lists instead of
  articles, images loading too slowly, an intermittent login hang, mobile layout
  issues, TOTP autofill not working in the browser's password manager. Much of
  the polish came from this feedback loop.
- **Operated anything privileged** — ran all commands touching real credentials
  or infrastructure: rotating passwords/tokens, the router port-forward, DNS,
  creating the GitHub repo and its deploy key, and confirming service restarts.

**The AI assistant:**
- **Wrote all the code, tests, and documentation** — architecture and every line,
  from the SQLite schema to the service worker to this README.
- **Made the engineering decisions** — library choices, data model, the auth
  design (scrypt + signed sessions + RFC-6238 TOTP), the security hardening.
- **Debugged and verified** — reproduced issues, ran syntax/integration/RFC
  test-vector checks, and audited the codebase for vulnerabilities.
- **Handled deployment mechanics** — systemd unit, cron, Caddy reverse-proxy
  config, the backup pipeline, and preparing this repo for publication.

**Models used.** The code was produced with Anthropic's Claude models through
Claude Code, across several sessions. Exact per-line attribution isn't tracked,
but the work split roughly this way:

- **Claude Opus 4.8** — most of the application and the security-sensitive parts:
  the authentication system (scrypt passwords, signed sessions, TOTP 2FA,
  recovery codes, "remember this browser"), English / French-Canadian
  internationalization, the outbound-fetch hardening (`lib/safefetch.js`) and the
  HTML sanitizer, a security/bug audit, the mobile UI, and the harder debugging
  (an intermittent HTTPS login hang, feed-scraping misclassification, a CDN `403`
  fix). It also handled deployment and preparing this repository for release.
- **Claude Fable 5** — a full design-and-vulnerability review, then the resulting
  batch of larger features: pagination / infinite scroll, full-text search
  (SQLite FTS5), the installable PWA (service worker + manifest), QR-code 2FA
  enrollment, the nightly Backblaze B2 backup pipeline, and the automated test
  suite (`npm test`).

In short: **the human decided *what* and *why* and confirmed it worked in
practice; the AI decided *how* and did the building.** The automated test suite
(`npm test`) exists partly so that this collaboration stays verifiable rather
than taken on faith.
