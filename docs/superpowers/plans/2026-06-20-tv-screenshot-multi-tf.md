# tv_screenshot multi-timeframe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `tv_screenshot` capture one symbol across several timeframes in a single call, returning one chart image per timeframe.

**Architecture:** Script owns Playwright; MCP shells out. The script's screenshot output is unified to a `shots` array (1 entry for single/default, N for `--intervals`). `buildScreenshotArgs` gains an `intervals` array; the MCP image handler returns one image+caption block per shot. Capped at 4 timeframes/call.

**Tech Stack:** Node.js 24 (CommonJS), `@modelcontextprotocol/sdk` ^1.29, `node --test`; script is TypeScript via `tsx` + Playwright.

Repo root: `~/smart-volume-radar-engine`. Branch: `feat/screenshot-multi-tf`.

---

## File Structure
```
mcp-tv-sync/src/buildArgs.js        # MODIFY: intervals[] support in buildScreenshotArgs
mcp-tv-sync/src/tools.js            # MODIFY: add `intervals` to tv_screenshot schema
mcp-tv-sync/index.js                # MODIFY: image branch reads parsed.shots[]
mcp-tv-sync/test/buildArgs.test.js  # MODIFY: intervals tests
scripts/sync-tv-watchlist.ts        # MODIFY: SCREENSHOT_INTERVALS, resolveIntervals, captureChart, runScreenshot loop
```

---

## Task 1: `buildScreenshotArgs` intervals support (TDD)

**Files:** Test `mcp-tv-sync/test/buildArgs.test.js`; Modify `mcp-tv-sync/src/buildArgs.js`

- [ ] **Step 1: Append failing tests**

Append to `mcp-tv-sync/test/buildArgs.test.js`:

```js
test('buildScreenshotArgs with intervals array emits --intervals CSV', () => {
  assert.deepEqual(
    buildScreenshotArgs({ symbol: 'NVDA', intervals: ['1D', '1W'] }),
    ['--screenshot', 'NVDA', '--intervals', '1D,1W']
  );
});

test('buildScreenshotArgs intervals trims and drops empties', () => {
  assert.deepEqual(
    buildScreenshotArgs({ symbol: 'NVDA', intervals: [' 1D ', '', '4H'] }),
    ['--screenshot', 'NVDA', '--intervals', '1D,4H']
  );
});

test('buildScreenshotArgs intervals takes precedence over interval', () => {
  assert.deepEqual(
    buildScreenshotArgs({ symbol: 'NVDA', interval: '1W', intervals: ['1D'] }),
    ['--screenshot', 'NVDA', '--intervals', '1D']
  );
});

test('buildScreenshotArgs empty/all-blank intervals falls back to nothing-or-interval', () => {
  // empty array -> ignored, no interval given -> just the symbol
  assert.deepEqual(buildScreenshotArgs({ symbol: 'NVDA', intervals: [] }), ['--screenshot', 'NVDA']);
  // all-blank array -> ignored, interval used
  assert.deepEqual(
    buildScreenshotArgs({ symbol: 'NVDA', interval: '1W', intervals: ['  '] }),
    ['--screenshot', 'NVDA', '--interval', '1W']
  );
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd ~/smart-volume-radar-engine/mcp-tv-sync && npm test`
Expected: FAIL — the intervals cases produce `--interval`/symbol-only instead of `--intervals`.

- [ ] **Step 3: Replace `buildScreenshotArgs`**

In `mcp-tv-sync/src/buildArgs.js`, replace the existing function:

```js
function buildScreenshotArgs(params = {}) {
  const symbol = params.symbol == null ? '' : String(params.symbol).trim();
  if (symbol === '') throw new Error('symbol is required');
  const args = ['--screenshot', symbol];
  const list = Array.isArray(params.intervals)
    ? params.intervals.map((s) => String(s).trim()).filter((s) => s.length > 0)
    : [];
  if (list.length > 0) {
    args.push('--intervals', list.join(','));
  } else if (params.interval != null && params.interval !== '') {
    args.push('--interval', String(params.interval));
  }
  return args;
}
```

(Export line is unchanged — `buildScreenshotArgs` is already exported.)

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd ~/smart-volume-radar-engine/mcp-tv-sync && npm test`
Expected: PASS — existing tests plus the 4 new ones (25 total).

- [ ] **Step 5: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/src/buildArgs.js mcp-tv-sync/test/buildArgs.test.js
git commit -m "feat(tv-sync-mcp): buildScreenshotArgs accepts intervals[] (multi-timeframe)"
```

