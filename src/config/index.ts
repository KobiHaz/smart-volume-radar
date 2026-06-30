/**
 * Smart Volume Radar - Configuration Loader
 * Loads environment variables and watchlist configuration (Google Sheets)
 */

import * as dotenv from 'dotenv';
import logger from '../utils/logger.js';

// Load environment variables
dotenv.config();

function parseFloatEnv(key: string, defaultVal: number): number {
    const v = parseFloat(process.env[key] ?? String(defaultVal));
    return Number.isFinite(v) ? v : defaultVal;
}

function parseIntEnv(key: string, defaultVal: number): number {
    const v = parseInt(process.env[key] ?? String(defaultVal), 10);
    return Number.isFinite(v) ? v : defaultVal;
}

/**
 * Application configuration with sensible defaults
 */
export const config = {
    // RVOL thresholds
    minRVOL: parseFloatEnv('MIN_RVOL', 2.0),
    topN: parseIntEnv('TOP_N', 999),
    priceChangeThreshold: parseFloatEnv('PRICE_CHANGE_THRESHOLD', 2),

    // Consolidation / pre-breakout indicators (flexible: show full ✓ and close ~)
    consolidationMinMonths: parseIntEnv('CONSOLIDATION_MIN_MONTHS', 6),
    consolidationMaxMonths: parseIntEnv('CONSOLIDATION_MAX_MONTHS', 36),
    consolidationCloseMinMonths: parseIntEnv('CONSOLIDATION_CLOSE_MIN_MONTHS', 4), // 4–6mo = close
    athThresholdPct: parseFloatEnv('ATH_THRESHOLD_PCT', 20), // within 20% of ATH
    athCloseThresholdPct: parseFloatEnv('ATH_CLOSE_THRESHOLD_PCT', 25), // 20–25% = close
    sma21TouchThresholdPct: parseFloatEnv('SMA21_TOUCH_THRESHOLD_PCT', 3), // within 3% = touching
    sma21CloseThresholdPct: parseFloatEnv('SMA21_CLOSE_THRESHOLD_PCT', 5), // 3–5% = close

    // Prefer fetching RSI/SMA from Twelve Data instead of calculating (when key is set)
    useFetchedIndicators: process.env.USE_FETCHED_INDICATORS !== 'false',

    // API Keys
    finnhubApiKey: process.env.FINNHUB_API_KEY || '',
    twelveDataApiKey: process.env.TWELVE_DATA_API_KEY || '',
    groqApiKey: process.env.GROQ_API_KEY || '',
    // OpenAI / Perplexity / Gemini keys removed 2026-05-22 with the LLM summary
    // cleanup. Groq is retained — it powers `classifyTickersWithGroq` (ticker
    // type utility, not the dead daily commentary feature).

    // Telegram
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

    // Watchlist: Google Sheet (public CSV export)
    googleSheetId: process.env.GOOGLE_SHEET_ID || '',

    // Rate limiting (news only; market uses p-limit in marketData)
    newsDelayMs: 500,

    // CI / dev
    forceScan: process.env.FORCE_SCAN === 'true',
    debug: process.env.DEBUG === 'true',

    /** Format precision — shared by code display and LLM input for consistency */
    formatPrecision: {
        price: 2,
        pct: 2,
        base: 2,
        rvol: 2,
        rsi: 0,
    } as const,
} as const;

/** Valid ticker: optional ^, 1-50 alphanumeric chars/dashes/underscores, multiple exchange suffixes (e.g. BT.A.L, SOXX/AMEX:IGV, BA..L) */
const TICKER_REGEX = /^\^?[A-Za-z0-9_-]{1,50}([./:]{1,3}[A-Za-z0-9_-]{0,20})*$/;

/**
 * Validate ticker symbol format (prevents URL injection)
 */
export function validateTicker(ticker: string): boolean {
    const t = ticker.trim();
    return t.length > 0 && t.length <= 100 && TICKER_REGEX.test(t);
}

