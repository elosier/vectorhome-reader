// Hardened outbound fetch for user/feed-supplied URLs.
//  - Blocks the cloud-metadata endpoint (checked on every redirect hop, since
//    global fetch would otherwise auto-follow a redirect straight to it).
//  - Caps how much of a response body we read into memory.
// LAN/private addresses are intentionally allowed (self-hosted feeds).

export const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

// Some sites' CDNs/WAFs (e.g. Le Devoir's Fastly) denylist bot-style User-Agents
// and answer 403. When that happens we retry once as a common browser before
// giving up — the URL is one the user explicitly chose to subscribe to.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Link-local cloud-metadata endpoints (AWS/GCP/Azure/etc.). Never a real feed.
const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'fd00:ec2::254',
]);
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return BLOCKED_HOSTS.has(h);
}

// Follow redirects manually, vetting the host on every hop.
async function followRedirects(url, options, maxRedirects) {
  let current = String(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new Error('Invalid URL'); }
    if (isBlockedHost(u.hostname)) throw new Error('Refused: cloud metadata endpoint is not allowed');
    const res = await fetch(current, { ...options, redirect: 'manual' });
    // (304 is in the 3xx range but carries no Location — it falls through.)
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (loc) { current = new URL(loc, current).href; continue; }
    return res;
  }
  throw new Error('Too many redirects');
}

// fetch() that vets the URL (and each redirect target) before connecting, and
// retries a 403 once with a browser User-Agent (UA-based bot blocks are common).
export async function safeFetch(url, options = {}, maxRedirects = 5) {
  const res = await followRedirects(url, options, maxRedirects);
  if (res.status === 403) {
    try { await res.body?.cancel(); } catch { /* ignore */ } // free the discarded 403
    const headers = { ...(options.headers || {}), 'User-Agent': BROWSER_UA };
    return followRedirects(url, { ...options, headers }, maxRedirects);
  }
  return res;
}

// Read a response body as text, aborting if it exceeds `max` bytes.
export async function readCappedText(res, max = MAX_BYTES) {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error(`Response too large (> ${Math.round(max / 1048576)} MB)`); }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(concat(chunks, total));
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}
