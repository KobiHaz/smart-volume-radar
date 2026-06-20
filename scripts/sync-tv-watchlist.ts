#!/usr/bin/env npx tsx
/**
 * Smart Volume Radar — nightly TradingView watchlist sync (FOUR lists).
 *
 * Runs from a LaunchAgent on the user's mac (23:25 IDT, Mon-Fri). Pulls
 * the latest tv-*.txt files from BOTH the Smart Radar and Lean Radar
 * GitHub Actions workflows, then drives a persistent Chromium profile to:
 *
 *   1. Smart Radar - BUY     ← tv-smart-buy-latest.txt   (Smart workflow)
 *   2. Smart Radar - WATCH   ← tv-smart-watch-latest.txt (Smart workflow)
 *   3. Lean Radar - Breakouts ← tv-breakouts-latest.txt  (Lean workflow)
 *   4. Lean Radar - Near     ← tv-near-latest.txt        (Lean workflow)
 *
 * Per-watchlist staleness pruning (default 14 days): tickers that haven't
 * appeared in any sync for N days get right-click → Remove'd from TV.
 *
 * Modes:
 *   --login            One-time interactive: launches non-headless browser,
 *                      waits up to 10 minutes for user to log in, then exits.
 *                      Session cookies persist in PROFILE_DIR for future runs.
 *   --replace          Sync as REPLACE (remove TV symbols not in target).
 *                      Default is ADDITIVE with staleness-based pruning.
 *   --watchlist NAME   Override default rotation: sync only this single list.
 *   --file PATH        Use this local file instead of GHA artifact.
 *   --headed           Force visible browser (default: headless).
 *   --dry-run          Read state + diff, print, no writes.
 *   --prune-after-days N  Remove tickers absent for N days (default 14, 0=off).
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
const IS_CI = process.env.CI === 'true';
const PROFILE_DIR = path.join(os.homedir(), '.cache', 'svr-tv-sync', 'chromium-profile');
const LOG_DIR = IS_CI
    ? (process.env.GITHUB_WORKSPACE ?? process.cwd())
    : path.join(os.homedir(), 'Library', 'Logs');
const TV_COOKIES_FILE = process.env.TV_COOKIES_FILE ?? '';
fs.mkdirSync(path.dirname(PROFILE_DIR), { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const REPO = 'KobiHaz/StockMarketBot';

// TradingView DOM selectors — update when TV changes their HTML.
const TV_SELECTORS = {
    watchlistPanel: 'div[data-name="watchlists-dialog"], div.tv-screener-table',
    watchlistTitleButton: 'button[data-name="watchlists-button"]',
    watchlistItem: (name: string) => `div[data-name="watchlists-menu"] >> text="${name}"`,
    addSymbolButton: 'button[data-name="add-symbol-button"]',
    symbolInput: 'input[data-name="symbol-search-input"]',
    symbolRow: 'div[data-name="list-item"]',
    symbolRowText: 'div[data-name="list-item"] [class*="symbolNameText"]',
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
const WATCHLIST_FILE_EXPLICIT = process.argv.includes('--file');
const SINGLE_LIST_MODE = process.argv.includes('--watchlist') || process.argv.includes('--file');
const WATCHLIST_NAME_OVERRIDE = arg('watchlist', 'Smart Radar - BUY');
const WATCHLIST_FILE_OVERRIDE = arg('file', path.join(PROJECT_ROOT, 'results', 'tv-smart-buy-latest.txt'));

const PRUNE_AFTER_DAYS = parseInt(arg('prune-after-days', '14'), 10);

// Granular single-operation modes (used by the MCP tools). Each opens one
// list, performs one operation, prints a JSON result to stdout, and exits.
const READ_LIST = arg('read', '');
const ADD_LIST = arg('add', '');
const REMOVE_LIST = arg('remove', '');
const SYMBOLS_CSV = arg('symbols', '');
const GRANULAR_MODE = !!(READ_LIST || ADD_LIST || REMOVE_LIST);

// Screenshot mode (used by the tv_screenshot MCP tool): open one symbol on the
// saved chart layout, capture a PNG, print its path as JSON.
const SCREENSHOT_SYMBOL = arg('screenshot', '');
const SCREENSHOT_INTERVAL = arg('interval', '');
const SCREENSHOT_INTERVALS = arg('intervals', '');
const SCREENSHOT_MODE = !!SCREENSHOT_SYMBOL;
// Session-health check (tv_session_status MCP tool): report whether the saved
// profile is still logged in, as JSON, without erroring on logged-out.
const SESSION_STATUS_MODE = has('session-status');

function historyPathFor(watchlistName: string): string {
    const safe = watchlistName.replace(/[^a-zA-Z0-9-]/g, '_');
    return path.join(os.homedir(), '.cache', 'svr-tv-sync', `ticker-history-${safe}.json`);
}

// First-seen tracking — records the EARLIEST date each ticker appeared as a
// target for a given watchlist. Used as the "signal date" by the downstream
// watchlist health-check (telegram-mcp/watchlist-health.js). Distinct from the
// last-seen history used for staleness pruning.
function firstSeenPathFor(watchlistName: string): string {
    const safe = watchlistName.replace(/[^a-zA-Z0-9-]/g, '_');
    return path.join(os.homedir(), '.cache', 'svr-tv-sync', `ticker-firstseen-${safe}.json`);
}
function recordFirstSeen(watchlistName: string, symbols: string[]): Record<string, string> {
    const p = firstSeenPathFor(watchlistName);
    let h: Record<string, string> = {};
    if (fs.existsSync(p)) {
        try {
            h = JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
            h = {};
        }
    }
    const today = new Date().toISOString().slice(0, 10);
    for (const s of symbols) {
        const key = s.split(':').pop()!.toUpperCase();
        if (!h[key]) h[key] = today; // only set on first appearance
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(h, null, 2));
    return h;
}

// Accumulated snapshot of what is actually in each TV list after the sync run.
// Written to ~/telegram-mcp/data/tv-state.json for the health-check.
const STATE_SNAPSHOT: Record<string, Array<{ ticker: string; signalDate: string; exchange?: string }>> = {};

function exchangeOf(rawTarget: string): string | undefined {
    // Map a "TASE:RMLI" style prefix to an exchange tag the health-check understands.
    const m = rawTarget.match(/^([A-Z]+):/);
    return m ? m[1] : undefined;
}

// Persistent ticker→exchange registry. Accumulates across runs so that foreign
// tickers (TASE/TWSE/LSE/SIX) keep their exchange tag even on days they are not
// in the fresh target list (otherwise the health-check can't resolve the Yahoo
// symbol and reports "no data").
const EXCHANGE_REGISTRY_PATH = path.join(os.homedir(), '.cache', 'svr-tv-sync', 'ticker-exchange.json');
function loadExchangeRegistry(): Record<string, string> {
    if (!fs.existsSync(EXCHANGE_REGISTRY_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(EXCHANGE_REGISTRY_PATH, 'utf8'));
    } catch {
        return {};
    }
}
function saveExchangeRegistry(reg: Record<string, string>): void {
    fs.mkdirSync(path.dirname(EXCHANGE_REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(EXCHANGE_REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

// Prune queue — written by the watchlist health-check (telegram-mcp/
// watchlist-health.js) with tickers that broke down (≥8% below signal entry).
// We consume it here: any queued ticker that is currently in TV and is NOT in
// today's fresh target (i.e. the radar did not re-flag it) gets removed.
// Consumed entries are cleared so a ticker is only auto-removed once.
const PRUNE_QUEUE_PATH = path.join(os.homedir(), '.cache', 'svr-tv-sync', 'prune-queue.json');
interface PruneEntry { ticker: string; reason: string; queuedAt: string }
function loadPruneQueue(): Record<string, PruneEntry[]> {
    if (!fs.existsSync(PRUNE_QUEUE_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(PRUNE_QUEUE_PATH, 'utf8'));
    } catch {
        return {};
    }
}
function clearPruneEntries(watchlistName: string, removedKeys: string[]): void {
    const q = loadPruneQueue();
    if (!q[watchlistName]) return;
    q[watchlistName] = q[watchlistName].filter(
        (e) => !removedKeys.includes(e.ticker.split(':').pop()!.toUpperCase())
    );
    if (q[watchlistName].length === 0) delete q[watchlistName];
    fs.mkdirSync(path.dirname(PRUNE_QUEUE_PATH), { recursive: true });
    fs.writeFileSync(PRUNE_QUEUE_PATH, JSON.stringify(q, null, 2));
}

// ─── Sync targets (the default 4-list rotation) ─────────────────────
interface SyncTarget {
    file: string;
    name: string;
    /** Which GHA workflow produces this file. */
    workflow: 'Smart Volume Radar - Daily Scan' | 'Lean Radar - Daily Scan';
}

