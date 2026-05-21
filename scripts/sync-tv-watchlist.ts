#!/usr/bin/env npx tsx
/**
 * Smart Volume Radar — sync the daily "breakout track" watchlist into TradingView.
 *
 * Long-term automation: runs nightly via a LaunchAgent on the user's mac.
 * Uses Playwright with a persistent Chromium profile (NOT the user's daily
 * Chrome — fully isolated). One-time login by the user, after which the
 * session persists indefinitely in the profile dir.
 *
 * Flow:
 *   1. Download the latest tv-watchlist-latest.txt from the most recent
 *      successful Lean Radar GitHub Actions artifact (no network call
 *      to TradingView yet — we just have the list of symbols).
 *   2. Open TradingView's chart page in the persistent Chromium profile.
 *   3. Open the named watchlist (creates if missing).
 *   4. Read existing symbols. Diff vs. target list:
 *        - Add symbols that are in target but not in TV.
 *        - Optionally remove symbols that are in TV but not in target
 *          (controlled by --replace flag; default is additive-only).
 *   5. Take a screenshot for audit (~/Library/Logs/tv-sync-{date}.png).
 *
 * Modes:
 *   --login            One-time interactive: launches non-headless browser,
 *                      waits up to 5 minutes for user to log in, then exits.
 *                      Session cookies persist in PROFILE_DIR for future runs.
 *   --replace          Sync as REPLACE (remove TV symbols not in target).
 *                      Default is ADDITIVE (only add, never remove).
 *   --watchlist NAME   Watchlist name in TradingView (default: 'Lean Radar').
 *   --headed           Force visible browser (default: headless when not --login).
 *   --dry-run          Read TV state and target list, print diff, do not modify.
 *
 * Auth notes: TradingView's "Add symbols" UI is reached via a single button
 * on the right-side watchlist panel. Selectors are kept in TV_SELECTORS at
 * the top of the file so they can be updated when TV changes their DOM.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── Config ────────────────────────────────────────────────────────────
const PROFILE_DIR = path.join(os.homedir(), '.cache', 'svr-tv-sync', 'chromium-profile');
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs');
fs.mkdirSync(path.dirname(PROFILE_DIR), { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const REPO = 'KobiHaz/StockMarketBot';

// TradingView DOM selectors — update these when TV changes their HTML.
const TV_SELECTORS = {
    // Right-hand watchlist panel
    watchlistPanel: 'div[data-name="watchlists-dialog"], div.tv-screener-table',
    // The watchlist title dropdown (click to switch lists)
    watchlistTitleButton: 'button[data-name="watchlists-button"]',
    // Item in the dropdown for a named watchlist
    watchlistItem: (name: string) => `div[data-name="watchlists-menu"] >> text="${name}"`,
    // "+ Add symbol" button at the bottom of the watchlist
    addSymbolButton: 'button[data-name="add-symbol-button"]',
    // The autocomplete input that appears after clicking "Add symbol"
    symbolInput: 'input[data-name="symbol-search-input"]',
    // Each symbol row in the active watchlist
    symbolRow: 'div[data-name="list-item"]',
    symbolRowText: 'div[data-name="list-item"] [class*="symbolNameText"]',
    // Login form
    loginButton: 'button[data-name="header-user-menu-sign-in"]',
};

// ─── CLI ────────────────────────────────────────────────────────────
function arg(name: string, fallback = ''): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
function has(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

const LOGIN_MODE = has('login');
const DRY_RUN = has('dry-run');
const REPLACE = has('replace');
const HEADED = has('headed') || LOGIN_MODE;
const WATCHLIST_NAME = arg('watchlist', 'Lean Radar');
const WATCHLIST_FILE_EXPLICIT = process.argv.includes('--file');
const WATCHLIST_FILE = arg('file', path.join(PROJECT_ROOT, 'results', 'tv-watchlist-latest.txt'));
// Staleness pruning: remove tickers that haven't appeared in any tv-watchlist-*.txt
// for this many days. Set to 0 to disable. Default = 14 days (~3 trading weeks).
const PRUNE_AFTER_DAYS = parseInt(arg('prune-after-days', '14'), 10);
// Persistent history of when each ticker last appeared in a tv-watchlist file.
const HISTORY_PATH = path.join(os.homedir(), '.cache', 'svr-tv-sync', 'ticker-history.json');

// ─── Log helper ─────────────────────────────────────────────────────
const logPath = path.join(LOG_DIR, 'tv-sync.log');
function log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    console.error(line);
    fs.appendFileSync(logPath, line + '\n');
}

// ─── Step 1: Get the latest watchlist file ───────────────────────────
function downloadLatestArtifact(): string | null {
    log('🔎 Looking for the latest Lean Radar artifact via gh CLI...');
    try {
        // Find the latest successful run ID
        const runId = execSync(
            `gh run list --workflow="Lean Radar - Daily Scan" --status=success --limit 1 --json databaseId -q '.[0].databaseId' --repo ${REPO}`,
            { encoding: 'utf8' }
        ).trim();
        if (!runId) {
            log('⚠️ No successful runs found via gh CLI; falling back to local file.');
            return null;
        }
        log(`  ↳ latest run: ${runId}`);

        // Download to a temp dir
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svr-tv-'));
        execSync(`gh run download ${runId} --repo ${REPO} --dir "${tmpDir}"`, { encoding: 'utf8', stdio: 'pipe' });

        // Walk the temp dir for tv-watchlist-latest.txt
        const found = findFile(tmpDir, 'tv-watchlist-latest.txt');
        if (!found) {
            log('⚠️ Artifact downloaded but tv-watchlist-latest.txt not found in it.');
            return null;
        }
        log(`✓ Downloaded artifact watchlist: ${found}`);
        return found;
    } catch (e) {
        log(`⚠️ gh download failed: ${(e as Error).message}. Falling back to local file.`);
        return null;
    }
}

function findFile(dir: string, name: string): string | null {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const r = findFile(p, name);
            if (r) return r;
        } else if (entry.name === name) {
            return p;
        }
    }
    return null;
}

function parseWatchlist(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').map((l) => l.trim());
    return lines.filter((l) => l && !l.startsWith('#'));
}

// ─── Ticker history (for staleness pruning) ─────────────────────────
interface TickerHistory { [normalizedTicker: string]: string /* ISO date YYYY-MM-DD */; }

