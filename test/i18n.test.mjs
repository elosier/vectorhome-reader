// i18n dictionary invariants: EN and FR must stay at key parity, and every
// t() lookup used in app.js must resolve to a real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'public/app.js'), 'utf8');

const frStart = src.indexOf('\n  fr: {');
const frEnd = src.indexOf('\n  },\n};', frStart);
const enBlock = src.slice(src.indexOf('\n  en: {'), frStart);
const frBlock = src.slice(frStart, frEnd);
const keysOf = (b) => new Set([...b.matchAll(/^\s{4}'([^'\\]+)':/gm)].map((m) => m[1]));
const en = keysOf(enBlock);
const fr = keysOf(frBlock);

test('EN and FR dictionaries have identical key sets', () => {
  assert.deepEqual([...en].filter((k) => !fr.has(k)), [], 'keys missing in FR');
  assert.deepEqual([...fr].filter((k) => !en.has(k)), [], 'keys missing in EN');
  assert.ok(en.size > 100, `sane dictionary size (got ${en.size})`);
});

test("every t('key') used in code exists in the EN dictionary", () => {
  const used = new Set([...src.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]))
  // dynamic lookups built at runtime:
  const dynamicPrefixes = ['security.err.', 'theme.'];
  const missing = [...used].filter((k) => !en.has(k) && !dynamicPrefixes.some((p) => k.startsWith(p)));
  assert.deepEqual(missing, []);
});