const DEFAULT_TARGETS: SyncTarget[] = [
    {
        file: path.join(PROJECT_ROOT, 'results', 'tv-smart-buy-latest.txt'),
        name: 'Smart Radar - BUY',
        workflow: 'Smart Volume Radar - Daily Scan',
    },
    {
        file: path.join(PROJECT_ROOT, 'results', 'tv-smart-watch-latest.txt'),
        name: 'Smart Radar - WATCH',
        workflow: 'Smart Volume Radar - Daily Scan',
    },
    {
        file: path.join(PROJECT_ROOT, 'results', 'tv-breakouts-latest.txt'),
        name: 'Lean Radar - Breakouts',
        workflow: 'Lean Radar - Daily Scan',
    },
    {
        file: path.join(PROJECT_ROOT, 'results', 'tv-near-latest.txt'),
        name: 'Lean Radar - Near',
        workflow: 'Lean Radar - Daily Scan',
    },
];

// ─── Log helper ─────────────────────────────────────────────────────
const logPath = path.join(LOG_DIR, 'tv-sync.log');
function log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    console.error(line);
    fs.appendFileSync(logPath, line + '\n');
}

// ─── GHA artifact download ───────────────────────────────────────────
const artifactDirCache = new Map<string, string | null>();

function downloadLatestArtifactDir(workflow: string): string | null {
    if (artifactDirCache.has(workflow)) return artifactDirCache.get(workflow)!;
    log(`🔎 Looking for latest "${workflow}" artifact via gh CLI...`);
    try {
        const runId = execSync(
            `gh run list --workflow="${workflow}" --status=success --limit 1 --json databaseId -q '.[0].databaseId' --repo ${REPO}`,
            { encoding: 'utf8' }
        ).trim();
        if (!runId) {
            log(`⚠️ No successful runs for "${workflow}"`);
            artifactDirCache.set(workflow, null);
            return null;
        }
        log(`  ↳ latest run: ${runId}`);
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svr-tv-'));
        execSync(`gh run download ${runId} --repo ${REPO} --dir "${tmpDir}"`, {
            encoding: 'utf8',
            stdio: 'pipe',
        });
        artifactDirCache.set(workflow, tmpDir);
        return tmpDir;
    } catch (e) {
        log(`⚠️ gh download failed for "${workflow}": ${(e as Error).message}`);
        artifactDirCache.set(workflow, null);
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
interface TickerHistory {
    [normalizedTicker: string]: string;
}

function loadHistory(historyPath: string): TickerHistory {
    if (!fs.existsSync(historyPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch {
        return {};
    }
}

function saveHistory(historyPath: string, h: TickerHistory): void {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(h, null, 2));
}

function recordSeenTickers(historyPath: string, symbols: string[]): void {
    const h = loadHistory(historyPath);
    const today = new Date().toISOString().slice(0, 10);
    for (const s of symbols) {
        const key = s.split(':').pop()!.toUpperCase();
        h[key] = today;
    }
    saveHistory(historyPath, h);
}

function findStaleTickers(historyPath: string, currentInTv: string[], days: number): string[] {
    if (days <= 0) return [];
    const h = loadHistory(historyPath);
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return currentInTv.filter((s) => {
        const key = s.split(':').pop()!.toUpperCase();
        const lastSeen = h[key];
        if (!lastSeen) return false;
        return lastSeen < cutoffStr;
    });
}

// ─── TradingView automation ──────────────────────────────────────────
async function isLoggedIn(page: Page): Promise<boolean> {
    const signInBtn = await page.$(TV_SELECTORS.loginButton);
    return !signInBtn;
}

async function dismissPopups(page: Page): Promise<void> {
    const closeSelectors = [
        'button[data-name="close"]',
        'button[aria-label="Close"]',
        'button[aria-label="close"]',
        '[data-dialog-name] [data-name="close"]',
        'div[role="dialog"] button[aria-label*="lose"]',
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
                } catch {
                    /* ignore */
                }
            }
        }
        if (!closed) {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
            break;
        }
    }
}

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

