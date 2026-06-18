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