function loadHistory(): TickerHistory {
    if (!fs.existsSync(HISTORY_PATH)) return {};
    try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); }
    catch { return {}; }
}

function saveHistory(h: TickerHistory): void {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 2));
}

/** Update history: mark each ticker as seen today. */
function recordSeenTickers(symbols: string[]): void {
    const h = loadHistory();
    const today = new Date().toISOString().slice(0, 10);
    for (const s of symbols) {
        // Strip exchange prefix for stable history key
        const key = s.split(':').pop()!.toUpperCase();
        h[key] = today;
    }
    saveHistory(h);
}

/** Compute tickers that haven't been seen in the last `days` days. */
function findStaleTickers(currentInTv: string[], days: number): string[] {
    if (days <= 0) return [];
    const h = loadHistory();
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return currentInTv.filter((s) => {
        const key = s.split(':').pop()!.toUpperCase();
        const lastSeen = h[key];
        // If we've never seen this ticker before, treat it as not-stale (don't
        // remove things added before history existed — too aggressive).
        if (!lastSeen) return false;
        return lastSeen < cutoffStr;
    });
}

// ─── Step 2-4: Drive TradingView via Playwright ──────────────────────
async function isLoggedIn(page: Page): Promise<boolean> {
    // The "Sign in" button is only visible when logged out.
    const signInBtn = await page.$(TV_SELECTORS.loginButton);
    return !signInBtn;
}

/** Dismiss any popups/modals TradingView shows on first load (upgrade
 *  banner, signup nudge, cookie consent, etc.). Best-effort; ignores failures. */
