'use strict';

/** Canonical watchlist names, in sync-rotation order. Single source of truth. */
const WATCHLISTS = [
  'Smart Radar - BUY',
  'Smart Radar - WATCH',
  'Lean Radar - Breakouts',
  'Lean Radar - Near',
];

function assertWatchlist(name) {
  if (!WATCHLISTS.includes(name)) throw new Error(`invalid watchlist: ${name}`);
}

/** Normalize a symbols array → trimmed, upper-cased, non-empty. Throws if empty. */
function normalizeSymbols(symbols) {
  const cleaned = (Array.isArray(symbols) ? symbols : [])
    .map((s) => String(s).trim().toUpperCase())
    .filter((s) => s.length > 0);
  if (cleaned.length === 0) throw new Error('symbols must be a non-empty array');
  return cleaned;
}

/**
 * Map tv_sync params to `npm run tv-sync -- <flags>`. Pure. Returns argv array.
 * @param {{dryRun?:boolean, replace?:boolean, headed?:boolean, watchlist?:string,
 *          file?:string, pruneAfterDays?:number}} params
 */
function buildArgs(params = {}) {
  const args = [];
  if (params.dryRun) args.push('--dry-run');
  if (params.replace) args.push('--replace');
  if (params.headed) args.push('--headed');
  if (params.watchlist != null && params.watchlist !== '') {
    assertWatchlist(params.watchlist);
    args.push('--watchlist', params.watchlist);
  }
  if (params.file != null && params.file !== '') {
    args.push('--file', String(params.file));
  }
  if (params.pruneAfterDays != null) {
    const n = Number(params.pruneAfterDays);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`invalid pruneAfterDays: ${params.pruneAfterDays}`);
    }
    args.push('--prune-after-days', String(n));
  }
  return args;
}

function buildReadArgs(params = {}) {
  assertWatchlist(params.watchlist);
  return ['--read', params.watchlist];
}

function buildAddArgs(params = {}) {
  assertWatchlist(params.watchlist);
  return ['--add', params.watchlist, '--symbols', normalizeSymbols(params.symbols).join(',')];
}

function buildRemoveArgs(params = {}) {
  assertWatchlist(params.watchlist);
  return ['--remove', params.watchlist, '--symbols', normalizeSymbols(params.symbols).join(',')];
}

module.exports = { buildArgs, buildReadArgs, buildAddArgs, buildRemoveArgs, WATCHLISTS };