---

## Task 2: Script multi-timeframe capture

**Files:** Modify `scripts/sync-tv-watchlist.ts`. No automated test; verified in Task 4.

- [ ] **Step 1: Add the intervals CLI const**

Find (around line 96):
```ts
const SCREENSHOT_INTERVAL = arg('interval', '');
const SCREENSHOT_MODE = !!SCREENSHOT_SYMBOL;
```
Replace with:
```ts
const SCREENSHOT_INTERVAL = arg('interval', '');
const SCREENSHOT_INTERVALS = arg('intervals', '');
const SCREENSHOT_MODE = !!SCREENSHOT_SYMBOL;
```

- [ ] **Step 2: Replace `runScreenshot` with a loop + helpers**

Find the entire existing `runScreenshot` function (the comment block starting `// Assumes \`page\` is already logged in` through its closing `}` around line 943) and replace it with:

```ts
// Resolve the ordered list of timeframes to capture. --intervals (CSV) wins,
// then a single --interval, else [null] (the saved layout's default TF).
// Capped at MAX_SHOTS so one call can't spawn unbounded browser navigations.
const MAX_SHOTS = 4;
function resolveScreenshotIntervals(): Array<string | null> {
    if (SCREENSHOT_INTERVALS) {
        const list = SCREENSHOT_INTERVALS.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        if (list.length > MAX_SHOTS) {
            log(`  (capping screenshot to first ${MAX_SHOTS} of ${list.length} timeframes)`);
        }
        if (list.length > 0) return list.slice(0, MAX_SHOTS);
    }
    if (SCREENSHOT_INTERVAL) return [SCREENSHOT_INTERVAL];
    return [null];
}

// Capture one chart-only screenshot for `interval` (null = saved-layout default).
// Assumes `page` is already logged in. Returns the temp PNG path.
async function captureChart(page: Page, interval: string | null): Promise<string> {
    let url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(SCREENSHOT_SYMBOL)}`;
    if (interval) url += `&interval=${encodeURIComponent(tvInterval(interval))}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    await dismissPopups(page);
    const safe = SCREENSHOT_SYMBOL.replace(/[^a-zA-Z0-9]/g, '_');
    const tf = interval ? interval.replace(/[^a-zA-Z0-9]/g, '') : 'def';
    const out = path.join(os.tmpdir(), `svr-tv-shot-${safe}-${tf}-${Date.now()}.png`);
    const clip = await chartClip(page);
    if (!clip) log('  (chart-area selector not found — full-viewport screenshot)');
    await page.screenshot({ path: out, fullPage: false, ...(clip ? { clip } : {}) });
    log(`📸 Screenshot saved: ${out}${clip ? ' (chart-only)' : ' (full viewport)'}`);
    return out;
}

// Capture every resolved timeframe and print one JSON object with a `shots` array.
async function runScreenshot(page: Page): Promise<number> {
    const intervals = resolveScreenshotIntervals();
    const shots: Array<{ interval: string | null; path: string }> = [];
    for (const iv of intervals) {
        const out = await captureChart(page, iv);
        shots.push({ interval: iv, path: out });
    }
    console.log(JSON.stringify({ mode: 'screenshot', symbol: SCREENSHOT_SYMBOL, shots }));
    return 0;
}
```

- [ ] **Step 3: Verify single + multi work (live, read-only)**

Run:
```bash
cd ~/smart-volume-radar-engine
npm run tv-sync -- --screenshot "NVDA" 2>/dev/null
npm run tv-sync -- --screenshot "NVDA" --intervals "1D,1W" 2>/dev/null
```
Expected: first prints `{"mode":"screenshot","symbol":"NVDA","shots":[{"interval":null,"path":"...def...png"}]}`;
second prints a `shots` array with two entries (`"interval":"1D"` and `"interval":"1W"`), each with an existing PNG path. (Read-only browser nav + screenshots; no watchlist writes.)

- [ ] **Step 4: Commit**

```bash
cd ~/smart-volume-radar-engine
git add scripts/sync-tv-watchlist.ts
git commit -m "feat(tv-sync): --intervals multi-timeframe screenshot; unified shots[] output"
```

---

## Task 3: MCP — `intervals` param + multi-image result

**Files:** Modify `mcp-tv-sync/src/tools.js`, `mcp-tv-sync/index.js`

- [ ] **Step 1: Add `intervals` to the tv_screenshot schema**

