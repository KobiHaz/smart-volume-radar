# tv_screenshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `tv_screenshot` MCP tool that opens TradingView at a symbol on the user's saved layout, screenshots it, and returns the PNG to Claude as an image.

**Architecture:** Script owns Playwright; MCP shells out. New `--screenshot SYMBOL [--interval CODE]` script mode navigates to `/chart/?symbol=&interval=` (saved layout, deterministic), screenshots to a temp PNG, and prints its path as JSON. The MCP's `tv_screenshot` tool reads that PNG and returns it as MCP image content. Generalizes `TOOL_SPECS` from a `granular` boolean to a `kind` of `sync`/`granular`/`image`.

**Tech Stack:** Node.js 24 (CommonJS), `@modelcontextprotocol/sdk` ^1.29, `node --test`; the script is TypeScript via `tsx` with Playwright.

Repo root: `~/smart-volume-radar-engine`. Branch: `feat/tv-screenshot`.

---

## File Structure

```
mcp-tv-sync/
  src/buildArgs.js        # MODIFY: add buildScreenshotArgs
  src/tools.js            # MODIFY: add tv_screenshot def; TOOL_SPECS granular:bool -> kind:string
  index.js                # MODIFY: dispatch on spec.kind; image kind returns PNG as image content
  test/buildArgs.test.js  # MODIFY: buildScreenshotArgs tests
scripts/sync-tv-watchlist.ts  # MODIFY: --screenshot mode (tvInterval + runScreenshot + branch)
```

---

## Task 1: `buildScreenshotArgs` (TDD)

**Files:**
- Test: `mcp-tv-sync/test/buildArgs.test.js`
- Modify: `mcp-tv-sync/src/buildArgs.js`

- [ ] **Step 1: Append failing tests**

Append to `mcp-tv-sync/test/buildArgs.test.js`:

```js
const { buildScreenshotArgs } = require('../src/buildArgs.js');

test('buildScreenshotArgs maps symbol to --screenshot', () => {
  assert.deepEqual(buildScreenshotArgs({ symbol: 'NVDA' }), ['--screenshot', 'NVDA']);
});

test('buildScreenshotArgs appends --interval when set', () => {
  assert.deepEqual(
    buildScreenshotArgs({ symbol: 'NVDA', interval: '1W' }),
    ['--screenshot', 'NVDA', '--interval', '1W']
  );
});

test('buildScreenshotArgs trims symbol and omits empty interval', () => {
  assert.deepEqual(buildScreenshotArgs({ symbol: '  AAPL ', interval: '' }), ['--screenshot', 'AAPL']);
});

test('buildScreenshotArgs throws on empty/missing symbol', () => {
  assert.throws(() => buildScreenshotArgs({ symbol: '   ' }), /symbol is required/i);
  assert.throws(() => buildScreenshotArgs({}), /symbol is required/i);
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd ~/smart-volume-radar-engine/mcp-tv-sync && npm test`
Expected: FAIL — `buildScreenshotArgs is not a function`.

- [ ] **Step 3: Add the builder + export**

In `mcp-tv-sync/src/buildArgs.js`, add this function just above the `module.exports` line:

```js
function buildScreenshotArgs(params = {}) {
  const symbol = params.symbol == null ? '' : String(params.symbol).trim();
  if (symbol === '') throw new Error('symbol is required');
  const args = ['--screenshot', symbol];
  if (params.interval != null && params.interval !== '') {
    args.push('--interval', String(params.interval));
  }
  return args;
}
```

Then change the export line from:

```js
module.exports = { buildArgs, buildReadArgs, buildAddArgs, buildRemoveArgs, WATCHLISTS };
```

to:

```js
module.exports = { buildArgs, buildReadArgs, buildAddArgs, buildRemoveArgs, buildScreenshotArgs, WATCHLISTS };
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd ~/smart-volume-radar-engine/mcp-tv-sync && npm test`
Expected: PASS — the existing tests plus the 4 new ones (21 total).

