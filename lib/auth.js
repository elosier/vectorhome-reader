// Single-user authentication: password (scrypt) + signed session cookie, with
// optional TOTP 2FA (RFC 6238) and single-use recovery codes. Dependency-free
// (node:crypto only). Secrets live in their own `auth` table — never exposed via
// /api/settings.
import crypto from 'node:crypto';
import db from '../db.js';

db.exec(`CREATE TABLE IF NOT EXISTS auth (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
const getRow = db.prepare('SELECT value FROM auth WHERE key = ?');
const setRow = db.prepare('INSERT INTO auth (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const get = (k) => { const r = getRow.get(k); return r ? r.value : null; };
const set = (k, v) => setRow.run(k, v == null ? '' : String(v));

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);

// --- password (scrypt) ---
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltB64, keyB64] = stored.split('$');
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const got = crypto.scryptSync(String(pw), salt, expected.length);
    return crypto.timingSafeEqual(expected, got);
  } catch { return false; }
}

// --- session signing secret (persisted so cookies survive restarts) ---
function secret() {
  let s = get('secret');
  if (!s) { s = crypto.randomBytes(32).toString('base64'); set('secret', s); }
  return s;
}
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(data) { return crypto.createHmac('sha256', secret()).update(data).digest('base64url'); }

export function issueToken(username) {
  const payload = b64url(JSON.stringify({ u: username, iat: Date.now(), exp: Date.now() + SESSION_DAYS * 864e5 }));
  return `${payload}.${sign(payload)}`;
}
export function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, mac] = token.split('.');
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  let data; try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data || typeof data.exp !== 'number' || Date.now() > data.exp) return null;
  return data;
}

// --- "remember this browser" trusted-device token (skips TOTP for TRUST_DAYS) ---
const TRUST_DAYS = Number(process.env.READER_TRUST_DAYS || 60);
export const trustDays = () => TRUST_DAYS;
// Bind the trust token to the current TOTP secret, so disabling/re-enrolling 2FA
// (which changes the secret) automatically invalidates every trusted browser.
function totpFingerprint() { return crypto.createHash('sha256').update(get('totp_secret') || '').digest('hex').slice(0, 16); }
export function issueTrust(username) {
  const payload = b64url(JSON.stringify({ u: username, typ: 't', tf: totpFingerprint(), exp: Date.now() + TRUST_DAYS * 864e5 }));
  return `${payload}.${sign(payload)}`;
}
export function verifyTrust(token, username) {
  if (!token || token.indexOf('.') < 0) return false;
  const [payload, mac] = token.split('.');
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  let d; try { d = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return false; }
  if (!d || d.typ !== 't' || typeof d.exp !== 'number' || Date.now() > d.exp) return false;
  if (d.tf !== totpFingerprint()) return false;          // 2FA secret changed → not trusted
  if (username && d.u !== username) return false;
  return true;
}

// --- base32 (RFC 4648, no padding) for TOTP secrets ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// --- TOTP (RFC 6238, SHA-1, 6 digits, 30s step) ---
function totpAt(secretB32, counter) {
  const key = base32decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = (h.readUInt32BE(off) & 0x7fffffff) % 1000000;
  return String(bin).padStart(6, '0');
}
// Returns the matched time-step counter, or null. The caller can persist the
// accepted counter to refuse replays of the same (or an older) code.
function verifyTOTP(secretB32, token) {
  const code = String(token || '').replace(/\D/g, '');
  if (code.length !== 6) return null;
  const counter = Math.floor(Date.now() / 30000);
  for (const w of [-1, 0, 1]) {
    const expected = totpAt(secretB32, counter + w);
    if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) return counter + w;
  }
  return null;
}
// Anti-replay: accept a TOTP only if its counter is newer than the last accepted one.
function verifyTOTPOnce(secretB32, token) {
  const c = verifyTOTP(secretB32, token);
  if (c == null) return false;
  const last = Number(get('totp_last') || 0);
  if (c <= last) return false; // same or older window already used
  set('totp_last', String(c));
  return true;
}

// --- recovery codes (single-use, stored hashed) ---
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function generateRecoveryCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = base32encode(crypto.randomBytes(7)).slice(0, 10); // 10 base32 chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  set('recovery', JSON.stringify(codes.map((c) => sha256(normCode(c)))));
  return codes; // plaintext, shown once
}
function useRecoveryCode(code) {
  let hashes; try { hashes = JSON.parse(get('recovery') || '[]'); } catch { hashes = []; }
  const h = sha256(normCode(code));
  const idx = hashes.indexOf(h);
  if (idx < 0) return false;
  hashes.splice(idx, 1);
  set('recovery', JSON.stringify(hashes));
  return true;
}
export function recoveryRemaining() {
  try { return JSON.parse(get('recovery') || '[]').length; } catch { return 0; }
}

// --- public API ---
export function isConfigured() { return !!get('pwhash'); }
export function totpEnabled() { return get('totp_enabled') === '1'; }
export function getUsername() { return get('username') || 'admin'; }

// Bootstrap the initial credential from env on first run (READER_USERNAME / READER_PASSWORD).
export function bootstrap() {
  secret(); // ensure a signing secret exists
  if (!isConfigured() && process.env.READER_PASSWORD) {
    set('username', process.env.READER_USERNAME || 'admin');
    set('pwhash', hashPassword(process.env.READER_PASSWORD));
    console.log('[auth] bootstrapped credential from environment');
  }
}

// Verify a login attempt. Returns { ok, totp_required?, error? }.
export function checkLogin({ username, password, code, trusted }) {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  const okUser = String(username || '') === getUsername();
  const okPass = verifyPassword(password, get('pwhash'));
  if (!okUser || !okPass) return { ok: false, error: 'bad_credentials' };
  if (totpEnabled() && !trusted) {
    if (!code) return { ok: false, totp_required: true };
    const sec = get('totp_secret');
    const valid = (sec && verifyTOTPOnce(sec, code)) || useRecoveryCode(code);
    if (!valid) return { ok: false, totp_required: true, error: 'bad_code' };
  }
  return { ok: true };
}

export function changePassword(current, next) {
  if (!verifyPassword(current, get('pwhash'))) return { ok: false, error: 'bad_current' };
  if (!next || String(next).length < 8) return { ok: false, error: 'too_short' };
  set('pwhash', hashPassword(next));
  // Rotate the signing secret: every existing session AND trusted-browser token
  // is invalidated everywhere. The caller re-issues a fresh session cookie for
  // the browser that made the change, so the user stays logged in there.
  set('secret', crypto.randomBytes(32).toString('base64'));
  return { ok: true };
}

// Begin TOTP enrollment: generate a pending secret + otpauth URI (not yet enabled).
export function startTotpSetup() {
  const sec = base32encode(crypto.randomBytes(20)); // 160-bit secret
  set('totp_pending', sec);
  const label = encodeURIComponent(`Vectorhome Reader:${getUsername()}`);
  const uri = `otpauth://totp/${label}?secret=${sec}&issuer=Vectorhome%20Reader&algorithm=SHA1&digits=6&period=30`;
  return { secret: sec, uri };
}
// Confirm enrollment with a code from the authenticator; on success enable + return recovery codes.
export function confirmTotpSetup(code) {
  const pending = get('totp_pending');
  if (!pending) return { ok: false, error: 'no_setup' };
  const c = verifyTOTP(pending, code);
  if (c == null) return { ok: false, error: 'bad_code' };
  set('totp_secret', pending);
  set('totp_pending', '');
  set('totp_enabled', '1');
  set('totp_last', String(c)); // the confirmation code can't be replayed at login
  const recovery = generateRecoveryCodes();
  return { ok: true, recovery };
}
export function disableTotp(password) {
  if (!verifyPassword(password, get('pwhash'))) return { ok: false, error: 'bad_password' };
  set('totp_enabled', '0');
  set('totp_secret', '');
  set('totp_pending', '');
  set('recovery', '[]');
  return { ok: true };
}
export function regenerateRecovery(password) {
  if (!verifyPassword(password, get('pwhash'))) return { ok: false, error: 'bad_password' };
  if (!totpEnabled()) return { ok: false, error: 'not_enabled' };
  return { ok: true, recovery: generateRecoveryCodes() };
}
