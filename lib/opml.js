// OPML import and export. Folders (outlines containing outlines) become categories.
import * as cheerio from 'cheerio';
import db from '../db.js';

const getCat = db.prepare('SELECT id FROM categories WHERE name = ?');
const insCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
const insFeed = db.prepare(`
  INSERT INTO feeds (title, feed_url, site_url, category_id, kind)
  VALUES (?, ?, ?, ?, 'rss')
  ON CONFLICT(feed_url) DO UPDATE SET
    title = excluded.title,
    category_id = COALESCE(excluded.category_id, feeds.category_id)
`);

function categoryId(name) {
  if (!name) return null;
  const existing = getCat.get(name);
  if (existing) return existing.id;
  return insCat.run(name).lastInsertRowid;
}

/**
 * Parse OPML XML and insert feeds. Returns { feeds, categories }.
 */
export function importOpml(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  let feedCount = 0;
  const cats = new Set();

  const walk = (node, categoryName) => {
    $(node)
      .children('outline')
      .each((_, el) => {
        const $el = $(el);
        const xmlUrl = $el.attr('xmlUrl') || $el.attr('xmlurl');
        const title = $el.attr('title') || $el.attr('text') || xmlUrl;
        // Only accept http(s) feed URLs — never store javascript:/file:/data: etc.
        if (xmlUrl && /^https?:\/\//i.test(xmlUrl.trim())) {
          const catId = categoryId(categoryName);
          if (categoryName) cats.add(categoryName);
          insFeed.run(title, xmlUrl, $el.attr('htmlUrl') || $el.attr('htmlurl') || null, catId);
          feedCount++;
        } else {
          // A container outline => a folder/category.
          const folder = $el.attr('title') || $el.attr('text') || categoryName;
          walk(el, folder);
        }
      });
  };

  db.exec('BEGIN');
  try {
    walk($('body').get(0) || $.root().get(0), null);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { feeds: feedCount, categories: cats.size };
}

/**
 * Export all feeds, grouped by category, as an OPML 2.0 document.
 */
export function exportOpml() {
  const cats = db.prepare('SELECT id, name FROM categories ORDER BY name').all();
  const feeds = db.prepare('SELECT title, feed_url, site_url, category_id FROM feeds ORDER BY title').all();
  const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const feedLine = (f) =>
    `      <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.feed_url)}"${f.site_url ? ` htmlUrl="${esc(f.site_url)}"` : ''}/>`;

  let body = '';
  for (const c of cats) {
    const inCat = feeds.filter((f) => f.category_id === c.id);
    if (!inCat.length) continue;
    body += `    <outline text="${esc(c.name)}" title="${esc(c.name)}">\n`;
    body += inCat.map(feedLine).join('\n') + '\n';
    body += `    </outline>\n`;
  }
  const uncategorized = feeds.filter((f) => !f.category_id);
  for (const f of uncategorized) body += feedLine(f).replace(/^ {6}/, '    ') + '\n';

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Vectorhome Reader subscriptions</title></head>
  <body>
${body}  </body>
</opml>
`;
}
