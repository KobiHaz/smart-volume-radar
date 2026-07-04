# svr-tv-sync MCP v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add granular TradingView tools (`tv_read_watchlist`, `tv_add_symbols`, `tv_remove_symbols`) to the svr-tv-sync MCP, and expose `--file` / `--prune-after-days` on `tv_sync`.

**Architecture:** Keep v1's split — the script owns Playwright, the MCP shells out. Add three CLI modes (`--read`/`--add`/`--remove`) to `sync-tv-watchlist.ts` that reuse its existing `openWatchlist`/`readCurrentSymbols`/`addSymbolsBulk`/`removeSymbol` functions and print one JSON object to stdout. The MCP gets matching thin tools (pure arg-builders + a generic dispatcher) and parses that JSON.

**Tech Stack:** Node.js 24 (CommonJS), `@modelcontextprotocol/sdk` ^1.29, `node --test`; the script is TypeScript run via `tsx`.

Repo root: `~/smart-volume-radar-engine`. Branch: `feat/tv-sync-mcp-v2`.

---

## File Structure

```
mcp-tv-sync/
  src/buildArgs.js        # MODIFY: extend buildArgs; add buildReadArgs/buildAddArgs/buildRemoveArgs + helpers
  src/tools.js            # CREATE: 4 tool definitions + TOOL_SPECS dispatch map
  index.js                # MODIFY: import tools.js, generic CallTool dispatch, granular JSON parsing
  test/buildArgs.test.js  # MODIFY: tests for new/extended builders
scripts/sync-tv-watchlist.ts  # MODIFY: --read/--add/--remove granular modes
```

---

## Task 1: Arg-builders for new tools + flag exposure (TDD)

**Files:**
- Test: `mcp-tv-sync/test/buildArgs.test.js`
- Modify: `mcp-tv-sync/src/buildArgs.js`

- [ ] **Step 1: Append failing tests**

Append to `mcp-tv-sync/test/buildArgs.test.js`:

```js
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
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd ~/smart-volume-radar-engine/mcp-tv-sync && npm test`
Expected: FAIL — `buildReadArgs is not a function` (and the file/prune assertions fail).

- [ ] **Step 3: Rewrite `src/buildArgs.js`**

Replace the entire contents of `mcp-tv-sync/src/buildArgs.js` with:

```js
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
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd ~/smart-volume-radar-engine/mcp-tv-sync && npm test`
Expected: PASS — the original v1 tests plus the new ones (19 total).