In `mcp-tv-sync/src/tools.js`, find the `tv_screenshot` `inputSchema.properties` block:
```js
      properties: {
        symbol: { type: 'string', description: 'TradingView symbol, e.g. "NVDA", "AAPL", or exchange-qualified "TASE:RMLI".' },
        interval: { type: 'string', description: 'Optional timeframe, e.g. "1D","1W","4H","60". Defaults to the saved layout\'s timeframe.' },
      },
```
Replace with:
```js
      properties: {
        symbol: { type: 'string', description: 'TradingView symbol, e.g. "NVDA", "AAPL", or exchange-qualified "TASE:RMLI".' },
        interval: { type: 'string', description: 'Optional single timeframe, e.g. "1D","1W","4H","60". Defaults to the saved layout\'s timeframe.' },
        intervals: { type: 'array', items: { type: 'string' }, description: 'Optional multiple timeframes, e.g. ["1D","1W"]. Returns one chart image per timeframe (max 4). Takes precedence over `interval`.' },
      },
```

- [ ] **Step 2: Replace the image branch in `index.js` to read `shots[]`**

In `mcp-tv-sync/index.js`, replace the entire `if (spec.kind === 'image') { ... }` block with:

```js
  if (spec.kind === 'image') {
    const parsed = result.timedOut ? null : parseGranularResult(result.stdout);
    const failMsg = (why) => ({
      isError: true,
      content: [{ type: 'text', text: `${request.params.name} failed (${why}). flags: [${flags.join(' ')}]\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}` }],
    });
    if (result.timedOut) return failMsg(`timed out after ${minutes} min`);
    if (parsed === null || parsed.error != null || !Array.isArray(parsed.shots) || parsed.shots.length === 0) {
      return failMsg(parsed && parsed.error ? parsed.error : 'no screenshots in result');
    }
    const content = [];
    for (const shot of parsed.shots) {
      let data;
      try {
        data = fs.readFileSync(shot.path).toString('base64');
      } catch (_) {
        continue; // skip a shot we can't read; others may be fine
      }
      fs.unlink(shot.path, () => {});
      content.push({ type: 'image', data, mimeType: 'image/png' });
      content.push({ type: 'text', text: `TradingView ${parsed.symbol} @ ${shot.interval || 'default'}` });
    }
    if (content.length === 0) return failMsg('no readable screenshot files');
    return { isError: result.exitCode !== 0, content };
  }
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
Expected: `npm test` passes (25 tests); tools/list shows 5 tools and `tv_screenshot`'s schema now has an `intervals` array property. Do NOT call any tool.

- [ ] **Step 4: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/src/tools.js mcp-tv-sync/index.js
git commit -m "feat(tv-sync-mcp): tv_screenshot intervals[] returns one image per timeframe"
```

---

## Task 4: Integration verification (manual)

Requires a Claude reload so the updated `tv_screenshot` schema loads. Acceptance gate.

- [ ] **Step 1: Reload Claude Code.**

- [ ] **Step 2: Single-shot still works** — `tv_screenshot({ symbol: "NVDA" })` → one NVDA chart image (unchanged behavior).

- [ ] **Step 3: Multi-timeframe** — `tv_screenshot({ symbol: "NVDA", intervals: ["1D","1W"] })` → TWO images: NVDA daily and NVDA weekly, each chart-only with the saved layout, each captioned with its timeframe.

- [ ] **Step 4: Report results** (confirm both images arrived and are the right timeframes). No commit (verification only).

---

## Self-Review notes
- **Spec coverage:** `intervals` param (Task 1 buildArgs, Task 3 tools.js) ✓; script `--intervals` loop + unified `shots[]` (Task 2) ✓; MCP one-image-per-shot, unlink each, isError only if zero readable (Task 3 index.js) ✓; max-4 cap with logged drop (Task 2 resolveScreenshotIntervals) ✓; intervals-beats-interval (Task 1 + Task 2 precedence) ✓; partial-failure tolerance (Task 3 `continue`) ✓; unit + manual tests (Tasks 1, 4) ✓.
- **Type/name consistency:** script emits `{mode,symbol,shots:[{interval,path}]}` (Task 2) consumed by index.js `parsed.shots` (Task 3); `buildScreenshotArgs` intervals→`--intervals` CSV (Task 1) parsed by `SCREENSHOT_INTERVALS`/`resolveScreenshotIntervals` (Task 2); `chartClip`/`tvInterval`/`dismissPopups` reused, not redefined.
- **Out of scope (unchanged):** montage stitching, per-interval symbols, save-to-folder, news/fundamentals.
```

