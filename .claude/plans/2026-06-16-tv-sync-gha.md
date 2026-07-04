# TV Sync → GitHub Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the nightly TradingView watchlist sync from a Mac LaunchAgent (misses runs when Mac sleeps) to a GitHub Actions workflow that fires automatically after each radar scan completes.

**Architecture:** Add a CI mode to `sync-tv-watchlist.ts` that injects a TradingView session cookie (stored as a GitHub Secret) instead of reading from a local Chromium persistent profile. A new `tv-sync.yml` workflow triggers on successful completion of the Smart Radar scan, downloads both radar artifacts via `gh CLI` (same as today), and commits `tv-state.json` back to the repo. State files (ticker history, exchange registry) persist across GHA runs via a dedicated artifact.

**Tech Stack:** TypeScript, Playwright (Chromium headless), GitHub Actions (`workflow_run` trigger), `gh` CLI (already available in GHA runners)

---

## File Map

| File | Action | What changes |
|---|---|---|
| `scripts/export-tv-cookies.ts` | **Create** | One-time helper: reads cookies from local Chromium profile → prints base64 JSON for pasting into GH secret |
| `scripts/sync-tv-watchlist.ts` | **Modify** | Add CI mode: cookie injection, CI-safe paths, commit-ready tv-state.json path |
| `.github/workflows/tv-sync.yml` | **Create** | New workflow: triggers after Smart Radar, runs TV sync, persists state artifact, commits tv-state.json |
| `package.json` | **Modify** | Add `export-tv-cookies` npm script |

---

## Task 1: Cookie export helper script

**Purpose:** One-time tool to export the live TradingView session from the local Chromium profile so we can store it as a GitHub Secret.

**Files:**
- Create: `scripts/export-tv-cookies.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/export-tv-cookies.ts`**

```typescript
#!/usr/bin/env npx tsx
/**
 * export-tv-cookies — one-time helper.
 * Reads TradingView session cookies from the local Playwright persistent
 * profile and prints them as base64-encoded JSON to stdout.
 *
 * Usage:
 *   npx tsx scripts/export-tv-cookies.ts
 *   # Copy the output, then:
 *   gh secret set TV_COOKIES --body "<paste output>" --repo KobiHaz/StockMarketBot
 */
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';

const PROFILE_DIR = path.join(os.homedir(), '.cache', 'svr-tv-sync', 'chromium-profile');

async function main() {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
    const cookies = await context.cookies('https://www.tradingview.com');
    await context.close();

    if (cookies.length === 0) {
        process.stderr.write('❌ No cookies found. Run `npm run tv-sync -- --login` first.\n');
        process.exit(1);
    }

    const b64 = Buffer.from(JSON.stringify(cookies)).toString('base64');
    process.stdout.write(b64 + '\n');
    process.stderr.write(`✓ Exported ${cookies.length} cookies. Paste into GitHub Secret "TV_COOKIES".\n`);
    process.stderr.write('  gh secret set TV_COOKIES --body "<paste>" --repo KobiHaz/StockMarketBot\n');
}

main().catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
```

- [ ] **Step 2: Add npm script to `package.json`**

In the `"scripts"` block, add after the existing `"tv-sync"` line:

```json
"export-tv-cookies": "tsx scripts/export-tv-cookies.ts"
```

- [ ] **Step 3: Run the export and set the secret**

```bash
cd ~/smart-volume-radar-engine
npx tsx scripts/export-tv-cookies.ts | pbcopy
```

Then:
```bash
gh secret set TV_COOKIES --body "$(pbpaste)" --repo KobiHaz/StockMarketBot
```

Verify the secret was set:
```bash
gh secret list --repo KobiHaz/StockMarketBot | grep TV_COOKIES
```
Expected output: `TV_COOKIES  Updated <today>`

- [ ] **Step 4: Commit**

```bash
cd ~/smart-volume-radar-engine
git add scripts/export-tv-cookies.ts package.json
git commit -m "feat: add export-tv-cookies helper for GHA secret setup"
```

---

## Task 2: Add CI mode to `sync-tv-watchlist.ts`

The current script uses `chromium.launchPersistentContext()` which requires the local Chromium profile directory. In CI, we inject cookies instead.

**Files:**
- Modify: `scripts/sync-tv-watchlist.ts`

**What to change** (3 places):