- [ ] **Step 5: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/src/buildArgs.js mcp-tv-sync/test/buildArgs.test.js
git commit -m "feat(tv-sync-mcp): buildScreenshotArgs for tv_screenshot tool"
```

---

## Task 2: `--screenshot` mode in the script

**Files:**
- Modify: `scripts/sync-tv-watchlist.ts`

No automated test (Playwright); verified by Task 4.

- [ ] **Step 1: Add CLI parsing**

Find this line (added in v2, around line 89):

```ts
const GRANULAR_MODE = !!(READ_LIST || ADD_LIST || REMOVE_LIST);
```

Insert immediately AFTER it:

```ts
// Screenshot mode (used by the tv_screenshot MCP tool): open one symbol on the
// saved chart layout, capture a PNG, print its path as JSON.
const SCREENSHOT_SYMBOL = arg('screenshot', '');
const SCREENSHOT_INTERVAL = arg('interval', '');
const SCREENSHOT_MODE = !!SCREENSHOT_SYMBOL;
```

- [ ] **Step 2: Add the interval mapper + screenshot handler**

Find this exact line (the granular handler comment block ends just above the Main banner; in v2 `runGranular` was placed right before it):

```ts
// ─── Main ───────────────────────────────────────────────────────────
async function main() {
```

Insert the following ABOVE that `// ─── Main ───` comment line:

```ts
// ─── Screenshot mode (--screenshot SYMBOL [--interval CODE]) ─────────
// Map friendly interval forms to TradingView interval codes. Unknown values
// pass through unchanged. "1M" is intentionally NOT mapped (ambiguous: monthly
// is "M", one-minute is "1").
function tvInterval(raw: string): string {
    const s = raw.trim().toUpperCase();
    const map: Record<string, string> = {
        '1D': 'D', D: 'D', DAY: 'D', DAILY: 'D',
        '1W': 'W', W: 'W', WEEK: 'W', WEEKLY: 'W',
        M: 'M', MONTH: 'M', MONTHLY: 'M',
        '1H': '60', '60': '60', '60M': '60',
        '4H': '240', '240': '240', '2H': '120', '120': '120',
        '30': '30', '15': '15', '5': '5', '1': '1',
    };
    return map[s] ?? s;
}

// Assumes `page` is already logged in (caller runs navigation + login check
// first). Navigates to the symbol on the saved layout, screenshots to a temp
// PNG, and prints one JSON object to stdout.
async function runScreenshot(page: Page): Promise<number> {
    let url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(SCREENSHOT_SYMBOL)}`;
    if (SCREENSHOT_INTERVAL) url += `&interval=${encodeURIComponent(tvInterval(SCREENSHOT_INTERVAL))}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    await dismissPopups(page);
    const safe = SCREENSHOT_SYMBOL.replace(/[^a-zA-Z0-9]/g, '_');
    const out = path.join(os.tmpdir(), `svr-tv-shot-${safe}-${Date.now()}.png`);
    await page.screenshot({ path: out, fullPage: false });
    log(`📸 Screenshot saved: ${out}`);
    console.log(JSON.stringify({
        mode: 'screenshot',
        symbol: SCREENSHOT_SYMBOL,
        interval: SCREENSHOT_INTERVAL || null,
        path: out,
    }));
    return 0;
}

```

- [ ] **Step 3: Wire the screenshot branch into `main()`**

Find this block (the v2 granular branch, followed by the tasks array, around line 945):

```ts
        if (GRANULAR_MODE) {
            let code = 1;
            try {
                code = await runGranular(page);
            } finally {
                await context.close().catch(() => {});
                await browser?.close().catch(() => {});
            }
            process.exit(code);
        }

        const tasks: SyncTarget[] = SINGLE_LIST_MODE
```

Insert the screenshot branch BETWEEN the granular branch's closing `}` and the `const tasks` line:

```ts
        if (GRANULAR_MODE) {
            let code = 1;
            try {
                code = await runGranular(page);
            } finally {
                await context.close().catch(() => {});
                await browser?.close().catch(() => {});
            }
            process.exit(code);
        }

        if (SCREENSHOT_MODE) {
            let code = 1;
            try {
                code = await runScreenshot(page);
            } finally {
                await context.close().catch(() => {});
                await browser?.close().catch(() => {});
            }
            process.exit(code);
        }

        const tasks: SyncTarget[] = SINGLE_LIST_MODE
```

- [ ] **Step 4: Verify it compiles + produces a PNG (live, read-only)**

Run:
```bash
cd ~/smart-volume-radar-engine
npm run tv-sync -- --screenshot "NVDA" 2>/dev/null
```
Expected: one JSON line on stdout like
`{"mode":"screenshot","symbol":"NVDA","interval":null,"path":"/var/folders/.../svr-tv-shot-NVDA-<ts>.png"}`
Then confirm the file exists and is a non-trivial PNG:
```bash
ls -l "$(npm run tv-sync -- --screenshot NVDA 2>/dev/null | tail -1 | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d.toString().trim()).path))')"
```
Expected: a PNG file, tens-to-hundreds of KB. (This is a read-only browser nav + screenshot; no writes to any watchlist.)

- [ ] **Step 5: Commit**

```bash
cd ~/smart-volume-radar-engine
git add scripts/sync-tv-watchlist.ts
git commit -m "feat(tv-sync): --screenshot mode captures a symbol's chart to a temp PNG"
```

---

## Task 3: MCP `tv_screenshot` tool (image content)

**Files:**
- Modify: `mcp-tv-sync/src/tools.js`
- Modify: `mcp-tv-sync/index.js`

- [ ] **Step 1: Update `mcp-tv-sync/src/tools.js`**

Replace the entire contents of `mcp-tv-sync/src/tools.js` with:

```js
'use strict';
const {
  buildArgs, buildReadArgs, buildAddArgs, buildRemoveArgs, buildScreenshotArgs, WATCHLISTS,
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
        interval: { type: 'string', description: 'Optional timeframe, e.g. "1D","1W","4H","60". Defaults to the saved layout\'s timeframe.' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
];

// name -> how to build its flags and what kind of result it returns.
const TOOL_SPECS = {
  tv_sync: { build: buildArgs, kind: 'sync' },
  tv_read_watchlist: { build: buildReadArgs, kind: 'granular' },
  tv_add_symbols: { build: buildAddArgs, kind: 'granular' },
  tv_remove_symbols: { build: buildRemoveArgs, kind: 'granular' },
  tv_screenshot: { build: buildScreenshotArgs, kind: 'image' },
};

module.exports = { TOOL_DEFINITIONS, TOOL_SPECS };
```

- [ ] **Step 2: Update the dispatch in `mcp-tv-sync/index.js`**

Find this block (the v2 granular branch through the end of the tv_sync return):

```js
  if (spec.granular) {
    const parsed = result.timedOut ? null : parseGranularResult(result.stdout);
    if (parsed === null) {
      const why = result.timedOut ? `timed out after ${minutes} min` : 'could not parse JSON result';
      return {
        isError: true,
        content: [{ type: 'text', text: `${request.params.name} failed (${why}). flags: [${flags.join(' ')}]\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}` }],
      };
    }
    const failedAll =
      (Array.isArray(parsed.added) && parsed.added.length === 0 && Array.isArray(parsed.failed) && parsed.failed.length > 0) ||
      (Array.isArray(parsed.removed) && parsed.removed.length === 0 && Array.isArray(parsed.notFound) && parsed.notFound.length > 0);
    return {
      isError: result.exitCode !== 0 || parsed.error != null || failedAll,
      content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
    };
  }

  // tv_sync — full/single sync summary.
```

