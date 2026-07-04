# svr-tv-sync MCP — Design (v1, thin wrapper)

**Date:** 2026-06-18
**Status:** Approved for planning
**Author:** Kobi + Claude

## Goal

Expose the existing TradingView watchlist sync as an MCP tool that any MCP client
(Claude) can call directly, producing output **identical** to running the sync by
hand today. v1 re-implements no business logic — it shells out to the existing,
proven script. Granular tools (read/add/remove as separate tools) are explicitly
out of scope for v1 and deferred to a later version.

## Background — what runs today

The current sync is `scripts/sync-tv-watchlist.ts` (~944 lines, invoked via
`npm run tv-sync`, which is `tsx scripts/sync-tv-watchlist.ts`). It:

- Drives Chromium via **Playwright** to open TradingView.
- Rotates through **4 watchlists**: `Smart Radar - BUY`, `Smart Radar - WATCH`,
  `Lean Radar - Breakouts`, `Lean Radar - Near`.
- Reads current symbols, computes an add/remove **delta**, applies staleness
  pruning + health-check integration.
- Persists state across runs in `~/.cache/svr-tv-sync/` (ticker-history,
  first-seen dates, exchange registry, prune queue).
- Runs in two modes: **local** (persistent Chromium profile at
  `~/.cache/svr-tv-sync/chromium-profile`) and **CI** (cookies injected via the
  `TV_COOKIES` GitHub Actions secret).
- Supports flags: `--dry-run`, `--replace`, `--headed`, `--watchlist NAME`,
  `--file PATH`, `--login`, `--prune-after-days N`.

**Known open bug:** the 2026-06-02 run hung ~16 min on a page stall with no
timeout/retry (see memory `tv-sync-stall-incident`).

## Architecture

A small **stdio MCP server** living inside the repo at
`~/smart-volume-radar-engine/mcp-tv-sync/`, with its own
`package.json` so its `@modelcontextprotocol/sdk` dependency stays isolated from
the main project's deps. It mirrors the existing `~/telegram-mcp` conventions:
CommonJS, `index.js` entry, `@modelcontextprotocol/sdk` ^1.29.

The server does **not** interact with TradingView directly. It spawns
`npm run tv-sync -- [flags]` as a child process with `cwd` set to the repo root.
This is the parity guarantee: same entrypoint, same persistent Chromium profile,
same state files, same behavior as a manual run.

```
MCP client (Claude)
   │  tv_sync({dryRun, replace, watchlist, headed})
   ▼
mcp-tv-sync/index.js  (stdio server)
   │  buildArgs() -> argv[]
   ▼
child_process: npm run tv-sync -- [flags]   (cwd = repo)
   ▼
scripts/sync-tv-watchlist.ts  (unchanged — Playwright → TradingView)
```

## The tool: `tv_sync`

| Param | Type | Maps to | Default |
|-------|------|---------|---------|
| `dryRun` | boolean | `--dry-run` | false |
| `replace` | boolean | `--replace` | false |
| `watchlist` | enum: `Smart Radar - BUY` \| `Smart Radar - WATCH` \| `Lean Radar - Breakouts` \| `Lean Radar - Near` | `--watchlist "NAME"` | (all) |
| `headed` | boolean | `--headed` | false |

**Returns** (structured text content):

- `exitCode` — child process exit code.
- `summary` — tail of stdout/stderr containing the add/remove diff.
- `statePath` — path to `tv-state.json` if it was written this run, else null.
- On failure (non-zero exit or timeout): the stderr tail so the cause is visible.

## Auth / session

Runs **locally** against the existing logged-in Chromium profile
(`~/.cache/svr-tv-sync/chromium-profile`). No CI cookies. The one-time
`npm run tv-sync -- --login` has already been performed. The MCP inherits the
profile automatically by shelling out in the same repo. CI mode is out of scope
for v1 (the MCP is a local convenience layer; GitHub Actions keeps running the
script directly on its own schedule).

## Stall safety (single folded-in improvement)

v1 wraps the child process in an **outer timeout** (default ~35 min, configurable
via env var, e.g. `TV_SYNC_TIMEOUT_MS`). On timeout the child is killed and the
tool returns a clean error instead of hanging forever. This is the minimal,
non-invasive mitigation for the 2026-06-02 stall — it does **not** modify the
script internals. A deeper fix (per-action timeout/retry inside the script)
remains a separate future task.

## Code layout

```
mcp-tv-sync/
  package.json        # @modelcontextprotocol/sdk ^1.29, bin entry, CommonJS
  index.js            # stdio server + tv_sync tool handler + outer timeout
  src/buildArgs.js    # pure: ({dryRun,replace,watchlist,headed}) -> argv[]
  test/buildArgs.test.js  # unit tests for arg mapping
  README.md           # registration + usage
```

`buildArgs.js` is pure and unit-tested. The child-process glue is covered by the
manual parity test below.

## Error handling

- **Non-zero exit:** return `exitCode` + stderr tail; do not throw.
- **Timeout:** kill child, return explicit timeout error with elapsed time.
- **Invalid `watchlist` value:** rejected by the tool's input schema (enum) before
  spawning.
- **Repo / script missing:** fail fast with a clear message pointing at the
  expected repo path.

## Testing

1. **Unit** — `buildArgs()` maps every param combination to the correct argv array
   (flags present/absent, watchlist quoting, default = no flags).
2. **Parity (manual)** — call `tv_sync({dryRun:true})` via MCP **and** run
   `npm run tv-sync -- --dry-run` by hand; diff the two diff outputs. Identical =
   parity proven.
3. **Live smoke (manual)** — `tv_sync({watchlist:"Lean Radar - Near"})` (smallest
   list) as a real end-to-end check.

## Registration

Register as a **project-scoped** MCP server (so it loads only for this project),
following the same registration pattern already used for `telegram-mcp` in the
Claude config.

## Out of scope for v1 (future versions)

- Granular tools (`tv_read_watchlist`, `tv_add_symbols`, `tv_remove_symbols`).
- CI-mode support inside the MCP.
- Deep per-action timeout/retry hardening inside `sync-tv-watchlist.ts`.
- Streaming progress (MCP v1 is request/response; full output returned at end).
