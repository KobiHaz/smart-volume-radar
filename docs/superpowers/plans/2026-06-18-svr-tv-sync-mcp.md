# svr-tv-sync MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing TradingView watchlist sync (`npm run tv-sync`) as a local stdio MCP tool `tv_sync`, with output identical to running the script by hand.

**Architecture:** A standalone MCP package inside the repo at `mcp-tv-sync/`. It re-implements no sync logic — the `tv_sync` tool maps its parameters to CLI flags via a pure `buildArgs()` function, then spawns `npm run tv-sync -- <flags>` as a child process (cwd = repo root) wrapped in an outer timeout. Returns the run's exit code and output tail.

**Tech Stack:** Node.js 24 (CommonJS), `@modelcontextprotocol/sdk` ^1.29 (low-level `Server` API, mirroring `~/telegram-mcp`), Node built-in test runner (`node --test`).

All paths below are relative to the repo root: `~/smart-volume-radar-engine`.

---

## File Structure

```
mcp-tv-sync/
  package.json              # CommonJS, SDK dep, test + start scripts
  src/buildArgs.js          # pure: ({dryRun,replace,watchlist,headed}) -> string[]; exports WATCHLISTS
  test/buildArgs.test.js    # node --test unit tests for arg mapping
  index.js                  # stdio MCP server: ListTools + CallTool(tv_sync) + outer timeout
  README.md                 # registration + usage
```

