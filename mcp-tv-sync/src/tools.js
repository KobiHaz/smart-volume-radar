'use strict';
const {
  buildArgs, buildReadArgs, buildAddArgs, buildRemoveArgs, buildScreenshotArgs, buildSessionStatusArgs, WATCHLISTS,
} = require('./buildArgs.js');

const WL_REQUIRED = { type: 'string', enum: WATCHLISTS, description: 'Which watchlist to operate on.' };
const SYMBOLS = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  description: 'Ticker symbols, e.g. ["NVDA","TSLA"] or exchange-qualified ["TASE:TDRN"].',
};

const TOOL_DEFINITIONS = [
  {
    name: 'tv_sync',
    description:
      'Sync Smart Volume Radar watchlists to TradingView via the repo\'s `npm run tv-sync`. ' +
      'Identical to a manual run. Use dryRun to preview the add/remove diff without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: 'Read + diff only, no writes (--dry-run).', default: false },
        replace: { type: 'boolean', description: 'Remove any TV symbol not in the target list (--replace).', default: false },
        headed: { type: 'boolean', description: 'Visible browser window for debugging (--headed).', default: false },
        watchlist: { type: 'string', enum: WATCHLISTS, description: 'Sync only this one list instead of all four.' },
        file: { type: 'string', description: 'Custom target symbol file (--file); pairs with watchlist.' },
        pruneAfterDays: { type: 'integer', minimum: 0, description: 'Override the staleness window in days (--prune-after-days; default 14).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tv_read_watchlist',
    description: 'Read the current symbols in one TradingView watchlist (read-only, no writes).',
    inputSchema: {
      type: 'object',
      properties: { watchlist: WL_REQUIRED },
      required: ['watchlist'],
      additionalProperties: false,
    },
  },
  {
    name: 'tv_add_symbols',
    description: 'Add specific symbols to one TradingView watchlist (creates the list if missing).',
    inputSchema: {
      type: 'object',
      properties: { watchlist: WL_REQUIRED, symbols: SYMBOLS },
      required: ['watchlist', 'symbols'],
      additionalProperties: false,
    },
  },
  {
    name: 'tv_remove_symbols',
    description: 'Remove specific symbols from one TradingView watchlist.',
    inputSchema: {
      type: 'object',
      properties: { watchlist: WL_REQUIRED, symbols: SYMBOLS },
      required: ['watchlist', 'symbols'],
      additionalProperties: false,
    },
  },
  {
    name: 'tv_screenshot',
    description:
      'Open a symbol on TradingView (your saved chart layout) and return a screenshot of the chart as an image. ' +
      'Use to visually inspect a stock\'s chart.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'TradingView symbol, e.g. "NVDA", "AAPL", or exchange-qualified "TASE:RMLI".' },
        interval: { type: 'string', description: 'Optional single timeframe, e.g. "1D","1W","4H","60". Defaults to the saved layout\'s timeframe.' },
        intervals: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Optional multiple timeframes, e.g. ["1D","1W"]. Returns one chart image per timeframe (max 4). Takes precedence over `interval`.' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'tv_deep_dive',
    description:
      'Deep dive on a ticker: returns its TradingView chart image(s) PLUS a text block of its ' +
      'current Smart/Lean Radar state (price, RVOL, action, momentum criteria, champion score, ' +
      'trade plan, sector rank). Use to analyze a stock visually and technically together.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'TradingView symbol / ticker, e.g. "NVDA".' },
        intervals: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Optional timeframes, e.g. ["1D","1W"] (max 4).' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'tv_session_status',
    description:
      'Check whether the local TradingView session (saved Chromium profile) is still logged in. ' +
      'Returns { loggedIn, profileDir }. If loggedIn is false, run `npm run tv-sync -- --login` once to re-authenticate.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// name -> how to build its flags and what kind of result it returns.
const TOOL_SPECS = {
  tv_sync: { build: buildArgs, kind: 'sync' },
  tv_read_watchlist: { build: buildReadArgs, kind: 'granular' },
  tv_add_symbols: { build: buildAddArgs, kind: 'granular' },
  tv_remove_symbols: { build: buildRemoveArgs, kind: 'granular' },
  tv_screenshot: { build: buildScreenshotArgs, kind: 'image' },
  tv_deep_dive: { build: buildScreenshotArgs, kind: 'deepdive' },
  tv_session_status: { build: buildSessionStatusArgs, kind: 'granular' },
};

module.exports = { TOOL_DEFINITIONS, TOOL_SPECS };