async function openWatchlist(
    page: Page,
    name: string,
    createIfMissing: boolean = true
): Promise<boolean> {
    log(`↳ Looking for watchlist "${name}"...`);
    await dismissPopups(page);

    const titleBtn = await page.waitForSelector(TV_SELECTORS.watchlistTitleButton, {
        timeout: 15000,
    });
    await titleBtn.click();
    await page.waitForTimeout(700);

    const openListBtn = await tryWithin(3000, async () => {
        const el = await page.getByText('Open list', { exact: false }).first().elementHandle();
        return el;
    });
    if (openListBtn) {
        log('  ↳ clicking "Open list…"');
        await openListBtn.click();
        await page.waitForTimeout(1500);

        const item = await tryWithin(3000, async () => {
            return page.getByText(name, { exact: true }).first().elementHandle();
        });
        if (item) {
            log(`✓ Found "${name}" — clicking`);
            await item.click({ force: true });
            await page.waitForTimeout(1500);
            await page.keyboard.press('Escape').catch(() => undefined);
            return true;
        }
        log(`  "${name}" not in list browser, closing modal`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
    }

    if (!createIfMissing) {
        log(`  ⏭  "${name}" missing and target empty — skipping (no need to create)`);
        return false;
    }

    // Create via "Create new list"
    log(`⚠️ "${name}" not found; creating new list...`);
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

    let nameInput =
        (await tryWithin(2000, () => page.$('input[type="text"]:visible'))) ??
        (await tryWithin(2000, () => page.$('input:visible')));
    if (!nameInput) {
        nameInput = await page
            .evaluate(() => {
                const el = document.activeElement;
                return el && el.tagName === 'INPUT' ? (el as HTMLInputElement) : null;
            })
            .then((res) => (res ? page.$('input:focus') : null));
    }
    if (!nameInput) {
        throw new Error('Could not find name input for new watchlist.');
    }
    await nameInput.fill(name);
    await page.waitForTimeout(400);
    await nameInput.press('Enter');
    await page.waitForTimeout(1500);
    log(`✓ Created watchlist "${name}"`);
    return true;
}

async function readCurrentSymbols(page: Page): Promise<string[]> {
    const all = new Set<string>();

    const containerHandle = await page.evaluateHandle(() => {
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
        const sample = document.querySelector('[data-symbol-short]');
        if (sample) {
            let p = sample.parentElement;
            while (p) {
                const cs = getComputedStyle(p);
                if (
                    (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
                    p.scrollHeight > p.clientHeight
                ) {
                    return p as HTMLElement;
                }
                p = p.parentElement;
            }
        }
        return null;
    });
    const container = containerHandle.asElement();

    const snapshot = async (): Promise<number> => {
        const symbols = await page.evaluate(() => {
            const out: string[] = [];
            document.querySelectorAll('[data-symbol-short]').forEach((el) => {
                const v = el.getAttribute('data-symbol-short');
                if (v) out.push(v);
            });
            if (out.length === 0) {
                document.querySelectorAll('[data-symbol-full]').forEach((el) => {
                    const v = (el.getAttribute('data-symbol-full') || '').split(':').pop();
                    if (v) out.push(v);
                });
            }
            return out;
        });
        let added = 0;
        for (const s of symbols)
            if (!all.has(s)) {
                all.add(s);
                added++;
            }
        return added;
    };

    await snapshot();

    if (container) {
        const { scrollHeight, clientHeight } = await container.evaluate((el) => ({
            scrollHeight: (el as HTMLElement).scrollHeight,
            clientHeight: (el as HTMLElement).clientHeight,
        }));
        const step = Math.max(100, clientHeight - 30);
        let pos = 0;
        let stagnant = 0;
        while (pos < scrollHeight + step) {
            await container.evaluate((el, p) => {
                (el as HTMLElement).scrollTop = p;
            }, pos);
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
        await container
            .evaluate((el) => {
                (el as HTMLElement).scrollTop = 0;
            })
            .catch(() => undefined);
    } else {
        log(`  (no scrollable watchlist container found — using single-snapshot count)`);
    }

    const list = [...all];
    log(`  (scrolled watchlist → ${list.length} unique rows)`);
    return list;
}

async function jsClick(page: Page, selector: string): Promise<boolean> {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return false;
        el.click();
        return true;
    }, selector);
}

async function addSymbolsBulk(
    page: Page,
    symbols: string[]
): Promise<{ added: string[]; failed: string[] }> {
    const added: string[] = [];
    const failed: string[] = [];
    if (symbols.length === 0) return { added, failed };

    log(`  📥 opening Add Symbol dialog for ${symbols.length} ticker(s)...`);

    await dismissPopups(page);
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
    await page
        .click('canvas[data-name="pane-canvas"]', { position: { x: 200, y: 300 }, force: true })
        .catch(() => undefined);
    await page.waitForTimeout(300);

    const opened = await jsClick(page, TV_SELECTORS.addSymbolButton);
    if (!opened) {
        log('  ⚠️ Add Symbol button not found in DOM');
        return { added, failed: symbols };
    }
    await page.waitForTimeout(1200);

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
            await page.waitForTimeout(900);
            await input.press('Enter');
            await page.waitForTimeout(700);
            added.push(symbol);
        } catch (e) {
            log(`    ⚠️ ${symbol} failed: ${(e as Error).message}`);
            failed.push(symbol);
        }
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    return { added, failed };
}

