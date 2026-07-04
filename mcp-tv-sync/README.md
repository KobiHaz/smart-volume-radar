# svr-tv-sync MCP

Local stdio MCP server wrapping the repo's TradingView sync. Exposes one tool,
`svr_sync`, which runs `npm run tv-sync -- <flags>` in the repo root — identical
behavior to a manual run, using the persistent Chromium profile at
`~/.cache/svr-tv-sync/chromium-profile`. It re-implements no sync logic.

## Prerequisites
- `npm install` in this folder (installs `@modelcontextprotocol/sdk`).
- A logged-in TradingView profile (one-time, from the repo root:
  `npm run tv-sync -- --login`).
- `npm` and `node` must be on the `PATH` of the process that launches this MCP
  server. Note: GUI-launched Claude clients (e.g. Claude Desktop) may not inherit
  your shell `PATH` under nvm/fnm — if `svr_sync` returns a spawn/ENOENT error,
  that's the cause. The Claude Code CLI launched from a normal shell is fine.

## svr_sync parameters
| Param | Maps to | Default |
|-------|---------|---------|
| `dryRun` | `--dry-run` (preview diff, no writes) | false |
| `replace` | `--replace` (remove non-target symbols) | false |
| `headed` | `--headed` (visible browser) | false |
| `watchlist` | `--watchlist "NAME"` (one of the four lists) | all |

Watchlist names: `Smart Radar - BUY`, `Smart Radar - WATCH`,
`Lean Radar - Breakouts`, `Lean Radar - Near`.

Outer timeout: `TV_SYNC_TIMEOUT_MS` env (default 35 min). On timeout the child
process is killed (SIGKILL) and the tool returns a clear error instead of hanging.

## Register with Claude Code
The server path is absolute so it resolves regardless of which directory you
launch Claude from:

```bash
claude mcp add svr-tv-sync --scope project -- \
  node /Users/kobihazout/smart-volume-radar-engine/mcp-tv-sync/index.js
```

`--scope project` writes a `.mcp.json` entry scoped to the current project.
Use `--scope user` instead to make it available in every project. Reload Claude
Code after registering so it picks up the new server, then call `svr_sync`.

## Verify (no writes)
Call `svr_sync({ "dryRun": true })` — it reads TradingView and prints the
add/remove diff without changing anything. This should match running
`npm run tv-sync -- --dry-run` by hand.
