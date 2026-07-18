import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db from './db.js';
import { discover, normalizeUrl, fetchLeadImage } from './lib/discover.js';
import { refreshFeed, refreshAll, solverConfigured } from './lib/feeds.js';
import { importOpml, exportOpml } from './lib/opml.js';
import * as auth from './lib/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // set HOST=127.0.0.1 to expose only via a local reverse proxy
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || 30);
const SESSION_MAXAGE = Number(process.env.SESSION_DAYS || 30) * 86400;

auth.bootstrap(); // create the signing secret + (from env) the initial credential

app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: ['application/xml', 'text/xml', 'text/x-opml'], limit: '10mb' }));

// ---- Authentication gate (everything below requires a valid session) ----
const SESSION_COOKIE = 'vh_session';
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const TRUST_COOKIE = 'vh_trust';
const TRUST_MAXAGE = auth.trustDays() * 86400;
const isAuthed = (req) => !!auth.verifyToken(parseCookies(req)[SESSION_COOKIE]);
const cookieFlags = (req, maxAge) =>
  `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
const setSession = (req, res) =>
  res.append('Set-Cookie', `${SESSION_COOKIE}=${auth.issueToken(auth.getUsername())}; ${cookieFlags(req, SESSION_MAXAGE)}`);
const setTrust = (req, res) =>
  res.append('Set-Cookie', `${TRUST_COOKIE}=${auth.issueTrust(auth.getUsername())}; ${cookieFlags(req, TRUST_MAXAGE)}`);
const clearSession = (res) => res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);

// PWA plumbing (/sw.js, /manifest.webmanifest, /icons/*) must bypass the gate:
// a service-worker update fetch or manifest fetch that gets redirected to HTML
// would break installation/updates.
const OPEN_PATHS = new Set(['/login', '/api/login', '/api/logout', '/api/auth/required',
  '/favicon.svg', '/sw.js', '/manifest.webmanifest']);
app.use((req, res, next) => {
  if (isAuthed(req) || OPEN_PATHS.has(req.path) || req.path.startsWith('/icons/')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  res.sendFile(join(__dirname, 'public', 'login.html'));
});
// Login rate limit: sliding 15-minute window per client IP (plus a global cap,
// since X-Forwarded-For can be varied by an attacker). Successful login resets.
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_MAX_PER_IP = Number(process.env.LOGIN_MAX_PER_IP || 10);
const LOGIN_MAX_GLOBAL = Number(process.env.LOGIN_MAX_GLOBAL || 50);
const loginFails = new Map(); // ip -> [timestamps]
function loginLimited(ip) {
  const now = Date.now();
  for (const [k, arr] of loginFails) {
    const live = arr.filter((ts) => now - ts < LOGIN_WINDOW_MS);
    if (live.length) loginFails.set(k, live); else loginFails.delete(k);
  }
  const mine = (loginFails.get(ip) || []).length;
  const total = [...loginFails.values()].reduce((s, a) => s + a.length, 0);
  return mine >= LOGIN_MAX_PER_IP || total >= LOGIN_MAX_GLOBAL;
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  if (loginLimited(ip)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const { username, password, code, remember } = req.body || {};
  // A valid "remember this browser" cookie lets us skip the TOTP step.
  const trusted = auth.totpEnabled() && auth.verifyTrust(parseCookies(req)[TRUST_COOKIE], auth.getUsername());
  const r = auth.checkLogin({ username, password, code, trusted });
  if (r.ok) {
    loginFails.delete(ip);
    setSession(req, res);
    // (Re)issue the 60-day trust cookie if asked, or slide it when already trusted.
    if (auth.totpEnabled() && (remember || trusted)) setTrust(req, res);
    return res.json({ ok: true });
  }
  loginFails.set(ip, [...(loginFails.get(ip) || []), Date.now()]);
  if (r.error === 'not_configured') return res.status(503).json({ ok: false, error: 'not_configured' });
  if (r.totp_required) return res.status(401).json({ ok: false, totp_required: true, error: r.error });
  return res.status(401).json({ ok: false, error: r.error || 'bad_credentials' });
});
app.post('/api/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });
// Lets the login page show the TOTP field up front (so password managers can
// autofill username + password + code in one pass).
app.get('/api/auth/required', (req, res) => res.json({ totp: auth.totpEnabled() }));

app.use(express.static(join(__dirname, 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(500).json({ error: String(e.message || e) });
});

// ---- Sidebar state: categories, feeds, unread counts ----
app.get('/api/state', (req, res) => {
  const cats = db.prepare('SELECT id, name FROM categories ORDER BY name').all();
  const feeds = db.prepare(`
    SELECT f.id, f.title, f.feed_url, f.site_url, f.category_id, f.kind, f.last_error, f.last_fetched,
           (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND i.is_read = 0) AS unread,
           COALESCE(f.source_newest,
             (SELECT MAX(COALESCE(i.published_at, i.fetched_at)) FROM items i WHERE i.feed_id = f.id)) AS newest
    FROM feeds f ORDER BY f.title COLLATE NOCASE
  `).all();
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM items WHERE is_read = 0)    AS unread,
      (SELECT COUNT(*) FROM items WHERE is_starred = 1) AS starred
  `).get();
  res.json({ categories: cats, feeds, totals });
});

