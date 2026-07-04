# tv_deep_dive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `tv_deep_dive` MCP tool that returns a ticker's TradingView chart image(s) plus a compact text block of its current radar technical state.

**Architecture:** All-MCP feature, no script change. A new `src/radarData.js` reads the on-disk radar/lean/monitor JSON snapshots and formats a radar-state text block (pure formatter, unit-tested). The tool reuses the existing `--screenshot` capture for the chart via `buildScreenshotArgs`, then prepends the radar block to the image content. A shared `shotsToContent` helper de-dupes the image-building shared with `tv_screenshot`.

**Tech Stack:** Node.js 24 (CommonJS), `@modelcontextprotocol/sdk` ^1.29, `node --test`.

Repo root: `~/smart-volume-radar-engine`. Branch: `feat/tv-deep-dive`.

---

## File Structure
```
mcp-tv-sync/src/radarData.js          # CREATE: load snapshots + normalizeTicker/findStock/formatDeepDive
mcp-tv-sync/test/radarData.test.js     # CREATE: unit tests for the pure functions
mcp-tv-sync/src/tools.js               # MODIFY: add tv_deep_dive def + TOOL_SPECS entry (kind 'deepdive')
mcp-tv-sync/index.js                   # MODIFY: shotsToContent helper; refactor image branch; add deepdive branch
```

---

## Task 1: `radarData.js` — load + format radar state (TDD)

**Files:** Create `mcp-tv-sync/src/radarData.js`, `mcp-tv-sync/test/radarData.test.js`

- [ ] **Step 1: Write the failing tests**

Create `mcp-tv-sync/test/radarData.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTicker, findStock, leanBucketsFor, formatDeepDive } = require('../src/radarData.js');

test('normalizeTicker strips exchange prefix and TA/TW/T suffix, uppercases', () => {
  assert.equal(normalizeTicker('nvda'), 'NVDA');
  assert.equal(normalizeTicker('TASE:RMLI'), 'RMLI');
  assert.equal(normalizeTicker('DORL.TA'), 'DORL');
  assert.equal(normalizeTicker('6531.TW'), '6531');
  assert.equal(normalizeTicker(null), '');
});

test('findStock matches by normalized ticker', () => {
  const snap = { stocks: [{ ticker: 'NVDA' }, { ticker: 'DORL.TA' }] };
  assert.equal(findStock(snap, 'nvda').ticker, 'NVDA');
  assert.equal(findStock(snap, 'DORL').ticker, 'DORL.TA');
  assert.equal(findStock(snap, 'ZZZZ'), null);
  assert.equal(findStock(null, 'NVDA'), null);
});

test('leanBucketsFor lists buckets containing the ticker', () => {
  const lean = { detections: {
    highVolume: [{ ticker: 'CTRA' }],
    pullbacks: [{ ticker: 'DORL.TA' }],
    nearConsolidation: [{ ticker: 'NVDA' }],
  } };
  assert.deepEqual(leanBucketsFor(lean, 'NVDA'), ['nearConsolidation']);
  assert.deepEqual(leanBucketsFor(lean, 'DORL'), ['pullbacks']);
  assert.deepEqual(leanBucketsFor(null, 'NVDA'), []);
});

test('formatDeepDive includes key fields for a found stock', () => {
  const stock = {
    ticker: 'NVDA', lastPrice: 212.45, priceChange: 3.54, rvol: 0.9, pctFromAth: -9.88,
    action: 'PASS', breakoutStage: 'Pre-Pivot', championScore: 60, sector: 'AI - Chain', sectorRank: 2,
    momentum: { level: 'none', criteria: { rvolPass: false, stage2: true, lowRiskEntry: true,
      pivotBreakout: false, tightness: true, aboveGapAvwap: true, antsAccumulation: false, bigMoveToday: true } },
    tradePlan: { pivot: 235.74, buyZoneLow: 231.03, buyZoneHigh: 240.45, stopLoss: 203.79, riskPct: -4.08 },
    isHotStreak: true,
  };
  const out = formatDeepDive({ symbol: 'NVDA', stock, scanDate: '2026-06-15', leanBuckets: ['nearConsolidation'] });
  assert.match(out, /NVDA/);
  assert.match(out, /2026-06-15/);
  assert.match(out, /PASS/);
  assert.match(out, /Champion score: 60/);
  assert.match(out, /pivot 235\.74/);
  assert.match(out, /stage2/);            // a passing criterion is listed
  assert.match(out, /nearConsolidation/); // lean bucket shown
  assert.match(out, /hot-streak/);        // flag shown
});

test('formatDeepDive returns a clean note when stock is missing', () => {
  const out = formatDeepDive({ symbol: 'ZZZZ', stock: null, scanDate: '2026-06-15' });
  assert.match(out, /ZZZZ/);
  assert.match(out, /not in latest radar snapshot/i);
  assert.match(out, /2026-06-15/);
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd ~/smart-volume-radar-engine/mcp-tv-sync && npm test`
Expected: FAIL — `Cannot find module '../src/radarData.js'`.

