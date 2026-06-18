#!/usr/bin/env node
'use strict';
/**
 * svr-tv-sync MCP server
 * Exposes one tool, tv_sync, that shells out to the repo's `npm run tv-sync`
 * so behavior is identical to a manual run. No sync logic lives here.
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
const { buildArgs, WATCHLISTS } = require('./src/buildArgs.js');

// Repo root is the parent of this MCP package directory.
const REPO_DIR = path.resolve(__dirname, '..');
const STATE_PATH = path.join(os.homedir(), 'telegram-mcp', 'data', 'tv-state.json');
const TIMEOUT_MS = Number(process.env.TV_SYNC_TIMEOUT_MS) || 35 * 60 * 1000;
const MAX_OUTPUT_TAIL = 4000; // chars returned from each stream
const MAX_BUFFER = 1_000_000; // cap each stream's retained bytes (~1MB)

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
      settle({
        exitCode: code,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        startedAt,
      });
    });

    child.on('error', (err) => {
      settle({
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
})().catch((err) => {
  process.stderr.write(`svr-tv-sync failed to start: ${err.message}\n`);
  process.exit(1);
});