Replace that whole block with (adds the `image` kind; granular logic unchanged but keyed on `spec.kind`):

```js
  if (spec.kind === 'granular') {
    const parsed = result.timedOut ? null : parseGranularResult(result.stdout);
    if (parsed === null) {
      const why = result.timedOut ? `timed out after ${minutes} min` : 'could not parse JSON result';
      return {
        isError: true,
        content: [{ type: 'text', text: `${request.params.name} failed (${why}). flags: [${flags.join(' ')}]\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}` }],
      };
    }
    const failedAll =
      (Array.isArray(parsed.added) && parsed.added.length === 0 && Array.isArray(parsed.failed) && parsed.failed.length > 0) ||
      (Array.isArray(parsed.removed) && parsed.removed.length === 0 && Array.isArray(parsed.notFound) && parsed.notFound.length > 0);
    return {
      isError: result.exitCode !== 0 || parsed.error != null || failedAll,
      content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
    };
  }

  if (spec.kind === 'image') {
    const parsed = result.timedOut ? null : parseGranularResult(result.stdout);
    const failMsg = (why) => ({
      isError: true,
      content: [{ type: 'text', text: `${request.params.name} failed (${why}). flags: [${flags.join(' ')}]\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}` }],
    });
    if (result.timedOut) return failMsg(`timed out after ${minutes} min`);
    if (parsed === null || parsed.error != null || !parsed.path) {
      return failMsg(parsed && parsed.error ? parsed.error : 'no screenshot path in result');
    }
    let data;
    try {
      data = fs.readFileSync(parsed.path).toString('base64');
    } catch (err) {
      return failMsg(`could not read screenshot file ${parsed.path}: ${err.message}`);
    }
    const caption = `TradingView ${parsed.symbol}${parsed.interval ? ' @ ' + parsed.interval : ''} — ${parsed.path}`;
    return {
      isError: result.exitCode !== 0,
      content: [
        { type: 'image', data, mimeType: 'image/png' },
        { type: 'text', text: caption },
      ],
    };
  }

  // tv_sync — full/single sync summary.
```

