const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs, WATCHLISTS } = require('../src/buildArgs.js');

test('no params -> empty arg list (full additive sync)', () => {
  assert.deepEqual(buildArgs({}), []);
});

test('dryRun adds --dry-run', () => {
  assert.deepEqual(buildArgs({ dryRun: true }), ['--dry-run']);
});

test('replace adds --replace', () => {
  assert.deepEqual(buildArgs({ replace: true }), ['--replace']);
});

test('headed adds --headed', () => {
  assert.deepEqual(buildArgs({ headed: true }), ['--headed']);
});

test('watchlist adds --watchlist NAME as two args (no shell quoting)', () => {
  assert.deepEqual(
    buildArgs({ watchlist: 'Lean Radar - Near' }),
    ['--watchlist', 'Lean Radar - Near']
  );
});

test('flags combine in stable order: dry-run, replace, headed, watchlist', () => {
  assert.deepEqual(
    buildArgs({ dryRun: true, replace: true, headed: true, watchlist: 'Smart Radar - BUY' }),
    ['--dry-run', '--replace', '--headed', '--watchlist', 'Smart Radar - BUY']
  );
});

test('null or empty watchlist is treated as absent (runs all lists)', () => {
  assert.deepEqual(buildArgs({ watchlist: null }), []);
  assert.deepEqual(buildArgs({ watchlist: '' }), []);
});

test('invalid watchlist throws', () => {
  assert.throws(() => buildArgs({ watchlist: 'Nope' }), /invalid watchlist/i);
});

test('WATCHLISTS lists the four canonical lists', () => {
  assert.deepEqual(WATCHLISTS, [
    'Smart Radar - BUY',
    'Smart Radar - WATCH',
    'Lean Radar - Breakouts',
    'Lean Radar - Near',
  ]);
});

const {
  buildReadArgs, buildAddArgs, buildRemoveArgs,
} = require('../src/buildArgs.js');

test('buildArgs appends --file when file set', () => {
  assert.deepEqual(buildArgs({ file: '/tmp/x.txt' }), ['--file', '/tmp/x.txt']);
});

test('buildArgs appends --prune-after-days when set', () => {
  assert.deepEqual(buildArgs({ pruneAfterDays: 21 }), ['--prune-after-days', '21']);
});

test('buildArgs rejects non-integer pruneAfterDays', () => {
  assert.throws(() => buildArgs({ pruneAfterDays: -1 }), /invalid pruneAfterDays/i);
  assert.throws(() => buildArgs({ pruneAfterDays: 1.5 }), /invalid pruneAfterDays/i);
});

test('buildReadArgs maps to --read NAME', () => {
  assert.deepEqual(buildReadArgs({ watchlist: 'Lean Radar - Near' }), ['--read', 'Lean Radar - Near']);
});

test('buildReadArgs rejects invalid/missing watchlist', () => {
  assert.throws(() => buildReadArgs({ watchlist: 'Nope' }), /invalid watchlist/i);
  assert.throws(() => buildReadArgs({}), /invalid watchlist/i);
});

test('buildAddArgs maps to --add NAME --symbols CSV (trimmed, upper)', () => {
  assert.deepEqual(
    buildAddArgs({ watchlist: 'Smart Radar - WATCH', symbols: [' nvda ', 'tsla'] }),
    ['--add', 'Smart Radar - WATCH', '--symbols', 'NVDA,TSLA']
  );
});

test('buildRemoveArgs maps to --remove NAME --symbols CSV', () => {
  assert.deepEqual(
    buildRemoveArgs({ watchlist: 'Lean Radar - Near', symbols: ['CAT'] }),
    ['--remove', 'Lean Radar - Near', '--symbols', 'CAT']
  );
});

test('add/remove reject empty symbols', () => {
  assert.throws(() => buildAddArgs({ watchlist: 'Lean Radar - Near', symbols: [] }), /non-empty/i);
  assert.throws(() => buildRemoveArgs({ watchlist: 'Lean Radar - Near', symbols: ['  '] }), /non-empty/i);
});
