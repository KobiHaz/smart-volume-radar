# tv-sync stall hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sync-tv-watchlist.ts` fail-fast/recover per-list so one stalled action can't hang the whole nightly (the 2026-06-02 incident class).

**Architecture:** Three minimal structural changes to the one script: explicit page/navigation timeouts, a per-list bounded retry around `syncWatchlist` in the 4-list loop, and a wall-clock deadline on the `readCurrentSymbols` scroll loop. Reuses the existing `tryWithin(timeout, op)` helper. No new files, no unit tests (browser-bound) — verified by a normal dry-run + a forced-timeout run.

**Tech Stack:** TypeScript via `tsx`, Playwright ^1.60.

Repo root: `~/.gemini/antigravity/projects/smart-volume-radar`. Branch: `feat/tv-sync-stall-hardening`. All edits in `scripts/sync-tv-watchlist.ts`.

---

## Task 1: Apply the three hardening changes

**Files:** Modify `scripts/sync-tv-watchlist.ts`

- [ ] **Step 1: Add the tunable constants**

Find (around line 83):
```ts
const PRUNE_AFTER_DAYS = parseInt(arg('prune-after-days', '14'), 10);
```
Insert immediately AFTER it:
```ts
// ── Stall hardening: bounded timeouts so one hung action can't block the run ──
const NAV_TIMEOUT_MS = 45000;             // page.goto / navigation
const DEFAULT_ACTION_TIMEOUT_MS = 20000;  // default per Playwright action
const PER_LIST_TIMEOUT_MS = Number(process.env.TV_PER_LIST_TIMEOUT_MS) || 3 * 60 * 1000; // cap per watchlist (×2 attempts)
const SCROLL_DEADLINE_MS = 30000;         // readCurrentSymbols scroll loop
```

- [ ] **Step 2: Set explicit default timeouts after the page is created**

Find (around line 1006):
```ts
        const page = context.pages()[0] ?? (await context.newPage());
```
Replace with:
```ts
        const page = context.pages()[0] ?? (await context.newPage());
        page.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
```

- [ ] **Step 3: Add explicit `timeout` to the three `page.goto` calls**

3a. Find (line ~945):
```ts
    await page.goto(url, { waitUntil: 'domcontentloaded' });
```
Replace with:
```ts
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
```

3b. Find (line ~1010):
```ts
            await page.goto('https://www.tradingview.com/#signin', {
                waitUntil: 'domcontentloaded',
            });
```
Replace with:
```ts
            await page.goto('https://www.tradingview.com/#signin', {
                waitUntil: 'domcontentloaded',
                timeout: NAV_TIMEOUT_MS,
            });
```

3c. Find (line ~1028):
```ts
        await page.goto('https://www.tradingview.com/chart/', {
            waitUntil: 'domcontentloaded',
        });
```
Replace with:
```ts
        await page.goto('https://www.tradingview.com/chart/', {
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT_MS,
        });
```

- [ ] **Step 4: Per-list bounded retry in the 4-list sync loop**

Find (around line 1091, inside `for (const t of tasks)`):
```ts
            log(`📂 ${t.name} ← ${resolvedFile}`);
            await syncWatchlist(page, target, t.name);
        }
```
Replace with:
```ts
            log(`📂 ${t.name} ← ${resolvedFile}`);
            // Bound each list: on timeout OR error, retry once, then skip and
            // continue — a single stalled/failed list must not abort the run.
            const runList = () =>
                tryWithin(PER_LIST_TIMEOUT_MS, async () => {
                    await syncWatchlist(page, target, t.name);
                    return true;
                });
            let listOk = await runList();
            if (listOk === null) {
                log(`  ⚠️ "${t.name}" timed out/failed — retrying once...`);
                listOk = await runList();
            }
            if (listOk === null) {
                log(`  ⚠️ "${t.name}" timed out/failed twice — skipping.`);
            }
        }
```

- [ ] **Step 5: Wall-clock deadline on the `readCurrentSymbols` scroll loop**

Find (around line 522):
```ts
        let pos = 0;
        let stagnant = 0;
        while (pos < scrollHeight + step) {
            await container.evaluate((el, p) => {
```
Replace with:
```ts
        let pos = 0;
        let stagnant = 0;
        const scrollDeadline = Date.now() + SCROLL_DEADLINE_MS;
        while (pos < scrollHeight + step) {
            if (Date.now() > scrollDeadline) {
                log(`  ⚠️ watchlist scroll exceeded ${Math.round(SCROLL_DEADLINE_MS / 1000)}s — using partial read`);
                break;
            }
            await container.evaluate((el, p) => {
```

- [ ] **Step 6: Compile + normal dry-run (no behavior regression)**

Run:
```bash
cd ~/.gemini/antigravity/projects/smart-volume-radar
npm run tv-sync -- --dry-run 2>&1 | grep -E "SYNCING|to add|stale|Target|Error|error TS|timed out|skipping" | head -40
```
Expected: no TypeScript errors; the four lists scan and print their normal diffs exactly as before (no "timed out/skipping" lines under normal load). This proves no regression.

- [ ] **Step 7: Commit**

```bash
cd ~/.gemini/antigravity/projects/smart-volume-radar
git add scripts/sync-tv-watchlist.ts
git commit -m "feat(tv-sync): stall hardening — explicit timeouts, per-list bounded retry, scroll deadline"
```

---

## Task 2: Forced-timeout verification (manual)

Prove the retry/skip path fires and the run still completes.

- [ ] **Step 1: Force a tiny per-list timeout**

Run (1-second per-list cap forces every list to "time out"):
```bash
cd ~/.gemini/antigravity/projects/smart-volume-radar
TV_PER_LIST_TIMEOUT_MS=1000 npm run tv-sync -- --dry-run 2>&1 | grep -E "SYNCING|retrying once|skipping|Screenshot saved|Error" | head -40
```
Expected: each list logs `⚠️ "<name>" timed out/failed — retrying once...` then `⚠️ "<name>" timed out/failed twice — skipping.`, the loop proceeds through all four lists, and the run reaches the end (screenshot saved) and exits 0 — i.e. a per-list stall no longer hangs or aborts the run.

- [ ] **Step 2: Confirm normal run is unaffected**

Re-run `npm run tv-sync -- --dry-run` (no env override) and confirm the four lists produce their normal diffs with NO timeout/skip lines.

- [ ] **Step 3: Report results.** No commit (verification only).

---

## Self-Review notes
- **Spec coverage:** explicit default + nav timeouts (Steps 1–3) ✓; per-list bounded retry w/ continue (Step 4) ✓; scroll-loop deadline (Step 5) ✓; reuses `tryWithin`, no new infra ✓; per-list wrap collapses timeout+error to null → retry→skip, intended non-fatal (Step 4) ✓; single-list/granular/screenshot paths untouched (changes only in the 4-list loop + shared nav/scroll) ✓; env-overridable PER_LIST_TIMEOUT_MS for the forced test (Step 1) ✓; manual dry-run + forced-timeout verification (Task 2) ✓.
- **Consistency:** constant names `NAV_TIMEOUT_MS`/`DEFAULT_ACTION_TIMEOUT_MS`/`PER_LIST_TIMEOUT_MS`/`SCROLL_DEADLINE_MS` declared once (Step 1) and referenced in Steps 2–5; `tryWithin` is the existing helper (returns `T|null`), and the op returns `true` so the result type is `boolean|null` and `=== null` cleanly means timeout-or-error.
- **Out of scope:** per-symbol micro-timeouts, screenshot-nav retry, backoff.
```

