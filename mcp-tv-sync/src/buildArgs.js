'use strict';

/** Canonical watchlist names, in sync-rotation order. Single source of truth. */
const WATCHLISTS = [
  'Smart Radar - BUY',
  'Smart Radar - WATCH',
  'Lean Radar - Breakouts',
  'Lean Radar - Near',
];

/**
 * Map tv_sync tool params to `npm run tv-sync -- <flags>` arguments.
 * Pure function. Returns an argv array (no shell quoting — spawn handles that).
 * @param {{dryRun?:boolean, replace?:boolean, headed?:boolean, watchlist?:string}} params
 * @returns {string[]}
 */
function buildArgs(params = {}) {
  const args = [];
  if (params.dryRun) args.push('--dry-run');
  if (params.replace) args.push('--replace');
  if (params.headed) args.push('--headed');
  if (params.watchlist != null && params.watchlist !== '') {
    if (!WATCHLISTS.includes(params.watchlist)) {
      throw new Error(`invalid watchlist: ${params.watchlist}`);
    }
    args.push('--watchlist', params.watchlist);
  }
  return args;
}

module.exports = { buildArgs, WATCHLISTS };
