// Turn an arbitrary URL into a usable feed.
//   1. If the URL is already an RSS/Atom/JSON feed -> use it directly.
//   2. Else parse the page for <link rel="alternate"> feed declarations.
//   3. Else guess a few common feed paths (/feed, /rss, ...).
//   4. Else fall back to scraping the page into a synthetic feed.
import * as cheerio from 'cheerio';
import Parser from 'rss-parser';
import { safeFetch, readCappedText } from './safefetch.js';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': UA() },
});

function UA() {
  return 'VectorhomeReader/1.0 (+https://github.com/; RSS reader)';
}

async function fetchText(url, { method = 'GET' } = {}) {
  const res = await safeFetch(url, {
    method,
    headers: { 'User-Agent': UA(), Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,*/*' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const contentType = res.headers.get('content-type') || '';
  const body = await readCappedText(res);
  return { body, contentType, finalUrl: res.url };
}

function looksLikeFeed(contentType, body) {
  if (/(rss|atom)\+xml|application\/xml|text\/xml/i.test(contentType)) return true;
  const head = body.slice(0, 1000).toLowerCase();
  return head.includes('<rss') || head.includes('<feed') || head.includes('<rdf:rdf');
}

// Try to parse `body` as a feed; return a normalized feed object or null.
async function tryParseFeed(url, body) {
  try {
    const parsed = await parser.parseString(body);
    return {
      feedUrl: url,
      kind: 'rss',
      title: parsed.title?.trim() || url,
      siteUrl: parsed.link || null,
    };
  } catch {
    return null;
  }
}

// Find <link rel="alternate" type="application/rss+xml"> declarations in HTML.
function findFeedLinks(baseUrl, html) {
  const $ = cheerio.load(html);
  const out = [];
  $('link[rel="alternate"], link[rel="feed"]').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    const href = $(el).attr('href');
    if (!href) return;
    if (type.includes('rss') || type.includes('atom') || type.includes('xml') || type.includes('json')) {
      out.push({
        url: new URL(href, baseUrl).href,
        title: $(el).attr('title') || null,
      });
    }
  });
  // de-dup by url
  const seen = new Set();
  return out.filter((l) => (seen.has(l.url) ? false : seen.add(l.url)));
}

const COMMON_PATHS = ['/feed', '/feed/', '/rss', '/rss.xml', '/atom.xml', '/feed.xml', '/index.xml', '/feeds/posts/default'];

/**
 * Discover one or more feed candidates for a URL.
 * Returns: { candidates: [{feedUrl, kind, title, siteUrl}], scrape: {sourceUrl, title} | null }
 */
export async function discover(inputUrl) {
  const url = normalizeUrl(inputUrl);
  const { body, contentType, finalUrl } = await fetchText(url);

  // 1. The URL is itself a feed.
  if (looksLikeFeed(contentType, body)) {
    const f = await tryParseFeed(finalUrl, body);
    if (f) return { candidates: [f], scrape: null };
  }

  // 2. Declared feed links in the page <head>.
  const declared = findFeedLinks(finalUrl, body);
  const candidates = [];
  for (const link of declared) {
    try {
      const { body: fb } = await fetchText(link.url);
      const f = await tryParseFeed(link.url, fb);
      if (f) {
        // Prefer the feed's own <title>; fall back to the page's link title.
        if ((!f.title || f.title === link.url) && link.title) f.title = link.title;
        candidates.push(f);
      }
    } catch {
      /* ignore unreachable declared feed */
    }
  }
  if (candidates.length) return { candidates, scrape: null };

  // 3. Guess common feed paths.
  const origin = new URL(finalUrl).origin;
  for (const p of COMMON_PATHS) {
    const guess = origin + p;
    try {
      const { body: gb, contentType: gct } = await fetchText(guess);
      if (!looksLikeFeed(gct, gb)) continue;
      const f = await tryParseFeed(guess, gb);
      if (f) {
        candidates.push(f);
        break;
      }
    } catch {
      /* path doesn't exist */
    }
  }
  if (candidates.length) return { candidates, scrape: null };

  // 4. Scrape fallback — no real feed found, synthesize one from page links.
  const $ = cheerio.load(body);
  const title = ($('meta[property="og:site_name"]').attr('content') || $('title').text() || finalUrl).trim();
  return { candidates: [], scrape: { sourceUrl: finalUrl, title } };
}

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function nodeAncestors(node) {
  const a = [];
  let c = node;
  while (c) { a.push(c); c = c.parent; }
  return a.reverse(); // root ... node
}

// Lowest common ancestor of a set of nodes (so all sections are included).
function lowestCommonAncestor(nodes) {
  let path = nodeAncestors(nodes[0]);
  for (let i = 1; i < nodes.length; i++) {
    const set = new Set(nodeAncestors(nodes[i]));
    let cut = 0;
    for (let j = 0; j < path.length; j++) { if (set.has(path[j])) cut = j; else break; }
    path = path.slice(0, cut + 1);
  }
  return path[path.length - 1];
}

// Extract the page's main content as a single article. Returns
// { item, textLen } or null. Used for content/newsletter pages.
function scrapeArticle($, base) {
  const ogTitle = $('meta[property="og:title"]').attr('content');
  const title = (ogTitle || $('title').first().text() || base).replace(/\s+/g, ' ').trim();
  const desc = $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') || null;

  // Choose the content root. Multi-section pages (newsletters, long posts) keep
  // their sections in sibling blocks, so use the lowest common ancestor of all
  // headings — that captures every section, not just the densest one. Pages with
  // a single topic fall back to the densest content container.
  const textLenOf = (el) => (el ? $(el).text().replace(/\s+/g, ' ').trim().length : 0);
  let contentEl = null;
  const heads = $('h1, h2, h3').toArray().filter((h) => $(h).text().trim().length > 3);
  if (heads.length >= 2) {
    contentEl = lowestCommonAncestor(heads);
    if (contentEl && (contentEl.type === 'root' || contentEl.tagName === 'html')) contentEl = $('body').get(0);
  }
  if (!contentEl) {
    const SEL = 'article, main, [class*="article-body"], [class*="entry-content"], [class*="post-content"], [class*="newsletter-main"], [class*="article"], [class*="content"], section';
    let best = null, bestLen = 0;
    $(SEL).each((_, e) => { const t = textLenOf(e); if (t > bestLen) { bestLen = t; best = e; } });
    contentEl = best && bestLen >= 200 ? best : $('body').get(0);
  }
  const contentHtml = contentEl ? $(contentEl).html() : null;
  const textLen = textLenOf(contentEl);
  if (!contentHtml || textLen < 120) return null;

  const pubRaw = $('meta[property="article:published_time"]').attr('content') ||
    $('time[datetime]').attr('datetime') || null;
  let published_at = null;
  if (pubRaw) { const d = new Date(pubRaw); if (!Number.isNaN(d.getTime())) published_at = d.toISOString(); }

  // Key the item on a hash of its content (not the title, which often embeds the
  // current date). The same edition therefore yields the same id and is NOT
  // recreated day after day; only an actual content change makes a new article.
  const editionKey = djb2(contentHtml) + '-' + contentHtml.length;
  const link = base.split('#')[0];
  return {
    item: {
      guid: link + '#' + editionKey,
      title: title.slice(0, 300),
      link,
      summary: desc ? desc.slice(0, 500) : null,
      content: contentHtml,
      published_at,
    },
    textLen,
  };
}

// Collect article-like links from a listing/index page.
function scrapeLinks($, base) {
  const origin = new URL(base).origin;
  const seen = new Set();
  const items = [];
  const push = (el) => {
    const $el = $(el);
    let href = ($el.attr('href') || '').trim();
    if (!href) return;
    if (/[[\]{}]/.test(href)) return;                      // unresolved template vars, e.g. [urlinfolettre]
    if (/^(javascript:|mailto:|tel:|#)/i.test(href)) return;
    let abs;
    try { abs = new URL(href, base).href; } catch { return; }
    if (!/^https?:/i.test(abs)) return;
    const clean = abs.split('#')[0];
    if (seen.has(clean)) return;
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (text.length < 15) return;
    if (/^(home|menu|search|log ?in|subscribe|s'abonner|sign in|skip to|partager|share)/i.test(text)) return;
    seen.add(clean);
    items.push({ guid: clean, title: text.slice(0, 300), link: clean, summary: null, content: null, published_at: null });
  };
  $('article a[href], main a[href], [class*="article"] a[href], [class*="post"] a[href]').each((_, el) => push(el));
  if (items.length < 5) $('h1 a[href], h2 a[href], h3 a[href]').each((_, el) => push(el));
  if (items.length === 0) {
    $('a[href]').each((_, el) => { try { if (new URL($(el).attr('href'), base).origin === origin) push(el); } catch { /* skip */ } });
  }
  return items.slice(0, 60);
}

/**
 * Scrape a page into feed items.
 *   mode 'page'  -> the page itself becomes one article (content extraction)
 *   mode 'links' -> collect article-like links from a listing page
 *   mode 'auto'  -> pick: a single article when the page is prose-dominant,
 *                   otherwise a link list.
 * Returns array of { guid, title, link, summary, content, published_at }.
 */
export async function scrape(sourceUrl, mode = 'auto') {
  const { body, finalUrl } = await fetchText(sourceUrl);
  const $ = cheerio.load(body);
  $('script, style, noscript, nav, header, footer, form, aside, iframe').remove();

  if (mode === 'page') {
    const a = scrapeArticle($, finalUrl);
    return a ? [a.item] : [];
  }
  if (mode === 'links') return scrapeLinks($, finalUrl);

  // auto — link COUNT alone misclassifies newsletters (they're full of
  // "read more"/share links). The robust signal is link DOMINANCE: on a true
  // index page most of the visible text IS link text (measured ~0.4-0.9),
  // while newsletter/content pages are prose-dominant (~0.05-0.1).
  const links = scrapeLinks($, finalUrl);
  const a = scrapeArticle($, finalUrl);
  const totalText = $('body').text().replace(/\s+/g, ' ').trim().length;
  const anchorText = $('a').text().replace(/\s+/g, ' ').trim().length;
  const linkDominance = totalText ? anchorText / totalText : 1;
  if (a && a.textLen >= 600 && (links.length < 8 || linkDominance < 0.3)) return [a.item];
  if (links.length >= 3) return links;
  return a ? [a.item] : links;
}

// Fetch an article page and return its lead image URL (or null). Prefers the
// page's declared social image (og:image/twitter:image) — that's the "main
// image after the title" — then falls back to the first real content image.
export async function fetchLeadImage(pageUrl) {
  const { body, finalUrl } = await fetchText(pageUrl);
  const $ = cheerio.load(body);
  const declared = $('meta[property="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content')
    || $('meta[property="twitter:image"]').attr('content')
    || $('meta[itemprop="image"]').attr('content');
  const abs = (s) => { try { return new URL(s, finalUrl).href; } catch { return null; } };
  if (declared) return abs(declared);

  $('script, style, noscript, header, nav, footer, aside').remove();
  let found = null;
  $('article img[src], main img[src], [class*="content"] img[src], [class*="article"] img[src], img[src]').each((_, el) => {
    if (found) return;
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (!src || /sprite|logo|icon|avatar|blank|spacer|pixel|1x1|tracking|doubleclick/i.test(src)) return;
    found = abs(src);
  });
  return found;
}

export function normalizeUrl(u) {
  let s = (u || '').trim();
  if (!s) throw new Error('Empty URL');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}