- [ ] **Step 5: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/src/buildArgs.js mcp-tv-sync/test/buildArgs.test.js
git commit -m "feat(tv-sync-mcp): arg-builders for read/add/remove + file/prune-after-days"
```

---

## Task 2: Granular CLI modes in the script

**Files:**
- Modify: `scripts/sync-tv-watchlist.ts`

No automated test (Playwright/browser); verified by the integration test in Task 4.

- [ ] **Step 1: Add CLI flag parsing**

In `scripts/sync-tv-watchlist.ts`, find this block (around line 83):

```ts
const PRUNE_AFTER_DAYS = parseInt(arg('prune-after-days', '14'), 10);
```

Insert immediately AFTER it:

```ts
// Granular single-operation modes (used by the MCP tools). Each opens one
// list, performs one operation, prints a JSON result to stdout, and exits.
const READ_LIST = arg('read', '');
const ADD_LIST = arg('add', '');
const REMOVE_LIST = arg('remove', '');
const SYMBOLS_CSV = arg('symbols', '');
const GRANULAR_MODE = !!(READ_LIST || ADD_LIST || REMOVE_LIST);
```

- [ ] **Step 2: Add the granular handler function**

Find this exact line (it precedes `async function main()`, around line 790):

```ts
// ─── Main ───────────────────────────────────────────────────────────
async function main() {
```

Insert the following ABOVE that `// ─── Main ───` comment line:

```ts
// ─── Granular single-operation handlers (--read / --add / --remove) ──
function parseSymbolsCsv(csv: string): string[] {
    return csv
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0);
}

// Assumes `page` is already on the TV chart page and logged in (the caller
// runs the shared navigation + login check first). Reuses the same Playwright
// primitives as the sync path. Prints exactly one JSON object to stdout.
async function runGranular(page: Page): Promise<number> {
    if (READ_LIST) {
        const found = await openWatchlist(page, READ_LIST, false);
        if (!found) {
            console.log(JSON.stringify({ mode: 'read', watchlist: READ_LIST, error: 'watchlist not found' }));
            return 1;
        }
        const symbols = await readCurrentSymbols(page);
        console.log(JSON.stringify({ mode: 'read', watchlist: READ_LIST, symbols }));
        return 0;
    }

    if (ADD_LIST) {
        const syms = parseSymbolsCsv(SYMBOLS_CSV);
        if (syms.length === 0) {
            console.log(JSON.stringify({ mode: 'add', watchlist: ADD_LIST, error: 'no symbols given' }));
            return 1;
        }
        await openWatchlist(page, ADD_LIST, true);
        const { added, failed } = await addSymbolsBulk(page, syms);
        console.log(JSON.stringify({ mode: 'add', watchlist: ADD_LIST, added, failed }));
        return 0;
    }

    // REMOVE_LIST
    const syms = parseSymbolsCsv(SYMBOLS_CSV);
    if (syms.length === 0) {
        console.log(JSON.stringify({ mode: 'remove', watchlist: REMOVE_LIST, error: 'no symbols given' }));
        return 1;
    }
    const found = await openWatchlist(page, REMOVE_LIST, false);
    if (!found) {
        console.log(JSON.stringify({ mode: 'remove', watchlist: REMOVE_LIST, error: 'watchlist not found' }));
        return 1;
    }
    const removed: string[] = [];
    const notFound: string[] = [];
    for (const s of syms) {
        if (await removeSymbol(page, s)) removed.push(s);
        else notFound.push(s);
    }
    console.log(JSON.stringify({ mode: 'remove', watchlist: REMOVE_LIST, removed, notFound }));
    return 0;
}

```

- [ ] **Step 3: Wire the granular branch into `main()`**

Find this block (around line 872, right after the login check and before the `tasks` array):

```ts
        if (!(await isLoggedIn(page))) {
            throw new Error(
                'Not logged into TradingView. Run with --login once to authenticate. ' +
                    'See ~/Library/Logs/tv-sync.log for details.'
            );
        }

        const tasks: SyncTarget[] = SINGLE_LIST_MODE
```

Insert the granular branch BETWEEN the `}` closing the `isLoggedIn` check and the `const tasks` line:

```ts
        if (!(await isLoggedIn(page))) {
            throw new Error(
                'Not logged into TradingView. Run with --login once to authenticate. ' +
                    'See ~/Library/Logs/tv-sync.log for details.'
            );
        }

        if (GRANULAR_MODE) {
            let code = 1;
            try {
                code = await runGranular(page);
            } finally {
                await context.close().catch(() => {});
            }
            process.exit(code);
        }

        const tasks: SyncTarget[] = SINGLE_LIST_MODE
```

- [ ] **Step 4: Verify it compiles + read mode works (dry, read-only)**

Run:
```bash
cd ~/smart-volume-radar-engine
npm run tv-sync -- --read "Lean Radar - Near" 2>/dev/null
```
Expected: a single JSON line on stdout, e.g.
`{"mode":"read","watchlist":"Lean Radar - Near","symbols":["PLUS","WBS",...]}`
No TypeScript errors. (stderr carries the verbose log; `2>/dev/null` hides it.)

- [ ] **Step 5: Commit**

```bash
cd ~/smart-volume-radar-engine
git add scripts/sync-tv-watchlist.ts
git commit -m "feat(tv-sync): --read/--add/--remove granular modes emitting JSON on stdout"
```

---

## Task 3: MCP tool surface — `src/tools.js` + `index.js` dispatch

**Files:**
- Create: `mcp-tv-sync/src/tools.js`
- Modify: `mcp-tv-sync/index.js`

- [ ] **Step 1: Create `mcp-tv-sync/src/tools.js`**

```js
'use strict';
const {
  buildArgs, buildReadArgs, buildAddArgs, buildRemoveArgs, WATCHLISTS,
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
];

// name -> how to build its flags and whether it returns a JSON granular result.
const TOOL_SPECS = {
  tv_sync: { build: buildArgs, granular: false },
  tv_read_watchlist: { build: buildReadArgs, granular: true },
  tv_add_symbols: { build: buildAddArgs, granular: true },
  tv_remove_symbols: { build: buildRemoveArgs, granular: true },
};

module.exports = { TOOL_DEFINITIONS, TOOL_SPECS };
```

- [ ] **Step 2: Rewrite `mcp-tv-sync/index.js`**

Replace the entire contents of `mcp-tv-sync/index.js` with:

```js
#!/usr/bin/env node
'use strict';
/**
 * svr-tv-sync MCP server
 * Shells out to the repo's `npm run tv-sync` so behavior matches a manual run.
 * No sync logic here. tv_sync runs the full/single sync; tv_read_watchlist /
 * tv_add_symbols / tv_remove_symbols use the script's granular modes (JSON on stdout).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { TOOL_DEFINITIONS, TOOL_SPECS } = require('./src/tools.js');

const REPO_DIR = path.resolve(__dirname, '..');
const STATE_PATH = path.join(os.homedir(), 'telegram-mcp', 'data', 'tv-state.json');
const TIMEOUT_MS = Number(process.env.TV_SYNC_TIMEOUT_MS) || 35 * 60 * 1000;
const MAX_OUTPUT_TAIL = 4000;
const MAX_BUFFER = 1_000_000;

function tail(str, n = MAX_OUTPUT_TAIL) {
  return str.length > n ? str.slice(-n) : str;
}

/** Find the last stdout line that parses as JSON (skips the npm banner). */
function parseGranularResult(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch (_) {
      /* keep scanning upward */
    }
  }
  return null;
}

function runTvSync(flags) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('npm', ['run', 'tv-sync', '--', ...flags], { cwd: REPO_DIR, env: process.env });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_BUFFER) stdout = stdout.slice(-MAX_BUFFER);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > MAX_BUFFER) stderr = stderr.slice(-MAX_BUFFER);
    });

    child.on('close', (code) => {
      settle({ exitCode: code, timedOut, stdout, stderr, durationMs: Date.now() - startedAt, startedAt });
    });
    child.on('error', (err) => {
      settle({ exitCode: -1, timedOut, stdout, stderr: stderr + `\nspawn error: ${err.message}`, durationMs: Date.now() - startedAt, startedAt });
    });
  });
}

const server = new Server({ name: 'svr-tv-sync', version: '2.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const spec = TOOL_SPECS[request.params.name];
  if (!spec) throw new Error(`Unknown tool: ${request.params.name}`);
  if (!fs.existsSync(path.join(REPO_DIR, 'package.json'))) {
    return { isError: true, content: [{ type: 'text', text: `Repo not found at ${REPO_DIR}` }] };
  }

  let flags;
  try {
    flags = spec.build(request.params.arguments || {});
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err.message) }] };
  }

  const result = await runTvSync(flags);
  const minutes = (result.durationMs / 60000).toFixed(1);

  if (spec.granular) {
    const parsed = result.timedOut ? null : parseGranularResult(result.stdout);
    if (parsed === null) {
      const why = result.timedOut ? `timed out after ${minutes} min` : 'could not parse JSON result';
      return {
        isError: true,
        content: [{ type: 'text', text: `${request.params.name} failed (${why}). flags: [${flags.join(' ')}]\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}` }],
      };
    }
    return {
      isError: result.exitCode !== 0 || parsed.error != null,
      content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
    };
  }

  // tv_sync — full/single sync summary.
  let statePath = null;
  try {
    const st = fs.statSync(STATE_PATH);
    if (st.mtimeMs >= result.startedAt) statePath = STATE_PATH;
  } catch (_) { /* not written */ }
  const ok = result.exitCode === 0 && !result.timedOut;
  const header = result.timedOut
    ? `tv_sync TIMED OUT after ${minutes} min (TV_SYNC_TIMEOUT_MS=${TIMEOUT_MS}); child killed.`
    : `tv_sync exited ${result.exitCode} in ${minutes} min. flags: [${flags.join(' ')}]`;
  const body =
    `${header}\nstatePath: ${statePath || '(not updated)'}\n` +
    `--- stdout (tail) ---\n${tail(result.stdout)}\n--- stderr (tail) ---\n${tail(result.stderr)}`;
  return { isError: !ok, content: [{ type: 'text', text: body }] };
});

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})().catch((err) => {
  process.stderr.write(`svr-tv-sync failed to start: ${err.message}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: Unit tests still green + server lists 4 tools**