**Change A — CI detection constant** (add after the existing `const PRUNE_AFTER_DAYS` line, ~line 79):

- [ ] **Step 1: Add CI constants near the top of the config block**

Find this block (~line 42–79):
```typescript
const PROFILE_DIR = path.join(os.homedir(), '.cache', 'svr-tv-sync', 'chromium-profile');
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs');
```

Replace with:
```typescript
const IS_CI = process.env.CI === 'true';
const PROFILE_DIR = path.join(os.homedir(), '.cache', 'svr-tv-sync', 'chromium-profile');
const LOG_DIR = IS_CI
    ? (process.env.GITHUB_WORKSPACE ?? process.cwd())
    : path.join(os.homedir(), 'Library', 'Logs');
const TV_COOKIES_FILE = process.env.TV_COOKIES_FILE ?? '';
```

**Change B — CI-safe tv-state.json path** (~line 880):

- [ ] **Step 2: Update tv-state.json write path to support CI**

Find:
```typescript
const tvStatePath = path.join(os.homedir(), 'telegram-mcp', 'data', 'tv-state.json');
```

Replace with:
```typescript
const tvStatePath = IS_CI
    ? path.join(process.env.GITHUB_WORKSPACE ?? process.cwd(), 'results', 'tv-state.json')
    : path.join(os.homedir(), 'telegram-mcp', 'data', 'tv-state.json');
```

**Change C — CI browser launch with cookie injection** (~line 794–800):

- [ ] **Step 3: Replace browser launch block to support both modes**

Find:
```typescript
        context = await chromium.launchPersistentContext(PROFILE_DIR, {
            headless: !HEADED,
            viewport: { width: 1400, height: 900 },
            args: ['--disable-blink-features=AutomationControlled'],
        });
        const page = context.pages()[0] ?? (await context.newPage());
```

Replace with:
```typescript
        if (IS_CI) {
            // In CI: regular launch + inject cookies from TV_COOKIES_FILE secret.
            const browser = await chromium.launch({
                headless: true,
                args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
            });
            context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
            if (TV_COOKIES_FILE && fs.existsSync(TV_COOKIES_FILE)) {
                const cookies = JSON.parse(fs.readFileSync(TV_COOKIES_FILE, 'utf8'));
                await context.addCookies(cookies);
                log(`🍪 Injected ${cookies.length} cookies from ${TV_COOKIES_FILE}`);
            } else {
                throw new Error('CI mode requires TV_COOKIES_FILE env var pointing to a cookies JSON file.');
            }
        } else {
            context = await chromium.launchPersistentContext(PROFILE_DIR, {
                headless: !HEADED,
                viewport: { width: 1400, height: 900 },
                args: ['--disable-blink-features=AutomationControlled'],
            });
        }
        const page = context.pages()[0] ?? (await context.newPage());
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd ~/smart-volume-radar-engine
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-tv-watchlist.ts
git commit -m "feat(tv-sync): add CI mode with cookie injection and CI-safe paths"
```

---

## Task 3: Create the GHA workflow

**Files:**
- Create: `.github/workflows/tv-sync.yml`

- [ ] **Step 1: Create `.github/workflows/tv-sync.yml`**

