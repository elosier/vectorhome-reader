// Fetch feeds (real RSS/Atom or scraped pages) and persist new items.
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import db from '../db.js';
import { scrape, normText } from './discover.js';
import { safeFetch, readCappedText } from './safefetch.js';

const UA = 'VectorhomeReader/1.0 (+https://github.com/; RSS reader)';
const parser = new Parser({ timeout: 20000, headers: { 'User-Agent': UA } });

// Optional FlareSolverr endpoint for feeds behind a Cloudflare browser challenge.
const SOLVER_URL = process.env.SOLVER_URL || '';
export const solverConfigured = () => !!SOLVER_URL;

const insertStmt = db.prepare(`
  INSERT INTO items (feed_id, guid, title, link, author, summary, content, published_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(feed_id, guid) DO NOTHING
`);

// For scraped page-articles: refresh the body when it changes, keeping the
// FIRST-seen title (the page re-bakes the fetch-day date into its title, so we
// don't want the stored title drifting day to day) and is_read / is_starred.
const upsertStmt = db.prepare(`
  INSERT INTO items (feed_id, guid, title, link, author, summary, content, published_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(feed_id, guid) DO UPDATE SET
    summary = excluded.summary,
    content = excluded.content,
    published_at = COALESCE(excluded.published_at, items.published_at)
  WHERE items.content IS NOT excluded.content
`);
// Recent page-articles of a feed, for near-duplicate detection.
const recentScraped = db.prepare(
  'SELECT id, content FROM items WHERE feed_id = ? AND content IS NOT NULL ORDER BY fetched_at DESC LIMIT 6',
);
// Refresh an existing item's body in place (keeps title/is_read/is_starred).
const updateBodyStmt = db.prepare(
  "UPDATE items SET summary = ?, content = ?, published_at = COALESCE(?, published_at) WHERE id = ?",
);

// Word-set Jaccard similarity of two normalized strings (order/count-insensitive).
function jaccard(a, b) {
  const A = new Set(a.split(' ')); const B = new Set(b.split(' '));
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
// Two page-articles are the "same edition" if their normalized prose is
// identical or near-identical — catches a re-baked title-date or a minor edit,
// while genuinely different editions (different prose) score low.
export function isNearDuplicate(normA, normB) {
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  const m = Math.max(normA.length, normB.length);
  if (Math.abs(normA.length - normB.length) / m > 0.10) return false; // >10% size gap → different
  return jaccard(normA, normB) > 0.9;
}

// Coerce any feed value into something SQLite can bind (string or null).
// Atom feeds often yield objects for author/link/content, e.g. { name }, { href }.
function text(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ') || null;
  if (typeof v === 'object') return text(v.name ?? v._ ?? v.href ?? v.url ?? v.label ?? v['#text'] ?? null);
  return String(v);
}

function normItem(it) {
  const guid = text(it.guid || it.id || it.link || it.title);
  if (!guid) return null;
  const rawPub = it.isoDate || it.pubDate || it.published || it.updated || null;
  let published_at = null;
  if (rawPub) { const d = new Date(rawPub); if (!Number.isNaN(d.getTime())) published_at = d.toISOString(); }
  const title = text(it.title);
  return {
    guid,
    title: (title && title.trim()) || '(untitled)',
    link: text(it.link),
    author: text(it.creator || it.author),
    summary: (text(it.contentSnippet || it.summary) || '').slice(0, 2000) || null,
    content: text(it['content:encoded'] || it.content || it.summary),
    published_at,
  };
}

function insertItems(feedId, items) {
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const r of items) {
      if (!r) continue;
      const info = insertStmt.run(
        feedId, r.guid, r.title, r.link, r.author, r.summary, r.content, r.published_at,
      );
      if (info.changes > 0) added++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

const isFeedXml = (s) => !!s && /<(\?xml|rss|feed|rdf:RDF)/i.test(s) && !/just a moment|__cf_chl/i.test(s);

// A browser renders an XML feed inside an HTML viewer; recover the raw source.
function extractFeedXml(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  // Older Chromium: a hidden source div.
  const wk = $('#webkit-xml-viewer-source-xml').html();
  if (isFeedXml(wk)) return wk;
  // Newer Chromium: entity-encoded XML inside <pre>; .text() decodes the entities.
  const pre = $('pre').first();
  if (pre.length) { const t = pre.text(); if (isFeedXml(t)) return t; }
  // Already a raw feed document.
  if (isFeedXml(html)) return html;
  return '';
}

// Retention cutoff (ISO date) for skipping old items on refresh; null = disabled.
function retentionCutoff() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'retention_days'").get();
  const days = row ? Number(row.value) : 30;
  if (!days || days <= 0) return null;
  return new Date(Date.now() - days * 86400000).toISOString();
}
// Drop items older than the cutoff; items with no date are kept (treated as new).
function withinCutoff(items, cutoff) {
  if (!cutoff) return items;
  return items.filter((it) => it && (!it.published_at || it.published_at >= cutoff));
}

// Newest published date advertised by the feed itself, regardless of whether we
// store the item (a low-frequency feed past the retention window still has a real
// "last published" date — feed status is derived from this, not from our DB).
function maxPublished(items) {
  let max = null;
  for (const it of items || []) {
    if (it && it.published_at && (!max || it.published_at > max)) max = it.published_at;
  }
  return max;
}

// Ask FlareSolverr to load the URL in a real browser and solve the challenge.
async function fetchViaSolver(url) {
  if (!SOLVER_URL) throw new Error("This feed is set to use a challenge solver, but SOLVER_URL isn't configured on the server.");
  const r = await fetch(SOLVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 }),
    signal: AbortSignal.timeout(75000),
  });
  if (!r.ok) throw new Error(`Solver HTTP ${r.status}`);
  const data = await r.json();
  if (data.status !== 'ok' || !data.solution) throw new Error('Solver: ' + (data.message || data.status || 'failed'));
  return data.solution; // { response, cookies:[{name,value}], userAgent }
}