/** Google Sheet ID format: alphanumeric, dashes, underscores, 40-50 chars */
const GOOGLE_SHEET_ID_REGEX = /^[a-zA-Z0-9_-]{20,60}$/;

/**
 * Validate Google Sheet ID format (prevents URL injection)
 */
export function validateGoogleSheetId(sheetId: string): boolean {
    return GOOGLE_SHEET_ID_REGEX.test(sheetId.trim());
}

/**
 * Ticker entry: symbol (required) and optional sector for grouping in reports
 */
export interface TickerConfig {
    symbol: string;
    sector: string;
    description?: string;
}

// Internal cache set by fetchAndCacheWatchlist(); must be called before loadWatchlist()
let tickerCache: TickerConfig[] | null = null;
let invalidTickersCache: string[] = [];
let indexSkippedCache: string[] = [];
let sectorMap: Map<string, string> | null = null;

function buildSectorMap(tickers: TickerConfig[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const t of tickers) {
        map.set(t.symbol.toUpperCase(), t.sector);
    }
    return map;
}

const GOOGLE_SHEETS_CSV_URL = 'https://docs.google.com/spreadsheets/d/{id}/export?format=csv';

/**
 * Fetch CSV content from a public Google Sheet
 * @param sheetId - ID from sheet URL (between /d/ and /edit)
 * @throws Error if request fails or non-2xx response
 */
export async function fetchWatchlistCsv(sheetId: string): Promise<string> {
    if (!validateGoogleSheetId(sheetId)) {
        throw new Error('Invalid GOOGLE_SHEET_ID format. Expected alphanumeric ID from sheet URL.');
    }
    const url = GOOGLE_SHEETS_CSV_URL.replace('{id}', encodeURIComponent(sheetId.trim()));
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
        throw new Error(
            `Failed to fetch watchlist: ${res.status} ${res.statusText}. Check GOOGLE_SHEET_ID and that the sheet is shared "Anyone with the link can view".`
        );
    }
    return res.text();
}

/** Result of parsing watchlist CSV */
export interface ParseWatchlistResult {
    tickers: TickerConfig[];
    invalidSkipped: string[];
    /** Indices skipped – system does not support indices (no volume/RVOL). Not sent to Jules. */
    indexSkipped: string[];
}

/** Known index symbols (Yahoo ^, TASE indices). RVOL not applicable – no volume. */
const KNOWN_INDEX_SYMBOLS = new Set([
    'TA-BANKS.TA',
    'TA-25.TA',
    'TA-35.TA',
    'TA-125.TA',
    'TA-90.TA',
    'TA-75.TA',
    'TABANKS5.TA',
    'TA25.TA',
    'TA35.TA',
    'TA125.TA',
    'TA50.TA',
    'TA75.TA',
    'TA90.TA',
    'TA100.TA',
    'TACONSTRUCTION.TA',
    'TASME60.TA',
    'TAINSURANCEPLUS.TA',
].map((s) => s.toUpperCase()));

/** Detect if symbol is an index (not supported – no volume for RVOL). Skip and report, do not trigger Jules. */
export function isIndex(symbol: string): boolean {
    const s = symbol.trim();
    if (!s) return false;
    if (s.startsWith('^')) return true; // Yahoo index convention (^TNX, ^GSPC)
    return KNOWN_INDEX_SYMBOLS.has(s.toUpperCase());
}

/**
 * Parse CSV from Google Sheets into TickerConfig[].
 * - First row: treated as header if it looks like "Symbol" / "Sector" (case-insensitive), then skipped
 * - Column A: symbol (required); empty rows skipped
 * - Column B: sector (optional); default "Other" if empty
 * - Indices: detected and skipped (reported in Telegram, not sent to Jules)
 */