async function dismissPopups(page: Page): Promise<void> {
    const closeSelectors = [
        'button[data-name="close"]',
        'button[aria-label="Close"]',
        'button[aria-label="close"]',
        '[data-dialog-name] [data-name="close"]',
        'div[role="dialog"] button[aria-label*="lose"]',
        // The TV-specific "Plans for every level" upgrade popup
        'div[class*="dialogClose"]',
        'span[class*="closeButton"]',
    ];
    for (let attempt = 0; attempt < 3; attempt++) {
        let closed = false;
        for (const sel of closeSelectors) {
            const els = await page.$$(sel);
            for (const el of els) {
                try {
                    if (await el.isVisible()) {
                        await el.click({ timeout: 1500 });
                        log(`  ✕ dismissed popup via ${sel}`);
                        closed = true;
                        await page.waitForTimeout(400);
                    }
                } catch { /* ignore */ }
            }
        }
        if (!closed) {
            // Final fallback — press Escape to close any modal
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
            break;
        }
    }
}

/** Try to do `op` and return result or null if it doesn't complete within `timeout` ms. */
async function tryWithin<T>(timeout: number, op: () => Promise<T>): Promise<T | null> {
    try {
        return await Promise.race([
            op(),
            new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout)),
        ]);
    } catch {
        return null;
    }
}

async function openWatchlist(page: Page, name: string): Promise<void> {
    log(`↳ Looking for watchlist "${name}"...`);
    await dismissPopups(page);

    // Click the watchlist dropdown (opens the "actions" menu — not the list browser)
    const titleBtn = await page.waitForSelector(TV_SELECTORS.watchlistTitleButton, { timeout: 15000 });
    await titleBtn.click();
    await page.waitForTimeout(700);

    // Click "Open list..." to get the list browser
    const openListBtn = await tryWithin(3000, async () => {
        const el = await page.getByText('Open list', { exact: false }).first().elementHandle();
        return el;
    });
    if (openListBtn) {
        log('  ↳ clicking "Open list…"');
        await openListBtn.click();
        await page.waitForTimeout(1500);

        // In the list-browser modal, look for our watchlist name (short timeout)
        const item = await tryWithin(3000, async () => {
            return page.getByText(name, { exact: true }).first().elementHandle();
        });
        if (item) {
            log(`✓ Found "${name}" — clicking`);
            // Force-click bypasses TradingView's backdrop overlay intercept
            await item.click({ force: true });
            await page.waitForTimeout(1500);
            await page.keyboard.press('Escape').catch(() => undefined);
            return;
        }
        log(`  "${name}" not in list browser, closing modal`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
    }

    // Create it via "Create new list"
    log(`⚠️ "${name}" not found; creating new list...`);
    // Reopen the action dropdown if closed
    const stillOpen = await tryWithin(1500, async () => {
        return page.getByText('Create new list', { exact: false }).first().elementHandle();
    });
    if (!stillOpen) {
        await titleBtn.click();
        await page.waitForTimeout(700);
    }
    const createBtn = await tryWithin(3000, async () => {
        return page.getByText('Create new list', { exact: false }).first().elementHandle();
    });
    if (!createBtn) {
        throw new Error('Could not find "Create new list" option in TradingView menu.');
    }
    await createBtn.click();
    await page.waitForTimeout(1200);

    // The "Create new list" dialog has an input for the name. Try common selectors.
    let nameInput =
        (await tryWithin(2000, () => page.$('input[type="text"]:visible'))) ??
        (await tryWithin(2000, () => page.$('input:visible')));
    if (!nameInput) {
        // Fallback: any focused input
        nameInput = await page.evaluate(() => {
            const el = document.activeElement;
            return el && el.tagName === 'INPUT' ? (el as HTMLInputElement) : null;
        }).then((res) => (res ? page.$('input:focus') : null));
    }
    if (!nameInput) {
        throw new Error('Could not find name input for new watchlist.');
    }
    await nameInput.fill(name);
    await page.waitForTimeout(400);
    // Enter typically confirms; also try Save/OK button as fallback
    await nameInput.press('Enter');
    await page.waitForTimeout(1500);
    log(`✓ Created watchlist "${name}"`);
}

/** Scroll the watchlist panel through its FULL height to materialize every
 *  virtualized row, accumulating data-symbol-short from each scroll position.
 *  TradingView virtualizes long watchlists — only visible rows are in DOM at
 *  any time. Without scrolling, readCurrentSymbols undercounts on lists > ~40. */
async function readCurrentSymbols(page: Page): Promise<string[]> {
    const all = new Set<string>();

    // Locate the scrollable watchlist container
    const containerHandle = await page.evaluateHandle(() => {
        // Try multiple candidate selectors for the scrollable list region
        const candidates = [
            '[data-name="symbol-list-wrap"]',
            'div[class*="symbolListWrapper"]',
            'div[class*="symbol-list"]',
            'div[class*="list-container"]',
        ];
        for (const sel of candidates) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && el.scrollHeight > el.clientHeight) return el;
        }
        // Fallback: find any element whose data-symbol-short children have
        // an overflow:auto ancestor
        const sample = document.querySelector('[data-symbol-short]');
        if (sample) {
            let p = sample.parentElement;
            while (p) {
                const cs = getComputedStyle(p);
                if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight) {
                    return p as HTMLElement;
                }
                p = p.parentElement;
            }
        }
        return null;
    });
    const container = containerHandle.asElement();

    // Snapshot helper — grab all visible symbols, dedup into `all`
    const snapshot = async (): Promise<number> => {
        const symbols = await page.evaluate(() => {
            const out: string[] = [];
            document.querySelectorAll('[data-symbol-short]').forEach((el) => {
                const v = el.getAttribute('data-symbol-short');
                if (v) out.push(v);
            });
            // Fallback strategies
            if (out.length === 0) {
                document.querySelectorAll('[data-symbol-full]').forEach((el) => {
                    const v = (el.getAttribute('data-symbol-full') || '').split(':').pop();
                    if (v) out.push(v);
                });
            }
            return out;
        });
        let added = 0;
        for (const s of symbols) if (!all.has(s)) { all.add(s); added++; }
        return added;
    };

    await snapshot();

    if (container) {
        // Scroll incrementally to the bottom, snapshotting at each step
        const { scrollHeight, clientHeight } = await container.evaluate((el) => ({
            scrollHeight: (el as HTMLElement).scrollHeight,
            clientHeight: (el as HTMLElement).clientHeight,
        }));
        const step = Math.max(100, clientHeight - 30);
        let pos = 0;
        let stagnant = 0;
        while (pos < scrollHeight + step) {
            await container.evaluate((el, p) => { (el as HTMLElement).scrollTop = p; }, pos);
            await page.waitForTimeout(250);
            const added = await snapshot();
            if (added === 0) {
                stagnant++;
                if (stagnant >= 3) break;
            } else {
                stagnant = 0;
            }
            pos += step;
        }
        // Scroll back to top to leave the watchlist visually in a clean state
        await container.evaluate((el) => { (el as HTMLElement).scrollTop = 0; }).catch(() => undefined);
    } else {
        log(`  (no scrollable watchlist container found — using single-snapshot count)`);
    }

    const list = [...all];
    log(`  (scrolled watchlist → ${list.length} unique rows)`);
    return list;
}