// ---- Items list ----
// Coerce a query param to a non-negative integer, falling back when it's junk.
const intParam = (v, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

app.get('/api/items', (req, res) => {
  const { feed_id, category_id, filter = 'unread' } = req.query;
  const where = [];
  const params = [];
  if (feed_id) { where.push('i.feed_id = ?'); params.push(intParam(feed_id, 0)); }
  if (category_id) { where.push('f.category_id = ?'); params.push(intParam(category_id, 0)); }
  if (filter === 'unread') where.push('i.is_read = 0');
  if (filter === 'starred') where.push('i.is_starred = 1');
  // Keyset pagination: only items strictly older than this date. Robust against
  // the unread filter mutating under the reader (offsets would skip rows).
  if (req.query.before) { where.push('COALESCE(i.published_at, i.fetched_at) < ?'); params.push(String(req.query.before)); }
  const sql = `
    SELECT i.id, i.feed_id, i.title, i.link, i.author, i.summary, i.content,
           i.published_at, i.fetched_at, i.is_read, i.is_starred,
           f.title AS feed_title, f.site_url AS feed_site
    FROM items i JOIN feeds f ON f.id = i.feed_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(i.published_at, i.fetched_at) DESC
    LIMIT ? OFFSET ?`;
  // Fetch one extra row past the page to tell the client whether more exist.
  const limit = Math.min(intParam(req.query.limit, 50), 200);
  params.push(limit + 1, intParam(req.query.offset, 0));
  const rows = db.prepare(sql).all(...params);
  const has_more = rows.length > limit;
  res.json({ items: has_more ? rows.slice(0, limit) : rows, has_more });
});

// ---- Full-text search (FTS5) ----
// Each whitespace-separated term becomes a quoted token (AND semantics); the
// last term gets a * for search-as-you-type prefix matching. Quoting the terms
// keeps FTS5 query syntax (AND/OR/NEAR, parens) from ever throwing on user input.
function ftsQuery(q) {
  const terms = String(q || '').split(/\s+/).map((s) => s.replace(/"/g, '')).filter(Boolean).slice(0, 8);
  if (!terms.length) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? '*' : ''}`).join(' ');
}
app.get('/api/search', (req, res) => {
  const match = ftsQuery(req.query.q);
  if (!match) return res.json({ items: [], has_more: false });
  const limit = Math.min(intParam(req.query.limit, 50), 200);
  const offset = intParam(req.query.offset, 0);
  let rows;
  try {
    rows = db.prepare(`
      SELECT i.id, i.feed_id, i.title, i.link, i.author, i.summary, i.content,
             i.published_at, i.fetched_at, i.is_read, i.is_starred,
             f.title AS feed_title, f.site_url AS feed_site
      FROM items_fts s
      JOIN items i ON i.id = s.rowid
      JOIN feeds f ON f.id = i.feed_id
      WHERE items_fts MATCH ?
      ORDER BY s.rank
      LIMIT ? OFFSET ?`).all(match, limit + 1, offset);
  } catch { rows = []; } // malformed MATCH -> no results rather than a 500
  const has_more = rows.length > limit;
  res.json({ items: has_more ? rows.slice(0, limit) : rows, has_more });
});

// ---- Discover feed candidates for a URL (preview before adding) ----
app.post('/api/discover', wrap(async (req, res) => {
  const result = await discover(req.body.url);
  res.json(result);
}));

// ---- Add a feed (rss or scrape) ----
app.post('/api/feeds', wrap(async (req, res) => {
  let { url, kind, title, category, feed_url, source_url, scrape_mode } = req.body;
  let row;

  if (kind === 'scrape') {
    const src = normalizeUrl(source_url || url);
    const mode = ['auto', 'page', 'links'].includes(scrape_mode) ? scrape_mode : 'auto';
    const info = db.prepare(
      `INSERT INTO feeds (title, feed_url, site_url, kind, source_url, category_id, scrape_mode)
       VALUES (?, ?, ?, 'scrape', ?, ?, ?)`
    ).run(title || src, 'scrape:' + src, src, src, categoryId(category), mode);
    row = db.prepare('SELECT * FROM feeds WHERE id = ?').get(info.lastInsertRowid);
  } else {
    // If a concrete feed_url was chosen from discovery, use it; otherwise discover.
    let chosen = feed_url ? { feedUrl: normalizeUrl(feed_url), title, siteUrl: null } : null;
    if (!chosen) {
      const { candidates, scrape } = await discover(url);
      if (!candidates.length) {
        // No real feed — tell the client it can fall back to scraping.
        return res.status(409).json({ error: 'no_feed', scrape });
      }
      chosen = candidates[0];
    }
    const info = db.prepare(
      `INSERT INTO feeds (title, feed_url, site_url, kind, category_id) VALUES (?, ?, ?, 'rss', ?)
       ON CONFLICT(feed_url) DO UPDATE SET title = excluded.title`
    ).run(title || chosen.title, chosen.feedUrl, chosen.siteUrl, categoryId(category));
    row = db.prepare('SELECT * FROM feeds WHERE feed_url = ?').get(chosen.feedUrl);
  }

  const r = await refreshFeed(row);
  res.json({ feed: db.prepare('SELECT * FROM feeds WHERE id = ?').get(row.id), refresh: r });
}));

app.patch('/api/feeds/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(id);
  if (!feed) return res.status(404).json({ error: 'not found' });

  const { title, category, feed_url, use_solver, scrape_mode } = req.body;
  let needRefresh = false;

  if (title != null) db.prepare('UPDATE feeds SET title = ? WHERE id = ?').run(title, id);
  if (category !== undefined) db.prepare('UPDATE feeds SET category_id = ? WHERE id = ?').run(categoryId(category), id);
  if (use_solver !== undefined) {
    db.prepare('UPDATE feeds SET use_solver = ?, last_error = NULL WHERE id = ?').run(use_solver ? 1 : 0, id);
    needRefresh = true;
  }
  if (scrape_mode !== undefined && ['auto', 'page', 'links'].includes(scrape_mode)) {
    db.prepare('UPDATE feeds SET scrape_mode = ?, last_error = NULL WHERE id = ?').run(scrape_mode, id);
    needRefresh = true;
  }

  if (feed_url) {
    const norm = normalizeUrl(feed_url);
    const isScrape = feed.kind === 'scrape';
    const newFeedUrl = isScrape ? 'scrape:' + norm : norm;
    const current = isScrape ? feed.source_url : feed.feed_url;
    if (norm !== current) {
      const dupe = db.prepare('SELECT id FROM feeds WHERE feed_url = ? AND id != ?').get(newFeedUrl, id);
      if (dupe) return res.status(409).json({ error: 'Another subscription already uses that URL.' });
      // New source: reset conditional-fetch caches and error, then re-fetch.
      db.prepare('UPDATE feeds SET feed_url = ?, source_url = ?, etag = NULL, last_modified = NULL, last_error = NULL WHERE id = ?')
        .run(newFeedUrl, isScrape ? norm : feed.source_url, id);
      needRefresh = true;
    }
  }

  let refresh = null;
  if (needRefresh) refresh = await refreshFeed(db.prepare('SELECT * FROM feeds WHERE id = ?').get(id));
  res.json({ ok: true, refresh });
}));

app.delete('/api/feeds/:id', (req, res) => {
  db.prepare('DELETE FROM feeds WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Bulk-unsubscribe by id (used by "remove all unreachable").
app.post('/api/feeds/bulk-delete', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((n) => Number.isInteger(n)) : [];
  if (!ids.length) return res.json({ removed: 0 });
  const info = db.prepare(`DELETE FROM feeds WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  res.json({ removed: info.changes });
});

// Rich feed + category listing for the settings panel.
app.get('/api/feeds/detail', (req, res) => {
  const feeds = db.prepare(`
    SELECT f.id, f.title, f.feed_url, f.site_url, f.kind, f.source_url, f.category_id, f.use_solver, f.scrape_mode,
           c.name AS category, f.last_error, f.last_fetched,
           (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id) AS total,
           (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND i.is_read = 0) AS unread,
           COALESCE(f.source_newest,
             (SELECT MAX(COALESCE(i.published_at, i.fetched_at)) FROM items i WHERE i.feed_id = f.id)) AS newest
    FROM feeds f LEFT JOIN categories c ON c.id = f.category_id
    ORDER BY (c.name IS NULL), c.name COLLATE NOCASE, f.title COLLATE NOCASE
  `).all();
  const categories = db.prepare(`
    SELECT c.id, c.name, (SELECT COUNT(*) FROM feeds f WHERE f.category_id = c.id) AS feeds
    FROM categories c ORDER BY c.name COLLATE NOCASE
  `).all();
  res.json({ feeds, categories });
});

app.post('/api/feeds/:id/refresh', wrap(async (req, res) => {
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(req.params.id);
  if (!feed) return res.status(404).json({ error: 'not found' });
  res.json(await refreshFeed(feed));
}));

// ---- Mark read/unread, star ----
app.post('/api/items/:id/read', (req, res) => {
  db.prepare('UPDATE items SET is_read = ? WHERE id = ?').run(req.body.read ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
app.post('/api/items/:id/star', (req, res) => {
  db.prepare('UPDATE items SET is_starred = ? WHERE id = ?').run(req.body.starred ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// Lazily fetch (and cache) the original article's lead image, for items whose
// own content has no image. NULL = not looked up, '' = looked up/none found.
app.get('/api/items/:id/image', wrap(async (req, res) => {
  const id = intParam(req.params.id, 0); // NaN would throw at bind time -> 500
  const it = db.prepare('SELECT id, link, image_url FROM items WHERE id = ?').get(id);
  if (!it) return res.status(404).json({ error: 'not found' });
  if (it.image_url !== null) return res.json({ image_url: it.image_url || null }); // cached
  if (!it.link) { db.prepare('UPDATE items SET image_url = ? WHERE id = ?').run('', id); return res.json({ image_url: null }); }
  let url = null;
  try { url = await fetchLeadImage(it.link); }
  catch { return res.json({ image_url: null }); } // transient error: leave uncached to retry later
  db.prepare('UPDATE items SET image_url = ? WHERE id = ?').run(url || '', id);
  res.json({ image_url: url || null });
}));

// Mark read, optionally scoped to a feed/category and/or an age cutoff.
// older_than: 'day' | 'week' | undefined (all).
app.post('/api/items/read-all', (req, res) => {
  const { feed_id, category_id, older_than } = req.body;
  const where = ['is_read = 0'];
  const params = [];
  if (feed_id) {
    where.push('feed_id = ?'); params.push(intParam(feed_id, 0));
  } else if (category_id) {
    where.push('feed_id IN (SELECT id FROM feeds WHERE category_id = ?)'); params.push(intParam(category_id, 0));
  }
  if (older_than === 'day') where.push("COALESCE(published_at, fetched_at) < datetime('now', '-1 day')");
  else if (older_than === 'week') where.push("COALESCE(published_at, fetched_at) < datetime('now', '-7 days')");
  const info = db.prepare(`UPDATE items SET is_read = 1 WHERE ${where.join(' AND ')}`).run(...params);
  res.json({ ok: true, marked: info.changes });
});

// ---- Categories ----
app.post('/api/categories', (req, res) => {
  const id = categoryId(req.body.name);
  res.json({ id });
});
app.delete('/api/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- App settings (key/value, with defaults) ----
const SETTINGS_DEFAULTS = { inactive_months: 9, autorefresh_seconds: 60, retention_days: 30 };
function getSettings() {
  const out = { ...SETTINGS_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    const n = Number(r.value);
    out[r.key] = r.value !== '' && !Number.isNaN(n) ? n : r.value;
  }
  return out;
}
// Delete read, non-saved items older than the configured retention window.
// Read Later (starred) items are always kept. retention_days <= 0 disables it.
function cleanupOldItems() {
  const days = Math.floor(Number(getSettings().retention_days));
  if (!days || days <= 0) return { deleted: 0 };
  const info = db.prepare(
    `DELETE FROM items
       WHERE is_read = 1 AND is_starred = 0
         AND COALESCE(published_at, fetched_at) < datetime('now', ?)`,
  ).run(`-${days} days`);
  return { deleted: info.changes };
}

app.get('/api/settings', (req, res) => res.json({ ...getSettings(), solver_configured: solverConfigured() }));
app.put('/api/settings', (req, res) => {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  // Only known settings keys — don't let arbitrary keys accumulate in the table.
  for (const [k, v] of Object.entries(req.body || {})) if (k in SETTINGS_DEFAULTS) up.run(k, String(v));
  if ('retention_days' in (req.body || {})) cleanupOldItems(); // apply the new policy right away
  res.json(getSettings());
});

// ---- Account / 2FA (all gated by the auth middleware above) ----
app.get('/api/auth/status', (req, res) =>
  res.json({ username: auth.getUsername(), totp_enabled: auth.totpEnabled(), recovery_remaining: auth.recoveryRemaining() }));
app.post('/api/auth/password', (req, res) => {
  const { current, next } = req.body || {};
  const r = auth.changePassword(current, next);
  // The signing secret rotates on success (kills all other sessions + trusted
  // browsers); re-issue a fresh session so THIS browser stays logged in.
  if (r.ok) setSession(req, res);
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/auth/totp/setup', (req, res) => res.json(auth.startTotpSetup()));
app.post('/api/auth/totp/enable', (req, res) => {
  const r = auth.confirmTotpSetup((req.body || {}).code);
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/auth/totp/disable', (req, res) => {
  const r = auth.disableTotp((req.body || {}).password);
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/auth/recovery', (req, res) => {
  const r = auth.regenerateRecovery((req.body || {}).password);
  res.status(r.ok ? 200 : 400).json(r);
});

// ---- Refresh now ----
app.post('/api/refresh', wrap(async (req, res) => res.json(await refreshAll())));

// ---- OPML ----
app.post('/api/opml/import', wrap((req, res) => {
  const xml = typeof req.body === 'string' ? req.body : req.body.xml;
  if (!xml) return res.status(400).json({ error: 'no OPML body' });
  res.json(importOpml(xml));
}));
app.get('/api/opml/export', (req, res) => {
  res.set('Content-Type', 'text/x-opml');
  res.set('Content-Disposition', 'attachment; filename="subscriptions.opml"');
  res.send(exportOpml());
});

function categoryId(name) {
  if (!name) return null;
  const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid;
}

// ---- Daily DB snapshot (enabled by READER_BACKUP_DIR) ----
// Writes a consistent, gzipped copy via VACUUM INTO, into fixed rotating slots:
// reader-mon..sun.db.gz (7 dailies) + reader-monthly.db.gz (refreshed on the
// 1st). Fixed names = fixed storage footprint; an external cron (rclone) copies
// the directory offsite to Backblaze B2.
const BACKUP_DIR = process.env.READER_BACKUP_DIR || '';
async function snapshotDb() {
  if (!BACKUP_DIR) return;
  const { createReadStream, createWriteStream } = await import('node:fs');
  const { rm, mkdir } = await import('node:fs/promises');
  const { createGzip } = await import('node:zlib');
  const { pipeline } = await import('node:stream/promises');
  await mkdir(BACKUP_DIR, { recursive: true });
  const tmp = join(BACKUP_DIR, `.snapshot-${process.pid}.db`);
  await rm(tmp, { force: true });                 // VACUUM INTO refuses to overwrite
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // consistent point-in-time copy, WAL-safe
  const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];
  const slots = [join(BACKUP_DIR, `reader-${day}.db.gz`)];
  if (new Date().getDate() === 1) slots.push(join(BACKUP_DIR, 'reader-monthly.db.gz'));
  for (const out of slots) await pipeline(createReadStream(tmp), createGzip({ level: 6 }), createWriteStream(out));
  await rm(tmp, { force: true });
  console.log(`[backup] snapshot -> ${slots.join(', ')}`);
}

app.listen(PORT, HOST, () => {
  console.log(`Vectorhome Reader running at http://${HOST}:${PORT}`);
  // Background auto-refresh.
  const tick = () => refreshAll().then((r) => console.log(`[refresh] ${r.feeds} feeds, ${r.added} new items`)).catch((e) => console.error('[refresh]', e.message));
  setTimeout(tick, 5000);
  setInterval(tick, REFRESH_MINUTES * 60 * 1000);

  // Daily retention cleanup of old read items, then a fresh DB snapshot.
  const cleanup = () => {
    try { const r = cleanupOldItems(); if (r.deleted) console.log(`[cleanup] removed ${r.deleted} old read items`); }
    catch (e) { console.error('[cleanup]', e.message); }
    snapshotDb().catch((e) => console.error('[backup]', e.message));
  };
  setTimeout(cleanup, 10000);
  setInterval(cleanup, 24 * 60 * 60 * 1000);
});
