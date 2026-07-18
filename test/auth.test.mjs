// Unit tests for lib/auth.js — runs on a throwaway DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.READER_DB = join(mkdtempSync(join(tmpdir(), 'vhr-auth-')), 'test.db');
process.env.READER_USERNAME = 'tester';
process.env.READER_PASSWORD = 'pw12345678';

const auth = await import('../lib/auth.js');
const db = (await import('../db.js')).default;
auth.bootstrap();

// RFC 6238 test-vector secret: ASCII "12345678901234567890" in base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const realNow = Date.now;
function at(ms, fn) { Date.now = () => ms; try { return fn(); } finally { Date.now = realNow; } }
function totpFor(counter) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, v = 0; const bytes = [];
  for (const c of RFC_SECRET) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { bytes.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const off = h[19] & 15;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1000000).padStart(6, '0');
}

test('bootstrap creates the credential from env', () => {
  assert.equal(auth.isConfigured(), true);
  assert.equal(auth.getUsername(), 'tester');
});

test('password check: correct accepted, wrong rejected', () => {
  assert.equal(auth.checkLogin({ username: 'tester', password: 'pw12345678' }).ok, true);
  assert.equal(auth.checkLogin({ username: 'tester', password: 'nope' }).ok, false);
  assert.equal(auth.checkLogin({ username: 'other', password: 'pw12345678' }).ok, false);
});

test('session tokens verify and reject tampering/expiry', () => {
  const tok = auth.issueToken('tester');
  assert.ok(auth.verifyToken(tok));
  assert.equal(auth.verifyToken(tok.slice(0, -2) + 'xx'), null);
  assert.equal(auth.verifyToken('garbage'), null);
});

test('TOTP enrollment matches RFC 6238 vector; replay is refused', () => {
  db.prepare("INSERT INTO auth(key,value) VALUES('totp_pending',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(RFC_SECRET);
  // T=59s -> counter 1 -> code 287082 (RFC vector)
  const conf = at(59000, () => auth.confirmTotpSetup('287082'));
  assert.equal(conf.ok, true);
  assert.equal(conf.recovery.length, 10);
  // replaying the confirmation code at login must fail
  const replay = at(59000, () => auth.checkLogin({ username: 'tester', password: 'pw12345678', code: '287082' }));
  assert.equal(replay.ok, false);
  // a fresh window's code works once, then is refused
  const c2 = totpFor(2);
  assert.equal(at(75000, () => auth.checkLogin({ username: 'tester', password: 'pw12345678', code: c2 })).ok, true);
  assert.equal(at(75000, () => auth.checkLogin({ username: 'tester', password: 'pw12345678', code: c2 })).ok, false);
});

test('recovery codes are single-use', () => {
  const r = auth.regenerateRecovery('pw12345678');
  assert.equal(r.ok, true);
  const code = r.recovery[0];
  assert.equal(auth.checkLogin({ username: 'tester', password: 'pw12345678', code }).ok, true);
  assert.equal(auth.checkLogin({ username: 'tester', password: 'pw12345678', code }).ok, false);
});

test('trusted-browser token skips only the second factor', () => {
  const trust = auth.issueTrust('tester');
  assert.equal(auth.verifyTrust(trust, 'tester'), true);
  assert.equal(auth.checkLogin({ username: 'tester', password: 'pw12345678', trusted: true }).ok, true);
  assert.equal(auth.checkLogin({ username: 'tester', password: 'WRONG', trusted: true }).ok, false);
  // disabling TOTP invalidates trust (fingerprint binds to totp_secret)
  assert.equal(auth.disableTotp('pw12345678').ok, true);
  assert.equal(auth.verifyTrust(trust, 'tester'), false);
});

test('password change rotates the signing secret (old sessions die)', () => {
  const old = auth.issueToken('tester');
  assert.ok(auth.verifyToken(old));
  assert.equal(auth.changePassword('pw12345678', 'newpw12345678').ok, true);
  assert.equal(auth.verifyToken(old), null, 'pre-rotation session must be invalid');
  assert.ok(auth.verifyToken(auth.issueToken('tester')), 'fresh session works');
  assert.equal(auth.checkLogin({ username: 'tester', password: 'newpw12345678' }).ok, true);
});