- [ ] **Step 3: Create `mcp-tv-sync/src/radarData.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');

const RADAR_RE = /^radar-\d{4}-\d{2}-\d{2}\.json$/; // excludes radar-reconstructed-*
const LEAN_RE = /^lean-\d{4}-\d{2}-\d{2}\.json$/;

function latestDatedFile(dir, re) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  const matches = files.filter((f) => re.test(f)).sort(); // YYYY-MM-DD sorts chronologically
  return matches.length ? path.join(dir, matches[matches.length - 1]) : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadLatestRadar(repoDir) {
  const f = latestDatedFile(path.join(repoDir, 'results'), RADAR_RE);
  return f ? readJson(f) : null;
}

function loadLatestLean(repoDir) {
  const f = latestDatedFile(path.join(repoDir, 'results'), LEAN_RE);
  return f ? readJson(f) : null;
}

/** Uppercase, strip a leading EXCHANGE: prefix and a trailing .TA/.TW/.T suffix. */
function normalizeTicker(s) {
  if (s == null) return '';
  let t = String(s).trim().toUpperCase();
  const colon = t.indexOf(':');
  if (colon >= 0) t = t.slice(colon + 1);
  return t.replace(/\.(TA|TW|T)$/, '');
}

function findStock(snapshot, symbol) {
  if (!snapshot || !Array.isArray(snapshot.stocks)) return null;
  const want = normalizeTicker(symbol);
  return snapshot.stocks.find((s) => normalizeTicker(s.ticker) === want) || null;
}

/** Names of the lean detection buckets that contain the ticker. */
function leanBucketsFor(lean, symbol) {
  if (!lean || !lean.detections) return [];
  const want = normalizeTicker(symbol);
  const out = [];
  for (const [bucket, arr] of Object.entries(lean.detections)) {
    if (Array.isArray(arr) && arr.some((e) => e && normalizeTicker(e.ticker) === want)) {
      out.push(bucket);
    }
  }
  return out;
}

function loadMonitorEntry(repoDir, symbol) {
  const m = readJson(path.join(repoDir, 'results', 'monitor-list.json'));
  if (!m || !Array.isArray(m.entries)) return null;
  const want = normalizeTicker(symbol);
  return m.entries.find((e) => e && normalizeTicker(e.ticker) === want) || null;
}

function fmtNum(n, digits = 2) {
  return typeof n === 'number' && isFinite(n) ? n.toFixed(digits) : '—';
}

/** Build a concise multi-line radar-state text block. Pure. */
function formatDeepDive({ symbol, stock, scanDate, leanBuckets = [], monitorEntry = null }) {
  if (!stock) {
    return `Radar state: ${symbol} not in latest radar snapshot` +
      (scanDate ? ` (${scanDate}).` : ' (no snapshot found).');
  }
  const lines = [];
  lines.push(`Radar state for ${stock.ticker} (snapshot ${scanDate || '?'}):`);
  lines.push(`• Price ${fmtNum(stock.lastPrice)} (${fmtNum(stock.priceChange)}% today) · RVOL ${fmtNum(stock.rvol)}x · ${fmtNum(stock.pctFromAth)}% from ATH`);
  lines.push(`• Action: ${stock.action ?? '—'} · Stage: ${stock.breakoutStage ?? '—'} · Champion score: ${stock.championScore ?? '—'}` +
    (stock.entryGrade ? ` · Entry grade: ${stock.entryGrade}` : ''));
  lines.push(`• Sector: ${stock.sector ?? '—'} (rank ${stock.sectorRank ?? '—'})`);
  const m = stock.momentum;
  if (m && m.criteria) {
    const entries = Object.entries(m.criteria);
    const passed = entries.filter(([, v]) => v).map(([k]) => k);
    const failed = entries.filter(([, v]) => !v).map(([k]) => k);
    lines.push(`• Momentum: ${m.level ?? 'none'} — ${passed.length}/${entries.length} criteria`);
    lines.push(`   pass: ${passed.join(', ') || 'none'}`);
    lines.push(`   fail: ${failed.join(', ') || 'none'}`);
  }
  const tp = stock.tradePlan;
  if (tp) {
    lines.push(`• Trade plan: pivot ${fmtNum(tp.pivot)} · buy ${fmtNum(tp.buyZoneLow)}–${fmtNum(tp.buyZoneHigh)} · stop ${fmtNum(tp.stopLoss)} · risk ${fmtNum(tp.riskPct)}%`);
  }
  const flags = [];
  if (stock.isHotStreak) flags.push('hot-streak');
  if (stock.isFatigued) flags.push('fatigued');
  if (flags.length) lines.push(`• Flags: ${flags.join(', ')}`);
  if (leanBuckets.length) lines.push(`• Lean detections: ${leanBuckets.join(', ')}`);
  if (monitorEntry) {
    lines.push(`• Monitor: ${monitorEntry.status ?? 'tracked'}` +
      (monitorEntry.firstAlertDate ? ` since ${monitorEntry.firstAlertDate}` : ''));
  }
  return lines.join('\n');
}

module.exports = {
  loadLatestRadar, loadLatestLean, loadMonitorEntry,
  normalizeTicker, findStock, leanBucketsFor, formatDeepDive,
};
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd ~/smart-volume-radar-engine/mcp-tv-sync && npm test`
Expected: PASS — existing buildArgs tests plus the new radarData tests.