async function refreshViaSolver(feed, cutoff) {
  const sol = await fetchViaSolver(feed.feed_url);
  // The solver already rendered the page — pull the feed XML straight out of it.
  let body = extractFeedXml(sol.response || '');
  // Fallback: reuse the solved clearance cookies for a clean direct fetch.
  if (!isFeedXml(body)) {
    const cookieHeader = (sol.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
    if (cookieHeader) {
      try {
        const r = await safeFetch(feed.feed_url, {
          headers: { 'User-Agent': sol.userAgent || UA, Cookie: cookieHeader, Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
          signal: AbortSignal.timeout(45000),
        });
        if (r.ok) { const t = await readCappedText(r); if (isFeedXml(t)) body = t; }
      } catch { /* ignore */ }
    }
  }
  if (!isFeedXml(body)) throw new Error('Solver could not produce a parseable feed');
  const parsed = await parser.parseString(body);
  const norm = (parsed.items || []).map(normItem);
  const added = insertItems(feed.id, withinCutoff(norm, cutoff));
  return { added, title: parsed.title, siteUrl: parsed.link, newest: maxPublished(norm) };
}

async function refreshRss(feed, cutoff) {
  if (feed.use_solver) return refreshViaSolver(feed, cutoff);
  const headers = { 'User-Agent': UA };
  // Use conditional requests only once we've captured the feed's newest date.
  // Otherwise a 304 (no body) means we never see the items and can't record it —
  // which would leave a feed whose backlog is all past the retention window
  // permanently showing "no items" even though it advertises a real date.
  if (feed.source_newest) {
    if (feed.etag) headers['If-None-Match'] = feed.etag;
    if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;
  }

  const res = await safeFetch(feed.feed_url, {
    headers,
    signal: AbortSignal.timeout(45000),
  });

  if (res.status === 304) return { added: 0, etag: feed.etag, lastModified: feed.last_modified };
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if ((res.status === 403 || res.status === 503) &&
        /just a moment|__cf_chl|challenge-platform|cf-mitigated|attention required/i.test(errBody)) {
      throw new Error('Blocked by a Cloudflare browser challenge — a plain fetch cannot pass it.');
    }
    throw new Error(`HTTP ${res.status}`);
  }

  const body = await readCappedText(res);
  const parsed = await parser.parseString(body);
  const norm = (parsed.items || []).map(normItem);
  const added = insertItems(feed.id, withinCutoff(norm, cutoff));
  return {
    added,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    title: parsed.title,
    siteUrl: parsed.link,
    newest: maxPublished(norm),
  };
}

async function refreshScrape(feed, cutoff) {
  const all = await scrape(feed.source_url || feed.feed_url, feed.scrape_mode || 'auto');
  const items = withinCutoff(all, cutoff);
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const i of items) {
      if (!i.content) {
        // Link item (listing page): insert-or-ignore on its own URL.
        const info = insertStmt.run(feed.id, i.guid, i.title, i.link, null, i.summary, null, i.published_at);
        if (info.changes > 0) added++;
        continue;
      }
      // Page-article: if the same edition already exists (re-fetched with a
      // re-baked title-date or minor drift), refresh it in place — don't create
      // a new entry. Only genuinely new prose becomes a new article.
      const norm = normText(i.content);
      const dup = recentScraped.all(feed.id).find((r) => isNearDuplicate(norm, normText(r.content)));
      if (dup) {
        updateBodyStmt.run(i.summary, i.content, i.published_at, dup.id);
        continue;
      }
      const info = upsertStmt.run(feed.id, i.guid, i.title, i.link, null, i.summary, i.content, i.published_at);
      if (info.changes > 0) added++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { added, newest: maxPublished(all) };
}

const updateOk = db.prepare(`
  UPDATE feeds SET last_fetched = datetime('now'), last_error = NULL, fail_count = 0,
    etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified)
  WHERE id = ?
`);
const updateErr = db.prepare(`
  UPDATE feeds SET last_fetched = datetime('now'), last_error = ?, fail_count = fail_count + 1 WHERE id = ?
`);

// Timeouts / dropped connections are usually a slow origin on a cold cache
// (e.g. Radio-Canada can take 10-30 s, then answers instantly). Worth one retry.
const isTransient = (err) => {
  const s = String((err && (err.name + ' ' + err.message)) || err);
  return /timeout|aborted|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(s);
};

export async function refreshFeed(feed) {
  try {
    // First-ever fetch imports the full backlog; later fetches skip past-retention
    // items so deleted/old articles don't get re-imported and resurrected.
    const firstFetch = !feed.first_fetched_at;
    const cutoff = firstFetch ? null : retentionCutoff();
    const run = () => (feed.kind === 'scrape' ? refreshScrape(feed, cutoff) : refreshRss(feed, cutoff));
    let r;
    try { r = await run(); }
    catch (e) { if (!isTransient(e)) throw e; r = await run(); } // one retry on transient failures
    updateOk.run(r.etag || null, r.lastModified || null, feed.id);
    // Record the feed's own newest published date (status is derived from this,
    // not from stored items). Only ever move it forward.
    if (r.newest) {
      db.prepare('UPDATE feeds SET source_newest = ? WHERE id = ? AND (source_newest IS NULL OR source_newest < ?)')
        .run(r.newest, feed.id, r.newest);
    }
    if (firstFetch) db.prepare("UPDATE feeds SET first_fetched_at = datetime('now') WHERE id = ?").run(feed.id);
    return { ok: true, added: r.added };
  } catch (err) {
    updateErr.run(String(err.message || err).slice(0, 500), feed.id);
    return { ok: false, error: String(err.message || err) };
  }
}

export async function refreshAll() {
  const feeds = db.prepare('SELECT * FROM feeds').all();
  const results = [];
  // Refresh with a small concurrency limit to be polite.
  const queue = [...feeds];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const feed = queue.shift();
      results.push({ id: feed.id, ...(await refreshFeed(feed)) });
    }
  });
  await Promise.all(workers);
  const added = results.reduce((s, r) => s + (r.added || 0), 0);
  return { feeds: results.length, added };
}

export { insertItems, normItem };