- [ ] **Step 3: Unit tests green + server lists 5 tools**

Run:
```bash
cd ~/smart-volume-radar-engine/mcp-tv-sync
npm test
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node index.js
```
Expected: `npm test` passes (21 tests); tools/list returns five tools including `tv_screenshot`. Do NOT call any tool here.

- [ ] **Step 4: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/src/tools.js mcp-tv-sync/index.js
git commit -m "feat(tv-sync-mcp): tv_screenshot tool returning chart PNG as image content"
```

---

## Task 4: Integration verification (manual)

Requires a Claude reload so `tv_screenshot` loads. Acceptance gate.

- [ ] **Step 1: Reload Claude Code** so the updated server (5 tools) is loaded.

- [ ] **Step 2: Default-timeframe screenshot**

Call `tv_screenshot({ symbol: "NVDA" })`.
Expected: Claude receives an actual image — an NVDA TradingView chart on the saved
layout, with the user's indicators visible. Claude states what it sees to confirm
the image arrived and is readable. If indicators are MISSING, note it: the
`/chart/?symbol=` URL did not preserve the saved layout → switch to the fallback
(load `/chart/`, set symbol via symbol-search) and re-test.

- [ ] **Step 3: Interval override**

Call `tv_screenshot({ symbol: "AAPL", interval: "1W" })`.
Expected: a weekly AAPL chart image. Confirm the timeframe changed vs. the default.

- [ ] **Step 4: Report results** to the user (including whether saved indicators showed). No commit (verification only).

---

## Self-Review notes
- **Spec coverage:** `--screenshot` script mode via URL params (Task 2) ✓; tvInterval mapping incl. "1M" left ambiguous-unmapped (Task 2) ✓; temp-PNG + JSON path, not base64-over-stdout (Task 2 runScreenshot) ✓; `buildScreenshotArgs` pure + unit-tested (Task 1) ✓; `tv_screenshot` tool, symbol required / interval optional (Task 3 tools.js) ✓; TOOL_SPECS granular-bool → kind-string (Task 3) ✓; MCP returns image content from the PNG file (Task 3 index.js image branch) ✓; error handling for timeout / missing path / unreadable file (Task 3) ✓; reuse of existing browser setup + navigation + login check, no Playwright in MCP (Task 2 branch placement) ✓; manual integration incl. indicator-preservation check + fallback (Task 4) ✓.
- **Type/name consistency:** `buildScreenshotArgs` exported by buildArgs.js (Task 1), imported by tools.js (Task 3); JSON shape `{mode,symbol,interval,path}` emitted by runScreenshot (Task 2) and consumed by index.js image branch (Task 3); `spec.kind` set in tools.js (Task 3) and switched on in index.js (Task 3) — all four existing tools updated from `granular` bool to `kind` string in the same step.
- **Out of scope (unchanged):** multi-timeframe batch, element-crop, annotation, symbol-validity detection, CI mode.
```