// Remove a symbol from the currently-open watchlist.
//
// Headless note (verified 2026-06-03): TradingView's right-click context menu
// does NOT render in headless Chromium, so the legacy right-click→"Remove" path
// silently failed for every symbol (adds worked because they use the Add-Symbol
// dialog, not a menu). Primary strategy is now select-row + Delete key, which is
// headless-safe. Each strategy is verified by re-querying the DOM — we return
// true only once the row is actually gone.
async function removeSymbol(page: Page, symbol: string): Promise<boolean> {
    const normalized = symbol.split(':').pop()!.toUpperCase();
    const sel = `[data-symbol-short="${normalized}"]`;
    const isPresent = () => page.evaluate((s) => !!document.querySelector(s), sel);
    const getRow = async () => {
        const h = await page.evaluateHandle((s) => document.querySelector(s) as HTMLElement | null, sel);
        return h.asElement();
    };

    if (!(await isPresent())) return true; // already absent → nothing to do

    // Strategy 1 — select row + Delete (headless-safe, primary).
    let el = await getRow();
    if (el) {
        await el.scrollIntoViewIfNeeded().catch(() => undefined);
        await el.click().catch(() => undefined);
        await page.waitForTimeout(300);
        await page.keyboard.press('Delete');
        await page.waitForTimeout(500);
        if (!(await isPresent())) return true;
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(500);
        if (!(await isPresent())) return true;
    }

    // Strategy 2 — hover-revealed remove control (span.removeButton-*).
    el = await getRow();
    if (el) {
        await el.hover().catch(() => undefined);
        await page.waitForTimeout(300);
        const rm = await tryWithin(1500, async () => el!.$('[class*="removeButton"]'));
        if (rm) {
            await rm.click({ force: true }).catch(() => undefined);
            await page.waitForTimeout(500);
            if (!(await isPresent())) return true;
        }
    }

    // Strategy 3 — legacy right-click → Remove (works only in headed mode).
    el = await getRow();
    if (el) {
        await el.click({ button: 'right' });
        await page.waitForTimeout(700);
        const removeBtn = await tryWithin(2500, async () =>
            page.getByText('Remove', { exact: false }).first().elementHandle()
        );
        if (removeBtn) {
            await removeBtn.click({ force: true });
            await page.waitForTimeout(500);
        }
        await page.keyboard.press('Escape').catch(() => undefined);
        if (!(await isPresent())) return true;
    }

    return false;
}

