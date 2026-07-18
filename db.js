// SQLite layer using Node's built-in node:sqlite (no native build required).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.READER_DB || new URL('./data/reader.db', import.meta.url).pathname;
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    position  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS feeds (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    feed_url      TEXT NOT NULL UNIQUE,
    site_url      TEXT,
    category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    favicon       TEXT,
    kind          TEXT NOT NULL DEFAULT 'rss',   -- 'rss' | 'scrape'
    source_url    TEXT,                          -- original page the user pasted (for scrape feeds)
    etag          TEXT,
    last_modified TEXT,
    last_fetched  TEXT,
    last_error    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id      INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid         TEXT NOT NULL,
    title        TEXT,
    link         TEXT,
    author       TEXT,
    summary      TEXT,
    content      TEXT,
    published_at TEXT,
    fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
    is_read      INTEGER NOT NULL DEFAULT 0,
    is_starred   INTEGER NOT NULL DEFAULT 0,
    UNIQUE(feed_id, guid)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_feed     ON items(feed_id);
  CREATE INDEX IF NOT EXISTS idx_items_read     ON items(is_read);
  CREATE INDEX IF NOT EXISTS idx_items_pub      ON items(published_at);
  CREATE INDEX IF NOT EXISTS idx_items_starred  ON items(is_starred);
`);

// --- Migrations (additive, safe to run every boot) ---
const feedCols = db.prepare('PRAGMA table_info(feeds)').all().map((c) => c.name);
if (!feedCols.includes('use_solver')) {
  db.exec('ALTER TABLE feeds ADD COLUMN use_solver INTEGER NOT NULL DEFAULT 0');
}
if (!feedCols.includes('scrape_mode')) {
  db.exec("ALTER TABLE feeds ADD COLUMN scrape_mode TEXT NOT NULL DEFAULT 'auto'");
}
if (!feedCols.includes('first_fetched_at')) {
  // NULL = never fetched (first fetch imports full backlog). Existing feeds have
  // already had their first fetch, so mark them done — they get the age-skip now.
  db.exec('ALTER TABLE feeds ADD COLUMN first_fetched_at TEXT');
  db.exec("UPDATE feeds SET first_fetched_at = datetime('now')");
}
if (!feedCols.includes('source_newest')) {
  // Newest published date the feed itself advertises (set on each refresh, before
  // the retention filter). Feed status/staleness is derived from this so a
  // low-frequency feed whose backlog was filtered out still reports a real date.
  // Seed from stored items so existing feeds have a value before their next fetch.
  db.exec('ALTER TABLE feeds ADD COLUMN source_newest TEXT');
  db.exec(`UPDATE feeds SET source_newest =
    (SELECT MAX(COALESCE(i.published_at, i.fetched_at)) FROM items i WHERE i.feed_id = feeds.id)`);
}
const itemCols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
if (!itemCols.includes('image_url')) {
  // NULL = not looked up yet, '' = looked up, none found, otherwise the image URL.
  db.exec('ALTER TABLE items ADD COLUMN image_url TEXT');
}

// --- Full-text search (FTS5, external-content on items) ---
// Kept in sync by triggers; queried via /api/search. Content is stored HTML —
// tag names add a little index noise, which is acceptable for this use.
const hasFts = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items_fts'").get();
if (!hasFts) {
  db.exec(`
    CREATE VIRTUAL TABLE items_fts USING fts5(
      title, content,
      content='items', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
      INSERT INTO items_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;
    CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
    END;
    CREATE TRIGGER items_fts_au AFTER UPDATE OF title, content ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO items_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;
  `);
  // One-time index of everything already stored.
  db.exec("INSERT INTO items_fts(items_fts) VALUES ('rebuild')");
}

export default db;
