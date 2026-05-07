/**
 * Smart Volume Radar — Finnhub Fundamentals (Phase 3, 2026-05-07).
 *
 * Two endpoints:
 *   /calendar/earnings?from=...&to=...&symbol=X — upcoming earnings dates
 *   /stock/earnings?symbol=X                    — last quarters of EPS / Revenue
 *
 * Both wrapped in try/catch → null on failure (fail-soft).
 *
 * Cached on disk for 7 days at `results/finnhub-cache/{ticker}.json`.
 * Free-tier rate limit is 60 calls/min — caching keeps us well under that.
 *
 * Auth: shared `config.finnhubApiKey` (already used by newsService).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { computeAcceleration } from '../utils/acceleration.js';
import type { StockData } from '../types/index.js';

export { computeAcceleration };

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__moduleDir, '..', '..', 'results', 'finnhub-cache');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Shape returned by `/calendar/earnings`. */
export interface EarningsCalendarEntry {
    /** YYYY-MM-DD date of the report. */
    date: string;
    /** Listed time of day: 'bmo' (before market open), 'amc' (after market close), or '' */
    hour?: string;
    epsActual?: number | null;
    epsEstimate?: number | null;
    revenueActual?: number | null;
    revenueEstimate?: number | null;
}

/** Shape returned by `/stock/earnings` — one per quarter (most recent first). */
export interface QuarterlyEarning {
    /** YYYY-MM-DD of the quarter end. */
    period: string;
    /** Reported (actual) EPS — negative or zero allowed. */
    actual: number | null;
    estimate?: number | null;
    surprise?: number | null;
    surprisePercent?: number | null;
    /** Revenue is in `/stock/financials-reported` not /earnings; kept here for caller normalization. */
    revenue?: number | null;
}

interface CachedFundamentals {
    fetchedAt: number;
    ticker: string;
    nextEarning: EarningsCalendarEntry | null;
    quarterly: QuarterlyEarning[];
    /** Quarterly revenue series, oldest→newest, parallel to quarterly. */
    quarterlyRevenue: Array<{ period: string; revenue: number | null }>;
}

function ensureCacheDir(): void {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePath(ticker: string): string {
    // Sanitize ticker for filename (replace . / etc.)
    const safe = ticker.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(CACHE_DIR, `${safe}.json`);
}

function readCache(ticker: string): CachedFundamentals | null {
    const p = cachePath(ticker);
    if (!fs.existsSync(p)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as CachedFundamentals;
        if (Date.now() - data.fetchedAt > CACHE_TTL_MS) return null;
        return data;
    } catch {
        return null;
    }
}

function writeCache(ticker: string, data: Omit<CachedFundamentals, 'fetchedAt' | 'ticker'>): void {
    ensureCacheDir();
    const full: CachedFundamentals = { ...data, fetchedAt: Date.now(), ticker };
    fs.writeFileSync(cachePath(ticker), JSON.stringify(full, null, 2), 'utf-8');
}

/**
 * Fetch the next upcoming earnings entry within the next 90 days.
 * Returns null on any failure or when no upcoming earning is scheduled.
 */
export async function fetchEarningsCalendar(
    ticker: string,
    fromDate: string,
    toDate: string
): Promise<EarningsCalendarEntry | null> {
    const { finnhubApiKey } = config;
    if (!finnhubApiKey) return null;
    const url =
        `https://finnhub.io/api/v1/calendar/earnings` +
        `?from=${fromDate}&to=${toDate}` +
        `&symbol=${encodeURIComponent(ticker)}` +
        `&token=${finnhubApiKey}`;
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const data = (await r.json()) as { earningsCalendar?: EarningsCalendarEntry[] };
        const list = data.earningsCalendar ?? [];
        if (list.length === 0) return null;
        // Sort by date ascending; return the first upcoming entry on or after `fromDate`.
        list.sort((a, b) => a.date.localeCompare(b.date));
        return list.find((e) => e.date >= fromDate) ?? list[0]!;
    } catch (err) {
        logger.warn(`fetchEarningsCalendar(${ticker}) failed: ${(err as Error).message}`);
        return null;
    }
}

/** Fetch quarterly EPS history (most recent first). Returns [] on failure. */
export async function fetchQuarterlyEarnings(ticker: string): Promise<QuarterlyEarning[]> {
    const { finnhubApiKey } = config;
    if (!finnhubApiKey) return [];
    const url =
        `https://finnhub.io/api/v1/stock/earnings` +
        `?symbol=${encodeURIComponent(ticker)}` +
        `&token=${finnhubApiKey}`;
    try {
        const r = await fetch(url);
        if (!r.ok) return [];
        const data = (await r.json()) as QuarterlyEarning[];
        if (!Array.isArray(data)) return [];
        return data;
    } catch (err) {
        logger.warn(`fetchQuarterlyEarnings(${ticker}) failed: ${(err as Error).message}`);
        return [];
    }
}

/**
 * Fetch quarterly revenue from `/stock/financials-reported` (concept tag: Revenues).
 * Free-tier may not always include revenue; returns [] on failure.
 */