async function syncWatchlist(
    page: Page,
    target: string[],
    watchlistName: string
): Promise<void> {
    log(`\n═══ SYNCING "${watchlistName}" ═══`);
    log(`📋 Target (${target.length}): ${target.join(', ') || '—'}`);

    const opened = await openWatchlist(page, watchlistName, target.length > 0);
    if (!opened) {
        log(`  → nothing to do (watchlist missing + no targets to sync)`);
        return;
    }

    const current = await readCurrentSymbols(page);
    log(`📋 Current in TV (${current.length}): ${current.join(', ') || '—'}`);

    const historyPath = historyPathFor(watchlistName);
    recordSeenTickers(historyPath, target);
    const firstSeen = recordFirstSeen(watchlistName, target);

    // Build exchange map from the raw target list (e.g. "TASE:RMLI" → RMLI: TASE),
    // merged with the persistent registry so foreign tickers keep their tag even
    // when absent from today's target list.
    const exchangeMap = loadExchangeRegistry();
    for (const raw of target) {
        const ex = exchangeOf(raw);
        if (ex) exchangeMap[raw.split(':').pop()!.toUpperCase()] = ex;
    }
    saveExchangeRegistry(exchangeMap);

    const normalize = (s: string) => s.split(':').pop()!.toUpperCase();
    const targetSet = new Set(target.map(normalize));
    const currentSet = new Set(current.map(normalize));

    const toAdd = target.filter((s) => !currentSet.has(normalize(s)));
    const staleInTv = findStaleTickers(historyPath, current, PRUNE_AFTER_DAYS);

    // Health-check prune queue — broke-down tickers flagged by watchlist-health.js.
    // Remove only those that are (a) currently in TV and (b) NOT re-flagged today
    // (if the radar re-surfaced it as a fresh signal, keep it).
    const pruneQueueForList = (loadPruneQueue()[watchlistName] ?? [])
        .map((e) => e.ticker.split(':').pop()!.toUpperCase());
    const healthPrune = current.filter(
        (s) => pruneQueueForList.includes(normalize(s)) && !targetSet.has(normalize(s))
    );

    const toRemove = REPLACE
        ? current.filter((s) => !targetSet.has(normalize(s)))
        : [...new Set([...staleInTv, ...healthPrune])];

    log(`→ to add:    ${toAdd.length} (${toAdd.join(', ') || '—'})`);
    if (PRUNE_AFTER_DAYS > 0 && staleInTv.length > 0) {
        log(`→ stale (>${PRUNE_AFTER_DAYS}d unseen): ${staleInTv.length} (${staleInTv.join(', ')})`);
    }
    if (healthPrune.length > 0) {
        log(`→ health-prune (broke down): ${healthPrune.length} (${healthPrune.join(', ')})`);
    }
    if (REPLACE) {
        log(`→ to remove (--replace): ${toRemove.length} (${toRemove.join(', ') || '—'})`);
    }

    if (DRY_RUN) {
        log('(dry-run — no changes made)');
        return;
    }

    if (toAdd.length > 0) {
        const { added, failed } = await addSymbolsBulk(page, toAdd);
        log(
            `✓ added ${added.length}/${toAdd.length} symbols${
                failed.length ? ` (failed: ${failed.join(', ')})` : ''
            }`
        );
    }

    if (toRemove.length > 0) {
        log(`🗑️  removing ${toRemove.length} stale/replace/broke-down symbol(s)...`);
        let removed = 0;
        const removedKeys: string[] = [];
        for (const s of toRemove) {
            const ok = await removeSymbol(page, s);
            if (ok) {
                removed++;
                removedKeys.push(normalize(s));
                log(`  − ${s}`);
            } else {
                log(`  ⚠️ could not remove ${s} (selector/menu issue)`);
            }
        }
        log(`✓ removed ${removed}/${toRemove.length} symbols`);
        // Clear consumed prune-queue entries so each broke-down ticker is
        // auto-removed at most once.
        if (healthPrune.length > 0) clearPruneEntries(watchlistName, removedKeys);
    }

    // Record the post-sync expected contents into the state snapshot.
    // Expected = (current ∪ toAdd) − toRemove.
    const removedSet = new Set(toRemove.map(normalize));
    const finalSet = new Set<string>();
    for (const s of current) finalSet.add(normalize(s));
    for (const s of toAdd) finalSet.add(normalize(s));
    for (const s of removedSet) finalSet.delete(s);

    STATE_SNAPSHOT[watchlistName] = [...finalSet].map((ticker) => ({
        ticker,
        signalDate: firstSeen[ticker] ?? new Date().toISOString().slice(0, 10),
        ...(exchangeMap[ticker] ? { exchange: exchangeMap[ticker] } : {}),
    }));
}