```yaml
name: TV Watchlist Sync

on:
  # Fire after the Smart Radar scan completes (Lean runs in parallel; the sync
  # script downloads artifacts from both workflows independently, so Lean's
  # artifact is picked up regardless of which finished first).
  workflow_run:
    workflows: ["Smart Volume Radar - Daily Scan"]
    types: [completed]

  # Manual trigger for testing / catch-up runs.
  workflow_dispatch:

jobs:
  tv-sync:
    # Only run when the upstream scan succeeded (skip on failure/cancel).
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write   # to commit tv-state.json back to repo
      actions: read     # to download artifacts from other workflows via gh CLI

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright Chromium
        run: npx playwright install chromium --with-deps

      # Restore persisted state (ticker history, exchange registry).
      # On first run ever this step is a no-op (artifact doesn't exist yet).
      - name: Restore TV sync state
        uses: actions/download-artifact@v4
        with:
          name: tv-sync-state
          path: /home/runner/.cache/svr-tv-sync/
        continue-on-error: true

      # Decode the TV_COOKIES secret (base64 JSON) and write to temp file.
      - name: Prepare TradingView cookies
        run: |
          echo "${{ secrets.TV_COOKIES }}" | base64 -d > /tmp/tv-cookies.json
          echo "TV_COOKIES_FILE=/tmp/tv-cookies.json" >> $GITHUB_ENV

      - name: Run TV sync
        env:
          CI: 'true'
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TV_COOKIES_FILE: ${{ env.TV_COOKIES_FILE }}
          GITHUB_WORKSPACE: ${{ github.workspace }}
        run: npm run tv-sync

      # Persist state files for the next run (ticker history, first-seen, exchange registry).
      - name: Save TV sync state
        if: success()
        uses: actions/upload-artifact@v4
        with:
          name: tv-sync-state
          path: /home/runner/.cache/svr-tv-sync/
          retention-days: 90
          overwrite: true

      # Commit tv-state.json back to repo so telegram-mcp can read it.
      - name: Commit tv-state.json
        if: success() && hashFiles('results/tv-state.json') != ''
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add results/tv-state.json
          if git diff --staged --quiet; then
            echo "tv-state.json unchanged — nothing to commit"
          else
            git commit -m "chore: update tv-state.json (tv-sync $(date -u +%Y-%m-%d))"
            git pull --rebase origin main || true
            git push origin HEAD:main
          fi

      - name: Notify Telegram on failure
        if: failure()
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
        run: |
          curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d "chat_id=${TELEGRAM_CHAT_ID}&text=❌ TV Sync (GHA) failed. Check GitHub Actions."
```

- [ ] **Step 2: Commit**

```bash
cd ~/smart-volume-radar-engine
git add .github/workflows/tv-sync.yml
git commit -m "feat: add tv-sync GitHub Actions workflow (replaces LaunchAgent)"
```

---

## Task 4: End-to-end test

- [ ] **Step 1: Push to origin**

```bash
cd ~/smart-volume-radar-engine
git push origin main
```

- [ ] **Step 2: Trigger manually and monitor**

```bash
gh workflow run tv-sync.yml --repo KobiHaz/StockMarketBot
```

Then watch:
```bash
gh run watch --repo KobiHaz/StockMarketBot
```

Expected: All 4 sync steps logged, `✓ added`/`✓ removed` lines, screenshot uploaded as artifact.

- [ ] **Step 3: Verify tv-state.json was committed**

```bash
gh api repos/KobiHaz/StockMarketBot/commits?per_page=3 | python3 -c "
import json,sys
for c in json.load(sys.stdin):
    print(c['commit']['message'][:60])
"
```

Expected: latest commit starts with `chore: update tv-state.json`.

- [ ] **Step 4: Verify TV watchlists visually**

Open TradingView and confirm the 4 watchlists reflect the latest scan data.

- [ ] **Step 5: Disable LaunchAgent to avoid double-syncing**

```bash
launchctl unload ~/Library/LaunchAgents/com.smart-volume-radar.tv-sync.plist
```

Keep the plist file (don't delete) — reload with `launchctl load` if you ever need it back.

---

## Task 5: Update telegram-mcp to read tv-state.json from repo (follow-up)

> **Note:** This task is out of scope for the current PR. The telegram-mcp watchlist health-check reads `~/telegram-mcp/data/tv-state.json` which is no longer written locally once the LaunchAgent is disabled. This is tracked as a follow-up.
>
> **Interim workaround:** Run `git pull` in the smart-volume-radar repo on the Mac periodically — the health-check will pick up the committed `results/tv-state.json` if you symlink it:
> ```bash
> ln -sf ~/smart-volume-radar-engine/results/tv-state.json \
>        ~/telegram-mcp/data/tv-state.json
> ```

---

## Self-Review

**Spec coverage:**
- ✅ Runs without Mac (GHA workflow)
- ✅ Triggers automatically after scan (workflow_run)
- ✅ All 4 watchlists synced
- ✅ Staleness pruning preserved (state artifact)
- ✅ tv-state.json committed back to repo
- ✅ Cookie session injected from secret (no persistent profile needed in CI)
- ✅ One-time cookie export tooling

**Placeholders scan:** None found.

**Type consistency:**
- `IS_CI: boolean` — consistent across all usages
- `TV_COOKIES_FILE: string` — read from env, passed to `fs.readFileSync` and `context.addCookies`
- `context: BrowserContext | null` — type unchanged, both branches assign a valid `BrowserContext`