/** Click via JavaScript dispatch — bypasses Playwright's backdrop-intercept checks. */
async function jsClick(page: Page, selector: string): Promise<boolean> {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return false;
        el.click();
        return true;
    }, selector);
}

/** Bulk-add multiple symbols in one Add-Symbol dialog session.
 *  TradingView's "Add symbol" input accepts a single ticker per Enter,
 *  but the dialog stays open after each, so we can paste-Enter-paste-Enter
 *  in rapid succession without re-opening it. */
async function addSymbolsBulk(page: Page, symbols: string[]): Promise<{ added: string[]; failed: string[] }> {
    const added: string[] = [];
    const failed: string[] = [];
    if (symbols.length === 0) return { added, failed };

    log(`  📥 opening Add Symbol dialog for ${symbols.length} ticker(s)...`);

    // Ensure no popups/dropdowns linger
    await dismissPopups(page);
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
    // Click somewhere neutral on the chart to ensure focus
    await page.click('canvas[data-name="pane-canvas"]', { position: { x: 200, y: 300 }, force: true }).catch(() => undefined);
    await page.waitForTimeout(300);

    // Click "+ Add symbol" via JavaScript dispatch (bypasses backdrop checks)
    const opened = await jsClick(page, TV_SELECTORS.addSymbolButton);
    if (!opened) {
        log('  ⚠️ Add Symbol button not found in DOM');
        return { added, failed: symbols };
    }
    await page.waitForTimeout(1200);

    // Find the symbol input — TV may use various selectors
    let input =
        (await tryWithin(2500, () => page.$(TV_SELECTORS.symbolInput))) ??
        (await tryWithin(2500, () => page.$('input[placeholder*="ymbol" i]'))) ??
        (await tryWithin(2500, () => page.$('input[role="combobox"]'))) ??
        (await tryWithin(2500, () => page.$('input[type="text"]:focus')));
    if (!input) {
        log('  ⚠️ symbol input not visible after opening Add Symbol');
        return { added, failed: symbols };
    }

    for (const symbol of symbols) {
        try {
            log(`    + ${symbol}`);
            await input.fill('');
            await page.waitForTimeout(150);
            await input.type(symbol, { delay: 30 });
            await page.waitForTimeout(900); // wait for autocomplete to resolve
            await input.press('Enter');
            await page.waitForTimeout(700);
            added.push(symbol);
        } catch (e) {
            log(`    ⚠️ ${symbol} failed: ${(e as Error).message}`);
            failed.push(symbol);
        }
    }

    // Close the dialog
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    return { added, failed };
}