// ─── Resolve effective file for a target (artifact > local) ─────────
function resolveTargetFile(t: SyncTarget): string | null {
    const baseName = path.basename(t.file);
    const artifactDir = downloadLatestArtifactDir(t.workflow);
    if (artifactDir) {
        const found = findFile(artifactDir, baseName);
        if (found) {
            log(`  ↳ ${t.name}: using artifact ${found}`);
            return found;
        }
        log(`  ↳ ${t.name}: ${baseName} not in artifact, falling back to local`);
    }
    if (fs.existsSync(t.file)) return t.file;
    return null;
}

// ─── Resolve the single SyncTarget for --watchlist / --file mode ────
// Without an explicit --file, the file + workflow come from the matching
// DEFAULT_TARGETS entry by name (DRY) — so e.g. "Lean Radar - Near" loads
// tv-near-latest.txt, not the tv-smart-buy default. An explicit --file
// overrides the path verbatim (workflow still taken from the matched entry,
// falling back to a name heuristic for unknown names).
function resolveSingleListTask(): SyncTarget {
    const match = DEFAULT_TARGETS.find((t) => t.name === WATCHLIST_NAME_OVERRIDE);
    const workflowFor = (): SyncTarget['workflow'] =>
        match?.workflow ??
        (WATCHLIST_NAME_OVERRIDE.toLowerCase().startsWith('lean')
            ? 'Lean Radar - Daily Scan'
            : 'Smart Volume Radar - Daily Scan');

    if (WATCHLIST_FILE_EXPLICIT) {
        return { file: WATCHLIST_FILE_OVERRIDE, name: WATCHLIST_NAME_OVERRIDE, workflow: workflowFor() };
    }
    if (match) return match;
    log(`⚠️ Unknown watchlist "${WATCHLIST_NAME_OVERRIDE}" and no --file; using default ${path.basename(WATCHLIST_FILE_OVERRIDE)}`);
    return { file: WATCHLIST_FILE_OVERRIDE, name: WATCHLIST_NAME_OVERRIDE, workflow: workflowFor() };
}

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

