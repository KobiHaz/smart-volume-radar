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
const radar = require('./src/radarData.js');

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

  const screenshotFailText = (why) =>
    `${request.params.name} failed (${why}). flags: [${flags.join(' ')}]\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}`;

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
    if (result.timedOut) return { isError: true, content: [{ type: 'text', text: screenshotFailText(`timed out after ${minutes} min`) }] };
    if (parsed === null || parsed.error != null || !Array.isArray(parsed.shots) || parsed.shots.length === 0) {
      return { isError: true, content: [{ type: 'text', text: screenshotFailText(parsed && parsed.error ? parsed.error : 'no screenshots in result') }] };
    }
    const { blocks, imageCount } = shotsToContent(parsed);
    if (imageCount === 0) return { isError: true, content: [{ type: 'text', text: screenshotFailText('no readable screenshot files') }] };
    return { isError: result.exitCode !== 0, content: blocks };
  }

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
      process.stderr.write(`[deepdive] radar load failed: ${err.stack || err.message}\n`);
      radarBlock = `Radar state unavailable: ${err.message}`;
    }

    const parsed = result.timedOut ? null : parseGranularResult(result.stdout);
    const deepFail = (why) => ({
      isError: true,
      content: [
        { type: 'text', text: radarBlock },
        { type: 'text', text: screenshotFailText(why) },
      ],
    });
    if (result.timedOut) return deepFail(`timed out after ${minutes} min`);
    if (parsed === null || parsed.error != null || !Array.isArray(parsed.shots) || parsed.shots.length === 0) {
      return deepFail(parsed && parsed.error ? parsed.error : 'no screenshots in result');
    }
    const { blocks, imageCount } = shotsToContent(parsed);
    if (imageCount === 0) return deepFail('no readable screenshot files');
    return { isError: result.exitCode !== 0, content: [{ type: 'text', text: radarBlock }, ...blocks] };
  }

  if (spec.kind !== 'sync') {
    throw new Error(`Unhandled kind '${spec.kind}' for tool ${request.params.name}`);
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