- `buildArgs.js` owns the param→flag mapping and the canonical `WATCHLISTS` list (single source of truth, reused by the tool's input schema).
- `index.js` owns MCP wiring and the child-process/timeout glue only.

---

## Task 1: Scaffold the MCP package

**Files:**
- Create: `mcp-tv-sync/package.json`

- [ ] **Step 1: Create the package manifest**

Create `mcp-tv-sync/package.json`:

```json
{
  "name": "svr-tv-sync-mcp",
  "version": "1.0.0",
  "description": "Local MCP wrapper around the Smart Volume Radar TradingView sync (npm run tv-sync).",
  "main": "index.js",
  "type": "commonjs",
  "bin": {
    "svr-tv-sync-mcp": "index.js"
  },
  "scripts": {
    "start": "node index.js",
    "test": "node --test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd ~/smart-volume-radar-engine/mcp-tv-sync && npm install`
Expected: creates `node_modules/` and `package-lock.json`, exits 0.

- [ ] **Step 3: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/package.json mcp-tv-sync/package-lock.json
git commit -m "chore(tv-sync-mcp): scaffold MCP package"
```

---

## Task 2: `buildArgs` — pure param→flag mapping (TDD)

**Files:**
- Test: `mcp-tv-sync/test/buildArgs.test.js`
- Create: `mcp-tv-sync/src/buildArgs.js`

- [ ] **Step 1: Write the failing test**

Create `mcp-tv-sync/test/buildArgs.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/smart-volume-radar-engine/mcp-tv-sync && npm test`
Expected: FAIL — `Cannot find module '../src/buildArgs.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `mcp-tv-sync/src/buildArgs.js`:

```js
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
  if (params.watchlist !== undefined) {
    if (!WATCHLISTS.includes(params.watchlist)) {
      throw new Error(`invalid watchlist: ${params.watchlist}`);
    }
    args.push('--watchlist', params.watchlist);
  }
  return args;
}

module.exports = { buildArgs, WATCHLISTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/smart-volume-radar-engine/mcp-tv-sync && npm test`
Expected: PASS — all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/src/buildArgs.js mcp-tv-sync/test/buildArgs.test.js
git commit -m "feat(tv-sync-mcp): pure buildArgs param->flag mapping with tests"
```

---

## Task 3: MCP server (`index.js`)

**Files:**
- Create: `mcp-tv-sync/index.js`

No automated test for this task — the child-process/timeout glue is verified by the manual parity test in Task 5 (per the spec). Keep this file minimal.

- [ ] **Step 1: Write the server**

Create `mcp-tv-sync/index.js`:

```js
#!/usr/bin/env node
'use strict';
/**
 * svr-tv-sync MCP server
 * Exposes one tool, tv_sync, that shells out to the repo's `npm run tv-sync`
 * so behavior is identical to a manual run. No sync logic lives here.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { buildArgs, WATCHLISTS } = require('./src/buildArgs.js');

// Repo root is the parent of this MCP package directory.
const REPO_DIR = path.resolve(__dirname, '..');
const STATE_PATH = path.join(process.env.HOME, 'telegram-mcp', 'data', 'tv-state.json');
const TIMEOUT_MS = Number(process.env.TV_SYNC_TIMEOUT_MS) || 35 * 60 * 1000;
const MAX_OUTPUT_TAIL = 4000; // chars returned from each stream

function tail(str, n = MAX_OUTPUT_TAIL) {
  return str.length > n ? str.slice(-n) : str;
}

/**
 * Run `npm run tv-sync -- <flags>` in REPO_DIR with an outer timeout.
 * Resolves with { exitCode, timedOut, stdout, stderr, durationMs }.
 */
function runTvSync(flags) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('npm', ['run', 'tv-sync', '--', ...flags], {
      cwd: REPO_DIR,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        startedAt,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        timedOut,
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}`,
        durationMs: Date.now() - startedAt,
        startedAt,
      });
    });
  });
}

const server = new Server(
  { name: 'svr-tv-sync', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'tv_sync',
      description:
        'Sync the Smart Volume Radar watchlists to TradingView by running the repo\'s ' +
        'existing `npm run tv-sync` (Playwright, local Chromium profile). Identical to a ' +
        'manual run. Use dryRun to preview the add/remove diff without writing.',
      inputSchema: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: 'Read + diff only, no writes (--dry-run).', default: false },
          replace: { type: 'boolean', description: 'Remove any TV symbol not in the target list (--replace). Default is additive + staleness prune.', default: false },
          headed: { type: 'boolean', description: 'Run with a visible browser window for debugging (--headed).', default: false },
          watchlist: { type: 'string', enum: WATCHLISTS, description: 'Sync only this one list instead of all four.' },
        },
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'tv_sync') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  if (!fs.existsSync(path.join(REPO_DIR, 'package.json'))) {
    return { isError: true, content: [{ type: 'text', text: `Repo not found at ${REPO_DIR}` }] };
  }

  let flags;
  try {
    flags = buildArgs(request.params.arguments || {});
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err.message) }] };
  }

  const result = await runTvSync(flags);

  // Report tv-state.json only if it was (re)written during this run.
  let statePath = null;
  try {
    const st = fs.statSync(STATE_PATH);
    if (st.mtimeMs >= result.startedAt) statePath = STATE_PATH;
  } catch (_) { /* not written / not present */ }

  const minutes = (result.durationMs / 60000).toFixed(1);
  const ok = result.exitCode === 0 && !result.timedOut;
  const header = result.timedOut
    ? `tv_sync TIMED OUT after ${minutes} min (TV_SYNC_TIMEOUT_MS=${TIMEOUT_MS}); child killed.`
    : `tv_sync exited ${result.exitCode} in ${minutes} min. flags: [${flags.join(' ')}]`;

  const body =
    `${header}\n` +
    `statePath: ${statePath || '(not updated)'}\n` +
    `--- stdout (tail) ---\n${tail(result.stdout)}\n` +
    `--- stderr (tail) ---\n${tail(result.stderr)}`;

  return { isError: !ok, content: [{ type: 'text', text: body }] };
});

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
```

- [ ] **Step 2: Smoke-check the server starts and lists the tool**

Run:
```bash
cd ~/smart-volume-radar-engine/mcp-tv-sync
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node index.js
```
Expected: two JSON-RPC response lines on stdout; the second contains `"name":"tv_sync"` and the `watchlist` enum with the four list names. (Process stays open on stdio — Ctrl-C to exit.)

- [ ] **Step 3: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/index.js
git commit -m "feat(tv-sync-mcp): stdio server exposing tv_sync tool with outer timeout"
```

---

## Task 4: README + registration

**Files:**
- Create: `mcp-tv-sync/README.md`

- [ ] **Step 1: Write the README**

Create `mcp-tv-sync/README.md`:

```markdown
# svr-tv-sync MCP

Local stdio MCP server wrapping the repo's TradingView sync. Exposes one tool,
`tv_sync`, which runs `npm run tv-sync -- <flags>` in the repo root — identical
behavior to a manual run, using the persistent Chromium profile at
`~/.cache/svr-tv-sync/chromium-profile`.

## Prerequisites
- `npm install` in this folder.
- A logged-in TradingView profile (one-time: `npm run tv-sync -- --login` in the repo root).

## tv_sync parameters
| Param | Maps to | Default |
|-------|---------|---------|
| `dryRun` | `--dry-run` (preview diff, no writes) | false |
| `replace` | `--replace` (remove non-target symbols) | false |
| `headed` | `--headed` (visible browser) | false |
| `watchlist` | `--watchlist "NAME"` (one of the four lists) | all |

Outer timeout: `TV_SYNC_TIMEOUT_MS` env (default 35 min); on timeout the child is killed and an error is returned.

## Register (project-scoped) with Claude Code
From the repo root:
\`\`\`bash
claude mcp add svr-tv-sync --scope project -- node mcp-tv-sync/index.js
\`\`\`
This writes a `.mcp.json` entry in the repo. Reload Claude Code to pick it up.
```

- [ ] **Step 2: Register the server (project scope)**

Run:
```bash
cd ~/smart-volume-radar-engine
claude mcp add svr-tv-sync --scope project -- node mcp-tv-sync/index.js
claude mcp list
```
Expected: `claude mcp list` shows `svr-tv-sync`. A `.mcp.json` appears in the repo root.

- [ ] **Step 3: Commit**

```bash
cd ~/smart-volume-radar-engine
git add mcp-tv-sync/README.md .mcp.json
git commit -m "docs(tv-sync-mcp): README + project-scoped registration"
```

---

## Task 5: Parity verification (manual)

This is the acceptance gate from the spec — proves the MCP behaves like today.

- [ ] **Step 1: Baseline — run dry-run by hand**

Run:
```bash
cd ~/smart-volume-radar-engine
npm run tv-sync -- --dry-run 2>&1 | tee /tmp/tv-baseline.txt
```
Expected: completes, prints the per-watchlist add/remove diff, exits 0. Note the diff lines.

- [ ] **Step 2: Run the same through the MCP**

In a Claude Code session with the server loaded, call the tool:
`tv_sync({ "dryRun": true })`
Expected: returns `tv_sync exited 0`, and the stdout tail contains the **same** add/remove diff lines as `/tmp/tv-baseline.txt`.

- [ ] **Step 3: Confirm parity**

Compare the diff section of the MCP output against `/tmp/tv-baseline.txt`. The add/remove decisions must match. If they differ, STOP — the wrapper is not passing through cleanly (check cwd, env, flags).

- [ ] **Step 4: Live smoke test (smallest list)**

Call: `tv_sync({ "watchlist": "Lean Radar - Near" })`
Expected: `tv_sync exited 0`; `statePath` points at the written `tv-state.json`; the list updates in TradingView. (This performs real writes.)

- [ ] **Step 5: Record completion**

No commit needed (verification only). Note results back to the user; v1 is done.

---

## Self-Review notes
- **Spec coverage:** thin wrapper (Task 3) ✓; four flags dryRun/replace/watchlist/headed (Tasks 2–3) ✓; shell-out to `npm run tv-sync` with repo cwd ✓; local persistent-profile auth (inherited via cwd + env) ✓; outer-timeout stall mitigation (Task 3, `TV_SYNC_TIMEOUT_MS`) ✓; returns exitCode/summary/statePath ✓; buildArgs unit-tested + manual parity test (Tasks 2, 5) ✓; project-scoped registration (Task 4) ✓.
- **Type consistency:** `buildArgs`/`WATCHLISTS` names and signatures match across Tasks 2–3; the `watchlist` enum in the tool schema is sourced from the same `WATCHLISTS` constant.
- **Out of scope (unchanged):** granular tools, CI-mode in MCP, deep per-action retry inside the script, streaming.
```