// ─── Screenshot mode (--screenshot SYMBOL [--interval CODE]) ─────────
// Map friendly interval forms to TradingView interval codes. Unknown values
// pass through unchanged. "1M" is intentionally NOT mapped (ambiguous: monthly
// is "M", one-minute is "1").
function tvInterval(raw: string): string {
    const s = raw.trim().toUpperCase();
    const map: Record<string, string> = {
        '1D': 'D', D: 'D', DAY: 'D', DAILY: 'D',
        '1W': 'W', W: 'W', WEEK: 'W', WEEKLY: 'W',
        M: 'M', MONTH: 'M', MONTHLY: 'M',
        '1H': '60', '60': '60', '60M': '60',
        '4H': '240', '240': '240', '2H': '120', '120': '120',
        '30': '30', '15': '15', '5': '5', '1': '1',
    };
    return map[s] ?? s;
}

// Candidate selectors for the main chart area (the center layout region,
// excluding the right watchlist panel and the left drawing toolbar). Fallback
// chain because TradingView renames classes; first match with a sane box wins.
const CHART_AREA_SELECTORS = [
    '.layout__area--center',
    'div[class*="layout__area--center"]',
    '.chart-gui-wrapper',
    'table.chart-markup-table',
];
async function chartClip(
    page: Page
): Promise<{ x: number; y: number; width: number; height: number } | null> {
    for (const sel of CHART_AREA_SELECTORS) {
        const el = await page.$(sel).catch(() => null);
        if (!el) continue;
        const box = await el.boundingBox().catch(() => null);
        if (box && box.width > 200 && box.height > 200) return box;
    }
    return null;
}

// Resolve the ordered list of timeframes to capture. --intervals (CSV) wins,
// then a single --interval, else [null] (the saved layout's default TF).
// Capped at MAX_SHOTS so one call can't spawn unbounded browser navigations.
const MAX_SHOTS = 4;
function resolveScreenshotIntervals(): Array<string | null> {
    if (SCREENSHOT_INTERVALS) {
        const list = SCREENSHOT_INTERVALS.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        if (list.length > MAX_SHOTS) {
            log(`  (capping screenshot to first ${MAX_SHOTS} of ${list.length} timeframes)`);
        }
        if (list.length > 0) return list.slice(0, MAX_SHOTS);
    }
    if (SCREENSHOT_INTERVAL) return [SCREENSHOT_INTERVAL];
    return [null];
}

// Capture one chart-only screenshot for `interval` (null = saved-layout default).
// Assumes `page` is already logged in. Returns the temp PNG path.
async function captureChart(page: Page, interval: string | null): Promise<string> {
    let url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(SCREENSHOT_SYMBOL)}`;
    if (interval) url += `&interval=${encodeURIComponent(tvInterval(interval))}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    await dismissPopups(page);
    const safe = SCREENSHOT_SYMBOL.replace(/[^a-zA-Z0-9]/g, '_');
    const tf = interval ? interval.replace(/[^a-zA-Z0-9]/g, '') : 'def';
    const out = path.join(os.tmpdir(), `svr-tv-shot-${safe}-${tf}-${Date.now()}.png`);
    const clip = await chartClip(page);
    if (!clip) log('  (chart-area selector not found — full-viewport screenshot)');
    await page.screenshot({ path: out, fullPage: false, ...(clip ? { clip } : {}) });
    log(`📸 Screenshot saved: ${out}${clip ? ' (chart-only)' : ' (full viewport)'}`);
    return out;
}

