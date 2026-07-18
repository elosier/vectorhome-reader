// HTTP integration tests: spawns the real server on a random port with a
// throwaway DB and drives it over fetch. Never touches live data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3900 + Math.floor(Math.random() * 90);
const B = `http://127.0.0.1:${PORT}`;
let child;
let cookie = '';
let dbPath = '';

const jar = (res) => {
  const set = res.headers.getSetCookie?.() || [];
  for (const c of set) if (c.startsWith('vh_session=')) cookie = c.split(';')[0];
};
const req = (path, opts = {}) => fetch(B + path, {
  redirect: 'manual',
  ...opts,
  headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(opts.headers || {}) },
});

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vhr-http-'));
  dbPath = join(dir, 'test.db');
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      READER_DB: dbPath,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      READER_USERNAME: 'tester',
      READER_PASSWORD: 'pw12345678',
      LOGIN_MAX_PER_IP: '4',       // small caps so the rate-limit test is fast
      LOGIN_MAX_GLOBAL: '20',
      REFRESH_MINUTES: '9999',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(B + '/login'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => child?.kill());

test('unauthenticated: pages redirect, API 401s, open paths pass', async () => {
  assert.equal((await fetch(B + '/', { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(B + '/api/state')).status, 401);
  assert.equal((await fetch(B + '/login')).status, 200);
  assert.equal((await fetch(B + '/manifest.webmanifest')).status, 200);
  assert.equal((await fetch(B + '/sw.js')).status, 200);
  const r = await fetch(B + '/api/auth/required');
  assert.deepEqual(await r.json(), { totp: false });
});

test('login: wrong rejected, correct sets a working session', async () => {
  const bad = await req('/api/login', { method: 'POST', body: JSON.stringify({ username: 'tester', password: 'no' }) });
  assert.equal(bad.status, 401);
  const ok = await req('/api/login', { method: 'POST', body: JSON.stringify({ username: 'tester', password: 'pw12345678' }) });
  assert.equal(ok.status, 200);
  jar(ok);
  assert.ok(cookie.includes('vh_session='));
  assert.equal((await req('/api/state')).status, 200);
});

test('items pagination: has_more + keyset `before` paging + FTS search', async () => {
  // Seed a feed + 12 dated items straight into the throwaway DB (WAL allows a
  // second process). The server's FTS triggers index them on insert.
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(dbPath);
  d.prepare("INSERT INTO feeds (title, feed_url, kind) VALUES ('T', 'https://t.example/feed', 'rss')").run();
  const fid = d.prepare('SELECT id FROM feeds').get().id;
  const ins = d.prepare('INSERT INTO items (feed_id, guid, title, link, content, published_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= 12; i++) {
    ins.run(fid, 'g' + i, `Article ${i} zebra`, 'https://t.example/' + i, `<p>body ${i} quokka</p>`, `2026-07-${String(i).padStart(2, '0')}T12:00:00.000Z`);
  }
  d.close();

  // page 1: newest 5 of 12, more remain
  let r = await (await req('/api/items?limit=5')).json();
  assert.equal(r.items.length, 5);
  assert.equal(r.has_more, true);
  assert.equal(r.items[0].title, 'Article 12 zebra'); // DESC by date
  // keyset page 2: strictly older than the last shown
  const last = r.items[r.items.length - 1];
  r = await (await req(`/api/items?limit=5&before=${encodeURIComponent(last.published_at)}`)).json();
  assert.equal(r.items.length, 5);
  assert.equal(r.items[0].title, 'Article 7 zebra');
  // final page
  const last2 = r.items[r.items.length - 1];
  r = await (await req(`/api/items?limit=5&before=${encodeURIComponent(last2.published_at)}`)).json();
  assert.equal(r.items.length, 2);
  assert.equal(r.has_more, false);

  // FTS search: prefix match + rank ordering, has_more shape
  r = await (await req('/api/search?q=quok')).json();
  assert.equal(r.items.length, 12);
  assert.equal(r.has_more, false);
  r = await (await req('/api/search?q=quokka&limit=5')).json();
  assert.equal(r.items.length, 5);
  assert.equal(r.has_more, true);
  // malformed FTS input must not 500
  const res = await req('/api/search?q=' + encodeURIComponent('"( AND OR *'));
  assert.equal(res.status, 200);
});

test('settings: unknown keys are dropped', async () => {
  const r = await req('/api/settings', { method: 'PUT', body: JSON.stringify({ retention_days: 42, evil: 'x' }) });
  const body = await r.json();
  assert.equal(body.retention_days, 42);
  assert.equal('evil' in body, false);
});

test('login rate limit: caps failed attempts per IP, 429 after', async () => {
  cookie = '';
  let last = 0;
  for (let i = 0; i < 5; i++) {
    const r = await req('/api/login', { method: 'POST', body: JSON.stringify({ username: 'tester', password: 'wrong' }) });
    last = r.status;
  }
  assert.equal(last, 429);
  const evenCorrect = await req('/api/login', { method: 'POST', body: JSON.stringify({ username: 'tester', password: 'pw12345678' }) });
  assert.equal(evenCorrect.status, 429, 'lockout applies to correct creds too');
});