- [ ] **Step 5: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/src/radarData.js mcp-tv-sync/test/radarData.test.js
git commit -m "feat(tv-sync-mcp): radarData module — load snapshots + format radar state"
```

---

## Task 2: Wire `tv_deep_dive` into the MCP

**Files:** Modify `mcp-tv-sync/src/tools.js`, `mcp-tv-sync/index.js`

- [ ] **Step 1: Add the tool definition + spec in `tools.js`**

In `mcp-tv-sync/src/tools.js`, add this object to the `TOOL_DEFINITIONS` array (after the `tv_screenshot` entry):

```js
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
```

And add to the `TOOL_SPECS` object (it reuses the screenshot arg-builder):
```js
  tv_deep_dive: { build: buildScreenshotArgs, kind: 'deepdive' },
```

- [ ] **Step 2: Add the radarData require to `index.js`**

In `mcp-tv-sync/index.js`, after the line `const { TOOL_DEFINITIONS, TOOL_SPECS } = require('./src/tools.js');`, add:
```js
const radar = require('./src/radarData.js');
```

- [ ] **Step 3: Extract `shotsToContent` and refactor the image branch**

In `mcp-tv-sync/index.js`, add this helper just above the `const server = new Server(` line:

```js
// Turn a parsed {symbol, shots:[{interval,path}]} into MCP image+caption blocks.
// Reads + unlinks each PNG. Returns { blocks, imageCount }.
function shotsToContent(parsed) {
  const blocks = [];
  let imageCount = 0;
  for (const shot of parsed.shots) {
    let data;
    try {
      data = fs.readFileSync(shot.path).toString('base64');
    } catch (_) {
      blocks.push({ type: 'text', text: `[warning] could not read screenshot for ${shot.interval || 'default'}` });
      continue;
    }
    fs.unlink(shot.path, () => {});
    blocks.push({ type: 'image', data, mimeType: 'image/png' });
    blocks.push({ type: 'text', text: `TradingView ${parsed.symbol} @ ${shot.interval || 'default'}` });
    imageCount++;
  }
  return { blocks, imageCount };
}
```

Then replace the existing `if (spec.kind === 'image') { ... }` block with this (uses the helper):

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
    const { blocks, imageCount } = shotsToContent(parsed);
    if (imageCount === 0) return failMsg('no readable screenshot files');
    return { isError: result.exitCode !== 0, content: blocks };
  }
```

- [ ] **Step 4: Add the `deepdive` branch**

In `mcp-tv-sync/index.js`, immediately AFTER the `if (spec.kind === 'image') { ... }` block, add:

```js
  if (spec.kind === 'deepdive') {
    const symbol = (request.params.arguments && request.params.arguments.symbol) || '';
    let radarBlock;
    try {
      const snap = radar.loadLatestRadar(REPO_DIR);
      const stock = snap ? radar.findStock(snap, symbol) : null;
      radarBlock = radar.formatDeepDive({
        symbol,
        stock,
        scanDate: snap ? snap.scanDate : null,
        leanBuckets: radar.leanBucketsFor(radar.loadLatestLean(REPO_DIR), symbol),
        monitorEntry: radar.loadMonitorEntry(REPO_DIR, symbol),
      });
    } catch (err) {
      radarBlock = `Radar state unavailable: ${err.message}`;
    }

    const parsed = result.timedOut ? null : parseGranularResult(result.stdout);
    const failMsg = (why) => ({
      isError: true,
      content: [{ type: 'text', text: `${request.params.name} failed (${why}). flags: [${flags.join(' ')}]\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}` }],
    });
    if (result.timedOut) return failMsg(`timed out after ${minutes} min`);
    if (parsed === null || parsed.error != null || !Array.isArray(parsed.shots) || parsed.shots.length === 0) {
      return failMsg(parsed && parsed.error ? parsed.error : 'no screenshots in result');
    }
    const { blocks, imageCount } = shotsToContent(parsed);
    if (imageCount === 0) return failMsg('no readable screenshot files');
    return { isError: result.exitCode !== 0, content: [{ type: 'text', text: radarBlock }, ...blocks] };
  }
```