export function parseWatchlistCsv(csv: string): ParseWatchlistResult {
    const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
        throw new Error('Watchlist sheet is empty.');
    }

    const rows: string[][] = [];
    for (const line of lines) {
        // Simple CSV: split by comma; strip surrounding quotes from each cell
        const cells = line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
        rows.push(cells);
    }

    const isHeaderRow = (cells: string[]): boolean => {
        const first = (cells[0] || '').toLowerCase();
        return first === 'symbol' || first === 'sector' || first.includes('symbol') || first.includes('sector');
    };

    const startIndex = rows.length > 0 && isHeaderRow(rows[0]) ? 1 : 0;
    const tickers: TickerConfig[] = [];
    const invalidSkipped: string[] = [];
    const indexSkipped: string[] = [];

    for (let i = startIndex; i < rows.length; i++) {
        const cells = rows[i];
        const symbol = (cells[0] || '').trim();
        if (!symbol) continue;
        if (isIndex(symbol)) {
            indexSkipped.push(symbol);
            logger.info(`Index skipped (not supported): "${symbol}"`);
            continue;
        }
        if (!validateTicker(symbol)) {
            invalidSkipped.push(symbol);
            logger.warn(`Invalid ticker format skipped: "${symbol}"`);
            continue;
        }
        const sector = (cells[1] || '').trim() || 'Other';
        tickers.push({ symbol, sector });
    }

    if (tickers.length === 0) {
        throw new Error('Watchlist sheet has no valid ticker rows (Column A = symbol).');
    }

    return { tickers, invalidSkipped, indexSkipped };
}

/**
 * Fetch watchlist from Google Sheet and cache it. Must be called once before loadWatchlist() / getSectorForTicker().
 * @throws Error if GOOGLE_SHEET_ID is missing, fetch fails, or sheet is empty
 */
export async function fetchAndCacheWatchlist(): Promise<void> {
    const sheetId = config.googleSheetId.trim();
    if (!sheetId) {
        throw new Error('GOOGLE_SHEET_ID is required. Set it to your Google Sheet ID (from the sheet URL).');
    }
    const csv = await fetchWatchlistCsv(sheetId);
    const { tickers, invalidSkipped, indexSkipped } = parseWatchlistCsv(csv);
    tickerCache = tickers;
    invalidTickersCache = invalidSkipped;
    indexSkippedCache = indexSkipped;
    sectorMap = null; // invalidate so next getTickers rebuilds
}

/** Tickers skipped during watchlist parse (invalid format). Call after fetchAndCacheWatchlist(). */
export function getInvalidTickersFromWatchlist(): string[] {
    return [...invalidTickersCache];
}

/** Indices skipped (not supported). Not sent to Jules. Call after fetchAndCacheWatchlist(). */
export function getIndexSkippedFromWatchlist(): string[] {
    return [...indexSkippedCache];
}

function getTickers(): TickerConfig[] {
    if (tickerCache === null) {
        throw new Error(
            'Watchlist not loaded. Call fetchAndCacheWatchlist() once before loadWatchlist() or getSectorForTicker().'
        );
    }
    if (sectorMap === null) {
        sectorMap = buildSectorMap(tickerCache);
    }
    return tickerCache;
}

/**
 * Load tickers for scanning (deduped by symbol; first occurrence wins)
 * Duplicates come from repeated rows in the Google Sheet watchlist.
 */
export function loadWatchlist(): string[] {
    const tickers = getTickers();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of tickers) {
        const key = t.symbol.toUpperCase();
        if (seen.has(key)) {
            logger.info(`Duplicate ticker skipped: ${t.symbol}`);
            continue;
        }
        seen.add(key);
        out.push(key);
    }
    return out;
}

/**
 * Get sector for a ticker (O(1) via Map)
 */
export function getSectorForTicker(symbol: string): string {
    getTickers(); // builds sectorMap if needed
    return sectorMap!.get(symbol.toUpperCase()) ?? 'Other';
}

/**
 * Validate required configuration
 * @throws Error if critical config is missing
 */
export function validateConfig(): void {
    const missing: string[] = [];

    if (!config.finnhubApiKey) missing.push('FINNHUB_API_KEY');
    if (!config.telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
    if (!config.telegramChatId) missing.push('TELEGRAM_CHAT_ID');
    if (!config.googleSheetId?.trim()) missing.push('GOOGLE_SHEET_ID');

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}