export async function fetchQuarterlyRevenue(
    ticker: string
): Promise<Array<{ period: string; revenue: number | null }>> {
    const { finnhubApiKey } = config;
    if (!finnhubApiKey) return [];
    const url =
        `https://finnhub.io/api/v1/stock/financials-reported` +
        `?symbol=${encodeURIComponent(ticker)}` +
        `&freq=quarterly` +
        `&token=${finnhubApiKey}`;
    try {
        const r = await fetch(url);
        if (!r.ok) return [];
        const data = (await r.json()) as {
            data?: Array<{
                endDate?: string;
                report?: { ic?: Array<{ concept?: string; value?: number }> };
            }>;
        };
        const rows = data.data ?? [];
        return rows
            .map((row) => {
                const ic = row.report?.ic ?? [];
                // Find a Revenue/Sales concept (varies by issuer).
                const rev = ic.find((c) =>
                    /^(us-gaap:)?(Revenues?|SalesRevenue|RevenueFromContract|RevenueFromContractWithCustomerExcludingAssessedTax)$/i.test(
                        c.concept ?? ''
                    )
                );
                return {
                    period: row.endDate ?? '',
                    revenue: rev?.value ?? null,
                };
            })
            .filter((r) => r.period);
    } catch (err) {
        logger.warn(`fetchQuarterlyRevenue(${ticker}) failed: ${(err as Error).message}`);
        return [];
    }
}

/**
 * Get fundamentals for a ticker, using on-disk cache (TTL 7d). Returns null
 * when API key missing or all fetches fail.
 */
export async function getFundamentals(ticker: string): Promise<CachedFundamentals | null> {
    const { finnhubApiKey } = config;
    if (!finnhubApiKey) return null;

    const cached = readCache(ticker);
    if (cached) return cached;

    const today = new Date().toISOString().slice(0, 10);
    const in90 = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);

    const [nextEarning, quarterly, quarterlyRevenue] = await Promise.all([
        fetchEarningsCalendar(ticker, today, in90),
        fetchQuarterlyEarnings(ticker),
        fetchQuarterlyRevenue(ticker),
    ]);

    if (nextEarning == null && quarterly.length === 0 && quarterlyRevenue.length === 0) {
        // Nothing useful — don't cache (lets us retry next run).
        return null;
    }

    const payload = { nextEarning, quarterly, quarterlyRevenue };
    writeCache(ticker, payload);
    return { ...payload, fetchedAt: Date.now(), ticker };
}

/**
 * Enrich a list of stocks with fundamentals (mutates each StockData).
 * Sets `nextEarningsDate`, `daysToEarnings`, `epsAcceleration`, `revAcceleration`.
 *
 * Concurrency: p-limit(3) keeps us comfortably under Finnhub's 60/min free
 * tier. Individual failures are fail-soft (logged, fields stay undefined).
 *
 * Returns the count of stocks that received at least one populated field.
 */
export async function enrichWithFundamentals(
    stocks: StockData[],
    asOfDate?: string
): Promise<{ enriched: number; cacheHits: number; apiCalls: number }> {
    if (!config.finnhubApiKey) {
        logger.info('🟡 Skipping fundamentals enrichment — FINNHUB_API_KEY not set');
        return { enriched: 0, cacheHits: 0, apiCalls: 0 };
    }
    const today = asOfDate ?? new Date().toISOString().slice(0, 10);
    const limit = pLimit(3);
    let enriched = 0;
    let cacheHits = 0;
    let apiCalls = 0;

    await Promise.all(
        stocks.map((s) =>
            limit(async () => {
                const hadCache = readCache(s.ticker) != null;
                const f = await getFundamentals(s.ticker);
                if (hadCache) cacheHits++;
                else apiCalls++;
                if (!f) return;

                // Earnings date + days-to
                if (f.nextEarning?.date) {
                    s.nextEarningsDate = f.nextEarning.date;
                    const days = Math.round(
                        (Date.parse(f.nextEarning.date) - Date.parse(today)) / 86_400_000
                    );
                    s.daysToEarnings = days;
                }

                // Acceleration: EPS from `quarterly`, Revenue from `quarterlyRevenue`.
                const epsTrend = computeAcceleration(f.quarterly);
                if (epsTrend) s.epsAcceleration = epsTrend;
                if (f.quarterlyRevenue.length > 0) {
                    // Adapt {period, revenue} → {actual, period} for the helper.
                    // Sort newest-first to match the EPS series convention.
                    const revSeries = [...f.quarterlyRevenue]
                        .sort((a, b) => b.period.localeCompare(a.period))
                        .map((r) => ({ actual: r.revenue, period: r.period }));
                    const revTrend = computeAcceleration(revSeries);
                    if (revTrend) s.revAcceleration = revTrend;
                }

                if (s.nextEarningsDate || s.epsAcceleration || s.revAcceleration) {
                    enriched++;
                }
            })
        )
    );
    return { enriched, cacheHits, apiCalls };
}