Run:
```bash
cd ~/smart-volume-radar-engine/mcp-tv-sync
npm test
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node index.js
```
Expected: `npm test` passes; tools/list returns four tools — `tv_sync`, `tv_read_watchlist`, `tv_add_symbols`, `tv_remove_symbols`. Do NOT call any tool (no browser automation here).

- [ ] **Step 4: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/src/tools.js mcp-tv-sync/index.js
git commit -m "feat(tv-sync-mcp): 4-tool surface (read/add/remove + extended tv_sync) via tools.js dispatch"
```

---

## Task 4: Integration verification (manual)

Requires a Claude reload so the new tools load. Acceptance gate.

- [ ] **Step 1: Reload Claude Code** so the updated server (4 tools) is loaded.

- [ ] **Step 2: Read matches dry-run**

Call `tv_read_watchlist({ watchlist: "Lean Radar - Near" })`.
Expected: a JSON object `{ "mode":"read", "watchlist":"Lean Radar - Near", "symbols":[...] }` whose symbols match what `tv_sync({dryRun:true})` reports as "Current in TV" for that list.

- [ ] **Step 3: Add/remove round-trip on a throwaway ticker**

Call `tv_add_symbols({ watchlist: "Lean Radar - Near", symbols: ["AAPL"] })`
→ expect `{ "added":["AAPL"], "failed":[] }`.
Call `tv_read_watchlist({ watchlist: "Lean Radar - Near" })`
→ expect AAPL present.
Call `tv_remove_symbols({ watchlist: "Lean Radar - Near", symbols: ["AAPL"] })`
→ expect `{ "removed":["AAPL"], "notFound":[] }`.
Call `tv_read_watchlist({ watchlist: "Lean Radar - Near" })`
→ expect AAPL gone (list back to its prior state).

- [ ] **Step 4: Report results** to the user. No commit (verification only).

---

## Self-Review notes
- **Spec coverage:** 3 granular tools (Tasks 2+3) ✓; tv_sync file/pruneAfterDays (Tasks 1+3) ✓; JSON-on-stdout "stderr fix" (Task 2 console.log + Task 3 parseGranularResult) ✓; index split into tools.js (Task 3) ✓; reuse of existing Playwright fns, no duplication (Task 2 runGranular) ✓; arg-builders unit-tested + manual round-trip (Tasks 1, 4) ✓.
- **Type/name consistency:** `buildReadArgs`/`buildAddArgs`/`buildRemoveArgs`/`WATCHLISTS` exported by buildArgs.js (Task 1) and imported by tools.js (Task 3); `TOOL_DEFINITIONS`/`TOOL_SPECS` exported by tools.js and imported by index.js; granular JSON shapes (`mode`/`watchlist`/`symbols`/`added`/`failed`/`removed`/`notFound`/`error`) emitted by runGranular (Task 2) and consumed generically by index.js (Task 3).
- **Out of scope (unchanged):** CI-mode, --login exposure, shared tvBrowser library, dry-run on add/remove, streaming.
```