// Capture every resolved timeframe and print one JSON object with a `shots` array.
async function runScreenshot(page: Page): Promise<number> {
    const intervals = resolveScreenshotIntervals();
    const shots: Array<{ interval: string | null; path: string }> = [];
    for (const iv of intervals) {
        try {
            const out = await captureChart(page, iv);
            shots.push({ interval: iv, path: out });
        } catch (err) {
            log(`  ⚠️ screenshot failed for interval ${iv ?? 'default'}: ${(err as Error).message}`);
        }
    }
    console.log(JSON.stringify({ mode: 'screenshot', symbol: SCREENSHOT_SYMBOL, shots }));
    return 0;
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
    const mode = SINGLE_LIST_MODE
        ? `single-list (${WATCHLIST_NAME_OVERRIDE})`
        : 'four-list (Smart BUY+WATCH, Lean Breakouts+Near)';
    log(`═══ TV Sync — ${LOGIN_MODE ? 'LOGIN MODE' : DRY_RUN ? 'DRY-RUN' : mode} ═══`);
    log(`Profile dir: ${PROFILE_DIR}`);

    let context: BrowserContext | null = null;
    let browser: import('playwright').Browser | null = null;
    try {
        if (IS_CI) {
            // In CI: regular launch + inject cookies from TV_COOKIES_FILE secret.
            browser = await chromium.launch({
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

        if (LOGIN_MODE) {
            log('Opening TradingView for one-time login...');
            await page.goto('https://www.tradingview.com/#signin', {
                waitUntil: 'domcontentloaded',
            });
            log(
                '⌛ Browser is now open. Log into TradingView, then close the browser window when done.'
            );
            log('   (The session will persist in the profile dir for future runs.)');
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => resolve(), 10 * 60 * 1000);
                context!.on('close', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
            log('✓ Login flow completed.');
            return;
        }

        await page.goto('https://www.tradingview.com/chart/', {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(5000);
        await dismissPopups(page);

        if (SESSION_STATUS_MODE) {
            const loggedIn = await isLoggedIn(page);
            console.log(JSON.stringify({ mode: 'session-status', loggedIn, profileDir: PROFILE_DIR }));
            await context.close().catch(() => {});
            await browser?.close().catch(() => {});
            process.exit(0);
        }

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
                await browser?.close().catch(() => {});
            }
            process.exit(code);
        }

        if (SCREENSHOT_MODE) {
            let code = 1;
            try {
                code = await runScreenshot(page);
            } finally {
                await context.close().catch(() => {});
                await browser?.close().catch(() => {});
            }
            process.exit(code);
        }

        const tasks: SyncTarget[] = SINGLE_LIST_MODE
            ? [resolveSingleListTask()]
            : DEFAULT_TARGETS;

        for (const t of tasks) {
            let resolvedFile: string | null;
            if (SINGLE_LIST_MODE && WATCHLIST_FILE_EXPLICIT) {
                resolvedFile = fs.existsSync(t.file) ? t.file : null;
            } else {
                resolvedFile = resolveTargetFile(t);
            }

            if (!resolvedFile) {
                log(`⚠️ Watchlist file missing for "${t.name}" — skipping`);
                continue;
            }
            const target = parseWatchlist(resolvedFile);
            if (target.length === 0) {
                log(`📭 "${t.name}" target is empty — clearing TV list via staleness only`);
            }
            log(`📂 ${t.name} ← ${resolvedFile}`);
            await syncWatchlist(page, target, t.name);
        }

        const screenshotPath = path.join(
            LOG_DIR,
            `tv-sync-${new Date().toISOString().slice(0, 10)}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: false });
        log(`📸 Screenshot saved: ${screenshotPath}`);

        // Persist TV-state snapshot for the watchlist health-check.
        // Only write in full 4-list mode (single-list runs would clobber siblings).
        if (!SINGLE_LIST_MODE && Object.keys(STATE_SNAPSHOT).length > 0) {
            const tvStatePath = IS_CI
                ? path.join(process.env.GITHUB_WORKSPACE ?? process.cwd(), 'results', 'tv-state.json')
                : path.join(os.homedir(), 'telegram-mcp', 'data', 'tv-state.json');
            try {
                fs.mkdirSync(path.dirname(tvStatePath), { recursive: true });
                fs.writeFileSync(
                    tvStatePath,
                    JSON.stringify(
                        {
                            updatedAt: new Date().toISOString().slice(0, 10),
                            watchlists: STATE_SNAPSHOT,
                        },
                        null,
                        2
                    )
                );
                log(`🗂  TV state snapshot → ${tvStatePath}`);
            } catch (e) {
                log(`⚠️ Could not write tv-state.json: ${(e as Error).message}`);
            }
        }
    } catch (e) {
        log(`❌ Error: ${(e as Error).message}`);
        if (context) {
            const errShot = path.join(LOG_DIR, `tv-sync-error-${Date.now()}.png`);
            try {
                await context.pages()[0]?.screenshot({ path: errShot });
                log(`  err screenshot: ${errShot}`);
            } catch {
                /* */
            }
        }
        process.exit(1);
    } finally {
        await context?.close();
        await browser?.close();
    }
}

main().catch((e) => {
    log(`❌ Fatal: ${(e as Error).message}`);
    process.exit(1);
});