/** Remove a symbol from the currently-open TradingView watchlist via right-click → Remove. */
async function removeSymbol(page: Page, symbol: string): Promise<boolean> {
    // Find the row for this ticker — uses normalized comparison
    const normalized = symbol.split(':').pop()!.toUpperCase();
    const row = await page.evaluateHandle((norm) => {
        const els = document.querySelectorAll('[data-symbol-short]');
        for (const el of els) {
            const v = (el.getAttribute('data-symbol-short') || '').toUpperCase();
            if (v === norm) return el as HTMLElement;
        }
        return null;
    }, normalized);
    const el = row.asElement();
    if (!el) return false;

    // Right-click → "Remove" menu item
    await el.click({ button: 'right' });
    await page.waitForTimeout(700);
    const removeBtn = await tryWithin(2500, async () => {
        return page.getByText('Remove', { exact: false }).first().elementHandle();
    });
    if (!removeBtn) {
        await page.keyboard.press('Escape').catch(() => undefined);
        return false;
    }
    await removeBtn.click({ force: true });
    await page.waitForTimeout(500);
    return true;
}

async function syncWatchlist(page: Page, target: string[]): Promise<void> {
    log(`📋 Target watchlist (${target.length}): ${target.join(', ')}`);

    await openWatchlist(page, WATCHLIST_NAME);

    const current = await readCurrentSymbols(page);
    log(`📋 Current in TV (${current.length}): ${current.join(', ')}`);

    // Update ticker-history with everything in today's target (for future
    // staleness pruning — record TODAY as their last-seen date).
    recordSeenTickers(target);

    // Normalize for diff. TV displays without exchange prefix, our file has it.
    const normalize = (s: string) => s.split(':').pop()!.toUpperCase();
    const targetSet = new Set(target.map(normalize));
    const currentSet = new Set(current.map(normalize));

    const toAdd = target.filter((s) => !currentSet.has(normalize(s)));

    // Staleness pruning: of symbols CURRENTLY in TV, find those not seen in
    // any tv-watchlist file for the last PRUNE_AFTER_DAYS days.
    const staleInTv = findStaleTickers(current, PRUNE_AFTER_DAYS);
    // Plus: with --replace, also remove things explicitly missing from today's target.
    const toRemove = REPLACE
        ? current.filter((s) => !targetSet.has(normalize(s)))
        : staleInTv;

    log(`→ to add:    ${toAdd.length} (${toAdd.join(', ') || '—'})`);
    if (PRUNE_AFTER_DAYS > 0 && staleInTv.length > 0) {
        log(`→ stale (>${PRUNE_AFTER_DAYS}d unseen): ${staleInTv.length} (${staleInTv.join(', ')})`);
    }
    if (REPLACE) {
        log(`→ to remove (--replace): ${toRemove.length} (${toRemove.join(', ') || '—'})`);
    }

    if (DRY_RUN) {
        log('(dry-run — no changes made)');
        return;
    }

    // 1. Add new symbols
    const { added, failed } = await addSymbolsBulk(page, toAdd);
    log(`✓ added ${added.length}/${toAdd.length} symbols${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`);

    // 2. Remove stale (and --replace) symbols
    if (toRemove.length > 0) {
        log(`🗑️  removing ${toRemove.length} stale/replace symbol(s)...`);
        let removed = 0;
        for (const s of toRemove) {
            const ok = await removeSymbol(page, s);
            if (ok) { removed++; log(`  − ${s}`); }
            else { log(`  ⚠️ could not remove ${s} (selector/menu issue)`); }
        }
        log(`✓ removed ${removed}/${toRemove.length} symbols`);
    }
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
    log(`═══ TV Sync — ${LOGIN_MODE ? 'LOGIN MODE' : DRY_RUN ? 'DRY-RUN' : 'sync'} ═══`);
    log(`Profile dir: ${PROFILE_DIR}`);
    log(`Watchlist:   ${WATCHLIST_NAME}`);
    log(`File:        ${WATCHLIST_FILE}`);

    let context: BrowserContext | null = null;
    try {
        context = await chromium.launchPersistentContext(PROFILE_DIR, {
            headless: !HEADED,
            viewport: { width: 1400, height: 900 },
            args: ['--disable-blink-features=AutomationControlled'],
        });
        const page = context.pages()[0] ?? (await context.newPage());

        if (LOGIN_MODE) {
            log('Opening TradingView for one-time login...');
            await page.goto('https://www.tradingview.com/#signin', { waitUntil: 'domcontentloaded' });
            log('⌛ Browser is now open. Log into TradingView, then close the browser window when done.');
            log('   (The session will persist in the profile dir for future runs.)');
            // Wait until the user closes the context (close all pages) or up to 10 min.
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => resolve(), 10 * 60 * 1000);
                context!.on('close', () => { clearTimeout(timeout); resolve(); });
            });
            log('✓ Login flow completed.');
            return;
        }

        // Determine watchlist source: --file overrides GH artifact (user-specified
        // wins). Otherwise prefer the latest artifact, fall back to local file.
        let watchlistPath: string;
        if (WATCHLIST_FILE_EXPLICIT) {
            log(`📂 Using user-specified watchlist file (skipping artifact download)`);
            watchlistPath = WATCHLIST_FILE;
        } else {
            watchlistPath = downloadLatestArtifact() ?? WATCHLIST_FILE;
        }
        if (!fs.existsSync(watchlistPath)) {
            throw new Error(`Watchlist file not found: ${watchlistPath}. Run preview:lean to generate one.`);
        }
        const target = parseWatchlist(watchlistPath);
        if (target.length === 0) {
            log('📭 Target watchlist is empty — nothing to sync.');
            return;
        }

        // Navigate to TradingView chart page (which has the watchlist panel).
        await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000); // let SPA hydrate

        // Dismiss any upgrade/signup popups that overlay the chart
        await dismissPopups(page);

        if (!(await isLoggedIn(page))) {
            throw new Error(
                'Not logged into TradingView. Run with --login once to authenticate. ' +
                'See ~/Library/Logs/tv-sync.log for details.'
            );
        }

        await syncWatchlist(page, target);

        // Screenshot for audit
        const screenshotPath = path.join(LOG_DIR, `tv-sync-${new Date().toISOString().slice(0, 10)}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        log(`📸 Screenshot saved: ${screenshotPath}`);
    } catch (e) {
        log(`❌ Error: ${(e as Error).message}`);
        if (context) {
            const errShot = path.join(LOG_DIR, `tv-sync-error-${Date.now()}.png`);
            try { await context.pages()[0]?.screenshot({ path: errShot }); log(`  err screenshot: ${errShot}`); } catch { /* */ }
        }
        process.exit(1);
    } finally {
        await context?.close();
    }
}

main().catch((e) => { log(`❌ Fatal: ${(e as Error).message}`); process.exit(1); });