- [ ] **Step 5: Unit tests green + server lists 6 tools**

Run:
```bash
cd ~/smart-volume-radar-engine/mcp-tv-sync
npm test
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node index.js
```
Expected: `npm test` passes (all buildArgs + radarData tests); tools/list shows SIX tools including `tv_deep_dive`. Do NOT call any tool.

- [ ] **Step 6: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/src/tools.js mcp-tv-sync/index.js
git commit -m "feat(tv-sync-mcp): tv_deep_dive tool (chart + radar state); shotsToContent helper"
```

---

## Task 3: Integration verification (manual)

Requires a Claude reload so `tv_deep_dive` loads. Acceptance gate.

- [ ] **Step 1: Reload Claude Code.**

- [ ] **Step 2: Deep dive on a known ticker** — `tv_deep_dive({ symbol: "NVDA" })`.
Expected: a radar-state text block (action, champion score, RVOL, momentum criteria, trade-plan levels, sector rank, snapshot date) whose numbers match `results/radar-*.json` for NVDA, FOLLOWED BY the NVDA chart image. Cross-check 2–3 numbers against the JSON.

- [ ] **Step 3: Ticker absent from the snapshot** — `tv_deep_dive({ symbol: "SPY" })` (an index ETF unlikely to be in the watchlist).
Expected: a "not in latest radar snapshot (date)" note PLUS the chart image — no error.

- [ ] **Step 4: Report results.** No commit (verification only).

---

## Self-Review notes
- **Spec coverage:** radarData load + normalize + find + format (Task 1) ✓; reuse `--screenshot` via `buildScreenshotArgs`, no script change (Task 2 TOOL_SPECS) ✓; deepdive branch returns radar text + chart image(s) (Task 2 Step 4) ✓; latest dated file excluding `reconstructed` (Task 1 RADAR_RE) ✓; lean buckets + monitor status (Task 1) ✓; graceful "not found"/no-snapshot note, chart still returned (Task 1 formatDeepDive + Task 2 try/catch) ✓; DRY shotsToContent shared with image branch (Task 2 Step 3) ✓; unit + manual tests (Tasks 1, 3) ✓.
- **Type/name consistency:** `radarData` exports `loadLatestRadar/loadLatestLean/loadMonitorEntry/normalizeTicker/findStock/leanBucketsFor/formatDeepDive` (Task 1) all consumed in Task 2; `shotsToContent` returns `{blocks, imageCount}` used by both image and deepdive branches; `kind: 'deepdive'` set in tools.js and switched in index.js.
- **Out of scope (unchanged):** fundamentals, news, full thesis generation, foreign-symbol mapping.
```

