/**
 * Smart Volume Radar - Market Data Service
 * Uses direct HTTP requests to avoid library-specific rate limiting issues
 */

import { StockData } from '../types/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { formatRVOL } from '../utils/formatters.js';
import pLimit from 'p-limit';
import {
    calculateSMA,
    calculateRSI,
    calculate52wHighAndConsolidation,
    computeNewlogicTags,
    calculateSMA200Slope,
    calculateSmaSlope,
    countConsecutiveGreenDays,
    detectEarningsGap,
    calculateAVWAP,
    calculateDaysSinceLastHigh,
    calculateBollingerBands,
    calculateEMA,
    countAccumulationDistributionDays,
} from '../utils/technicalAnalysis.js';
import { marketSessionMinutesElapsed, projectedRvol as computeProjectedRvol } from './rvolCalculator.js';

/** Common ticker typos and their correct symbols */
const COMMON_TYPO_FALLBACKS: Record<string, string[]> = {
    'COBE': ['CBOE'],
    'BA..L': ['BA.L'],
    'RR..L': ['RR.L'],
    'BASF.MI': ['BAS.MI', 'BAS.DE'],
};

/** Options for parseYahooChartResult (e.g. replay mode skips Twelve Data) */
export interface ParseYahooOptions {
    /** When true, skip Twelve Data RSI/SMA fetch (for historical replay) */
    skipTwelveData?: boolean;
}

/**
 * Parse Yahoo chart result into StockData. Same logic as production fetchFromYahooChart.
 * Exported for replay scripts that need to run production code on historical data.
 */
/** Yahoo chart result shape (chart.result[0]) */
type YahooChartResult = {
    meta?: { regularMarketPrice?: number };
    timestamp?: number[];
    indicators?: {
        quote?: Array<{
            open?: (number | null)[];
            close?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            volume?: (number | null)[];
        }>;
    };
};

export async function parseYahooChartResult(
    result: YahooChartResult,
    ticker: string,
    opts: ParseYahooOptions = {}
): Promise<StockData | null> {
    const { skipTwelveData = false } = opts;
    const meta = result.meta;
    const indicators = result.indicators?.quote?.[0];

    const rawCloses = indicators?.close ?? [];
    const rawHighs = indicators?.high ?? [];
    const rawLows = indicators?.low ?? [];
    const rawOpens = indicators?.open ?? [];
    const rawVolumes = indicators?.volume ?? [];
    const rawTimestamps = result.timestamp ?? [];
    // Aligned series: keep arrays the same length so volumes[i] / dates[i] match closes[i].
    const closes: number[] = [];
    const highs: number[] = [];
    const lows: number[] = [];
    const opens: number[] = [];
    const dates: string[] = [];
    const alignedVolumes: number[] = [];
    for (let i = 0; i < rawCloses.length; i++) {
        const c = rawCloses[i];
        if (c != null && c > 0) {
            closes.push(c);
            const h = rawHighs[i];
            const l = rawLows[i];
            const o = rawOpens[i];
            const v = rawVolumes[i];
            highs.push(h != null && h > 0 ? h : c);
            lows.push(l != null && l > 0 ? l : c);
            opens.push(o != null && o > 0 ? o : c);
            alignedVolumes.push(v != null && v > 0 ? v : 0);
            const ts = rawTimestamps[i];
            dates.push(ts != null ? new Date(ts * 1000).toISOString().slice(0, 10) : '');
        }
    }
    // Volume-only series (legacy RVOL) — drops zero-volume days.
    const volumes = alignedVolumes.filter((v) => v > 0);

    const isIndex = ticker.startsWith('^');
    if (closes.length < 1) return null;

    const currentVolume = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
    const VOLUME_RVOL_LOOKBACK = 63;
    const historicalVolumes = volumes.length > 0 ? volumes.slice(0, -1) : [];
    const lookbackVolumes = historicalVolumes.slice(-VOLUME_RVOL_LOOKBACK);
    const avgVolume = lookbackVolumes.length > 0
        ? lookbackVolumes.reduce((a, b) => a + (b ?? 0), 0) / lookbackVolumes.length
        : 0;
    const rvol = (isIndex || historicalVolumes.length >= 5) && avgVolume > 0 ? currentVolume / avgVolume : 0;

    const currentClose = closes[closes.length - 1];
    const previousClose = closes.length >= 2 ? closes[closes.length - 2] : 0;
    const priceChange = previousClose > 0 ? ((currentClose - previousClose) / previousClose) * 100 : 0;

    const sma21 = calculateSMA(closes, 21);
    const sma50 = calculateSMA(closes, 50);
    const sma200 = calculateSMA(closes, 200);
    const rsi = calculateRSI(closes, 14);
    const lastPrice = meta?.regularMarketPrice || currentClose || 0;
    const athData = calculate52wHighAndConsolidation(closes);

    let finalSma21 = sma21;
    let finalRsi = rsi;
    if (!skipTwelveData && config.useFetchedIndicators && process.env.TWELVE_DATA_API_KEY) {
        const fetched = await fetchIndicatorsFromTwelveData(ticker, process.env.TWELVE_DATA_API_KEY);
        if (fetched.rsi != null) finalRsi = fetched.rsi;
        if (fetched.sma21 != null) finalSma21 = fetched.sma21;
    }

    const tags = computeNewlogicTags({
        sma21: finalSma21,
        lastClose: lastPrice,
        sma21TouchThresholdPct: config.sma21TouchThresholdPct,
        pctFromAth: athData?.pctFromAth,
        closes,
    });

    // ─── Momentum-edition fields (additive; do not affect existing tag/path logic) ───
    const sma200Slope = calculateSMA200Slope(closes, 20);
    // SMA50 slope over 10 bars — shorter lookback because SMA50 is more responsive.
    // Used by Recovery Rally tier to detect bear-market reversals before SMA200 turns up.
    const sma50Slope = calculateSmaSlope(closes, 50, 10);
    const consecutiveGreenDays = countConsecutiveGreenDays(closes, 15);
    // Days since prior cycle high (excludes today). On a fresh-ATH day this returns the
    // base length, not 0 — so the tightness criterion can actually fire on breakout day.
    const daysSinceAth = calculateDaysSinceLastHigh(closes, 252);
    // Earnings-gap: scan last 60 bars; AVWAP from gap forward, anchored at gap index.
    const gap = detectEarningsGap(opens, highs, dates, 60, 3);
    const gapDay = gap
        ? { date: gap.date, level: gap.level, barsAgo: closes.length - 1 - gap.index }
        : null;
    const avwapFromGap =
        gap != null
            ? calculateAVWAP(highs, lows, closes, alignedVolumes, gap.index)
            : undefined;
    // projectedRvol: only meaningful intraday. After-close it equals raw rvol.
    const minutesElapsed = marketSessionMinutesElapsed();
    const projected = computeProjectedRvol(currentVolume, avgVolume, minutesElapsed);

    // ─── Phase 2 indicators (ChampionScan-inspired) ──────────────────────
    const bb = calculateBollingerBands(closes, 20, 2);
    const ema10 = calculateEMA(closes, 10);
    const ema21Ema = calculateEMA(closes, 21);
    const adDays = countAccumulationDistributionDays(closes, alignedVolumes, 25);
    // 63-day total return — input for the RS percentile rank computed at pipeline
    // level (rsPercentile.ts). 63 trading days ≈ 3 months — IBD's 3-month RS standard.
    let return63d: number | undefined = undefined;
    if (closes.length >= 64) {
        const past = closes[closes.length - 64]!;
        if (past > 0) return63d = ((lastPrice - past) / past) * 100;
    }
    // 21-day total return — short-window sector context (Phase 4B sector rank).
    let return21d: number | undefined = undefined;
    if (closes.length >= 22) {
        const past = closes[closes.length - 22]!;
        if (past > 0) return21d = ((lastPrice - past) / past) * 100;
    }
    // ADR% (Average Daily Range, Qullamaggie definition) = 100 × mean over the
    // last 20 bars of (high/low − 1). G1 (TD-26): a volatility floor — low-range
    // names structurally can't produce the 20%+ moves the strategy targets.
    // Empirically monotonic with forward return (54% win <3% → 69% win ≥9%), and
    // ADR≥5% on an A+/A entry lifts win-rate to ~87%.
    let adrPct: number | undefined = undefined;
    if (highs.length >= 20 && lows.length >= 20) {
        let sum = 0;
        let cnt = 0;
        for (let k = highs.length - 20; k < highs.length; k++) {
            const h = highs[k];
            const l = lows[k];
            if (h != null && l != null && l > 0) {
                sum += h / l - 1;
                cnt++;
            }
        }
        if (cnt > 0) adrPct = (sum / cnt) * 100;
    }

    return {
        ticker,
        currentVolume,
        avgVolume,
        rvol,
        priceChange,
        lastPrice,
        sma21: finalSma21,
        sma50,
        sma200,
        rsi: finalRsi,
        ath: athData?.ath,
        athSource: '52w',
        pctFromAth: athData?.pctFromAth,
        monthsInConsolidation: athData?.monthsInConsolidation,
        tags,
        // Momentum edition:
        sma200Slope,
        sma50Slope,
        daysSinceAth,
        consecutiveGreenDays,
        gapDay,
        avwapFromGap,
        projectedRvol: projected,
        // Phase 2 (ChampionScan):
        bbUpper: bb?.upper,
        bbMid: bb?.mid,
        bbLower: bb?.lower,
        ema10,
        ema21Ema,
        accumulationDays: adDays.accumulationDays,
        distributionDays: adDays.distributionDays,
        return63d,
        return21d,
        adrPct,
    };
}

/**
 * Fetch Yahoo chart data as of a specific date. Fetches full history, slices to asOfDate,
 * then runs production parseYahooChartResult (same buggy volume logic). For replay/investigation.
 */
export async function fetchYahooChartAsOfDate(
    ticker: string,
    asOfDate: string,
    isFallback = false,
    attempt = 1
): Promise<StockData | null> {
    const MAX_ATTEMPTS = 3;
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5y`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            if (response.status === 429 || response.status >= 500) {
                if (attempt < MAX_ATTEMPTS) {
                    const delay = attempt * 500;
                    logger.warn(`⚠️ Yahoo Chart (asOfDate) API ${response.status} for ${ticker}, retrying in ${delay}ms... (attempt ${attempt}/${MAX_ATTEMPTS})`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    return fetchYahooChartAsOfDate(ticker, asOfDate, isFallback, attempt + 1);
                }
                logger.warn(`❌ Yahoo Chart (asOfDate) API ${response.status} for ${ticker} after ${MAX_ATTEMPTS} attempts`);
            } else if (response.status === 404) {
                if (!isFallback && ticker.includes('.')) {
                    const fallbackTicker = ticker.replace(/\./g, '-');
                    logger.info(`🔍 Ticker ${ticker} not found on Yahoo Chart (asOfDate), trying fallback: ${fallbackTicker}`);
                    return fetchYahooChartAsOfDate(fallbackTicker, asOfDate, true);
                }
                logger.warn(`❌ Ticker not found on Yahoo Chart (asOfDate): ${ticker}`);
            } else {
                logger.warn(`❌ Yahoo Chart (asOfDate) API error ${response.status} for ${ticker}`);
            }
            return null;
        }

        const data = (await response.json()) as { chart?: { result?: unknown[] } };
        const result = data?.chart?.result?.[0] as {
            meta?: unknown;
            timestamp?: number[];
            indicators?: {
                quote?: Array<{
                    open?: (number | null)[];
                    close?: (number | null)[];
                    high?: (number | null)[];
                    low?: (number | null)[];
                    volume?: (number | null)[];
                }>;
            };
        } | undefined;
        if (!result?.timestamp?.length) return null;

        const ts = result.timestamp;
        const quote = result.indicators?.quote?.[0];
        if (!quote) return null;

        const asOfEnd = new Date(asOfDate + 'T23:59:59Z').getTime() / 1000;
        let lastIdx = -1;
        for (let i = 0; i < ts.length; i++) {
            if (ts[i]! <= asOfEnd) lastIdx = i;
        }
        if (lastIdx < 0) return null;

        const slice = <T>(arr: T[] | undefined): T[] => (arr ? arr.slice(0, lastIdx + 1) : []);

        // Strip regularMarketPrice so parseYahooChartResult uses the historical close (currentClose),
        // not today's live price which Yahoo always returns in meta regardless of slice date.
        const metaWithoutLive = result.meta
            ? { ...(result.meta as Record<string, unknown>), regularMarketPrice: undefined }
            : undefined;

        const sliced: typeof result = {
            meta: metaWithoutLive as typeof result.meta,
            timestamp: slice(ts),
            indicators: {
                quote: [
                    {
                        open: slice(quote.open),
                        close: slice(quote.close),
                        high: slice(quote.high),
                        low: slice(quote.low),
                        volume: slice(quote.volume),
                    },
                ],
            },
        };

        return parseYahooChartResult(sliced as YahooChartResult, ticker, { skipTwelveData: true });
    } catch (error) {
        if (attempt < MAX_ATTEMPTS) {
            const delay = attempt * 500;
            logger.warn(`⚠️ Chart (asOfDate) fetch failed for ${ticker} (${(error as Error).message}), retrying in ${delay}ms... (attempt ${attempt}/${MAX_ATTEMPTS})`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            return fetchYahooChartAsOfDate(ticker, asOfDate, isFallback, attempt + 1);
        }
        logger.error(`❌ Chart (asOfDate) fetch failed for ${ticker} after ${MAX_ATTEMPTS} attempts:`, (error as Error).message);
        return null;
    }
}

/**
 * Min average daily volume to keep a ticker in the scan.
 * Default 0 (no filter — scan everything in the watchlist).
 * Override with env var, e.g. MIN_AVG_DAILY_VOLUME=100000 to filter pump-and-dump candidates.
 */
const MIN_AVG_DAILY_VOLUME: number = ((): number => {
    const n = parseInt(process.env.MIN_AVG_DAILY_VOLUME ?? '0', 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
})();

/**
 * Fetch market regime from SPY: 'bear' if SPY.lastClose < SPY.SMA200, else 'bull'.
 * Returns 'bull' on any failure (fail-open — don't tighten thresholds when the data is missing).
 * Pass `asOfDate` for historical/backtest mode.
 */
export async function fetchMarketRegime(asOfDate?: string): Promise<'bull' | 'bear'> {
    try {
        const spy = asOfDate
            ? await fetchYahooChartAsOfDate('SPY', asOfDate)
            : await fetchFromYahooChart('SPY');
        if (!spy || !spy.sma200 || spy.sma200 <= 0) return 'bull';
        return spy.lastPrice < spy.sma200 ? 'bear' : 'bull';
    } catch {
        return 'bull';
    }
}

/**
 * Fetch SPY's 63-day return — used as the baseline for RS percentile (alpha).
 * Returns null on any failure (RS percentile then falls back to raw return).
 */
export async function fetchSpy63dReturn(asOfDate?: string): Promise<number | null> {
    try {
        const spy = asOfDate
            ? await fetchYahooChartAsOfDate('SPY', asOfDate)
            : await fetchFromYahooChart('SPY');
        if (!spy || spy.return63d == null || !Number.isFinite(spy.return63d)) return null;
        return spy.return63d;
    } catch {
        return null;
    }
}

/**
 * Market-health composite (ChampionScan-style "Market Health Status" banner).
 * Three independent SPY checks, each worth 1 point:
 *   1. SPY ≥ its SMA200      → primary trend intact
 *   2. SPY RVOL > 1.0        → broad participation / volume active
 *   3. SPY 21-day return > 0 → short-window momentum positive
 *      (the plan called for a 5-day return; return21d is the shortest window the
 *       pipeline already computes — same directional intent, no extra fetch).
 *
 * Score → label: 3 → 🟢 Strong, 2 → 🟡 Neutral, 0-1 → 🔴 Weak.
 * Display-only: this never gates any signal. Fail-open — any fetch problem
 * returns null and the report simply omits the banner rather than guessing.
 */
export interface MarketHealth {
    score: 0 | 1 | 2 | 3;
    label: 'Strong' | 'Neutral' | 'Weak';
    emoji: '🟢' | '🟡' | '🔴';
    aboveSma200: boolean;
    rvolActive: boolean;
    momentumUp: boolean;
    /** Mirrors fetchMarketRegime for convenience (aboveSma200 ? bull : bear). */
    regime: 'bull' | 'bear';
}

export async function fetchMarketHealth(asOfDate?: string): Promise<MarketHealth | null> {
    try {
        const spy = asOfDate
            ? await fetchYahooChartAsOfDate('SPY', asOfDate)
            : await fetchFromYahooChart('SPY');
        if (!spy || !spy.sma200 || spy.sma200 <= 0 || spy.lastPrice == null) return null;

        const aboveSma200 = spy.lastPrice >= spy.sma200;
        const rvolActive = (spy.projectedRvol ?? spy.rvol ?? 0) > 1.0;
        const shortReturn = spy.return21d ?? spy.return63d ?? 0;
        const momentumUp = shortReturn > 0;

        const score = (Number(aboveSma200) + Number(rvolActive) + Number(momentumUp)) as 0 | 1 | 2 | 3;
        const { label, emoji } =
            score >= 3
                ? ({ label: 'Strong', emoji: '🟢' } as const)
                : score === 2
                    ? ({ label: 'Neutral', emoji: '🟡' } as const)
                    : ({ label: 'Weak', emoji: '🔴' } as const);

        return {
            score,
            label,
            emoji,
            aboveSma200,
            rvolActive,
            momentumUp,
            regime: aboveSma200 ? 'bull' : 'bear',
        };
    } catch {
        return null;
    }
}

/**
 * Direct fetch from Yahoo Finance chart API
 * Uses 5y range for price history; 52w high and consolidation use last 252 days
 */
async function fetchFromYahooChart(ticker: string, isFallback = false, attempt = 1): Promise<StockData | null> {
    const MAX_ATTEMPTS = 3;
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5y`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            if (response.status === 429 || response.status >= 500) {
                if (attempt < MAX_ATTEMPTS) {
                    const delay = attempt * 500;
                    logger.warn(`⚠️ Yahoo Chart API ${response.status} for ${ticker}, retrying in ${delay}ms... (attempt ${attempt}/${MAX_ATTEMPTS})`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    return fetchFromYahooChart(ticker, isFallback, attempt + 1);
                }
                logger.warn(`❌ Yahoo Chart API ${response.status} for ${ticker} after ${MAX_ATTEMPTS} attempts`);
            } else if (response.status === 404) {
                if (!isFallback && ticker.includes('.')) {
                    const fallbackTicker = ticker.replace(/\./g, '-');
                    logger.info(`🔍 Ticker ${ticker} not found on Yahoo Chart, trying fallback: ${fallbackTicker}`);
                    return fetchFromYahooChart(fallbackTicker, true);
                }
                logger.warn(`❌ Ticker not found on Yahoo Chart: ${ticker}`);
            } else {
                logger.warn(`❌ Yahoo Chart API error ${response.status} for ${ticker}`);
            }
            return null;
        }

        const data = await response.json() as YahooChartApiResponse;
        const result = data?.chart?.result?.[0];
        const error = data?.chart?.error;

        if (!result) {
            if (error) {
                logger.warn(`❌ Yahoo Chart error for ${ticker}: ${error.description || error.code || 'Unknown error'}`);
            } else {
                logger.warn(`No chart data for ${ticker}`);
            }
            return null;
        }

        return parseYahooChartResult(result, ticker, { skipTwelveData: false });
    } catch (error) {
        if (attempt < MAX_ATTEMPTS) {
            const delay = attempt * 500;
            logger.warn(`⚠️ Chart fetch failed for ${ticker} (${(error as Error).message}), retrying in ${delay}ms... (attempt ${attempt}/${MAX_ATTEMPTS})`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            return fetchFromYahooChart(ticker, isFallback, attempt + 1);
        }
        logger.error(`❌ Chart fetch failed for ${ticker} after ${MAX_ATTEMPTS} attempts:`, (error as Error).message);
        return null;
    }
}

// ─── API response types (replace `any` casts on JSON parsing) ───────────────

/** Yahoo Chart API response — top-level wrapper. Parsing of `result[0]`
 *  is delegated to `parseYahooChartResult` which has its own internal types. */
interface YahooChartApiResponse {
    chart?: {
        result?: unknown[];
        error?: { description?: string; code?: string } | null;
    };
}

/** Twelve Data indicator (RSI / SMA / etc.) response. */
interface TwelveDataIndicatorResponse {
    status?: string;
    values?: Array<{ rsi?: string; sma?: string; datetime?: string }>;
}

/** Twelve Data quote/price response. Includes both success + error variants. */
interface TwelveDataQuoteResponse {
    status?: 'ok' | 'error';
    code?: number;
    message?: string;
    symbol?: string;
    close?: string;
    high?: string;
    low?: string;
    open?: string;
    previous_close?: string;
    percent_change?: string;
    volume?: string;
    average_volume?: string;
    fifty_two_week?: { high?: string };
    datetime?: string;
}

/** Twelve Data API base */
const TWELVE_DATA_BASE = 'https://api.twelvedata.com';

/**
 * Fetch RSI and SMA21 from Twelve Data (pre-calculated, no local calculation)
 */
async function fetchIndicatorsFromTwelveData(
    ticker: string,
    apiKey: string
): Promise<{ rsi?: number; sma21?: number }> {
    const result: { rsi?: number; sma21?: number } = {};
    try {
        const encodedTicker = encodeURIComponent(ticker);
        const [rsiRes, smaRes] = await Promise.all([
            fetch(`${TWELVE_DATA_BASE}/rsi?symbol=${encodedTicker}&interval=1day&time_period=14&apikey=${apiKey}`),
            fetch(`${TWELVE_DATA_BASE}/sma?symbol=${encodedTicker}&interval=1day&time_period=21&series_type=close&apikey=${apiKey}`),
        ]);

        const rsiData = (await rsiRes.json()) as TwelveDataIndicatorResponse;
        if (rsiData?.status === 'ok' && rsiData?.values?.[0]?.rsi != null) {
            result.rsi = parseFloat(rsiData.values[0].rsi);
        }

        const smaData = (await smaRes.json()) as TwelveDataIndicatorResponse;
        if (smaData?.status === 'ok' && smaData?.values?.[0]?.sma != null) {
            result.sma21 = parseFloat(smaData.values[0].sma);
        }
    } catch {
        // Silently fall back to calculated values
    }
    return result;
}

/**
 * Fetch from Twelve Data API – fetches RSI, SMA21, 52w high when available
 */
async function fetchFromTwelveData(ticker: string, isFallback = false, attempt = 1): Promise<StockData | null> {
    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) return null;
    const MAX_ATTEMPTS = 3;

    try {
        const url = `${TWELVE_DATA_BASE}/quote?symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}`;
        const response = await fetch(url);

        if (!response.ok) {
            if (response.status === 429 || response.status >= 500) {
                if (attempt < MAX_ATTEMPTS) {
                    const delay = attempt * 500;
                    logger.warn(`⚠️ Twelve Data API ${response.status} for ${ticker}, retrying in ${delay}ms... (attempt ${attempt}/${MAX_ATTEMPTS})`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    return fetchFromTwelveData(ticker, isFallback, attempt + 1);
                }
                logger.warn(`❌ Twelve Data API ${response.status} for ${ticker} after ${MAX_ATTEMPTS} attempts`);
            } else if (response.status === 404) {
                if (!isFallback && ticker.includes('.')) {
                    const fallbackTicker = ticker.replace(/\./g, '-');
                    logger.info(`🔍 Ticker ${ticker} not found on Twelve Data, trying fallback: ${fallbackTicker}`);
                    return fetchFromTwelveData(fallbackTicker, true);
                }
                logger.warn(`❌ Ticker not found on Twelve Data: ${ticker}`);
            } else {
                logger.warn(`❌ Twelve Data API error ${response.status} for ${ticker}`);
            }
            return null;
        }

        const data = await response.json() as TwelveDataQuoteResponse;

        if (data.status === 'error' || !data.close) {
            if (data.status === 'error') {
                if (data.code === 404 && !isFallback && ticker.includes('.')) {
                    const fallbackTicker = ticker.replace(/\./g, '-');
                    logger.info(`🔍 Twelve Data error 404 for ${ticker}, trying fallback: ${fallbackTicker}`);
                    return fetchFromTwelveData(fallbackTicker, true);
                }
                logger.warn(`❌ Twelve Data error for ${ticker}: ${data.message || 'Unknown error'}`);
            } else if (!data.close) {
                logger.warn(`⚠️ Twelve Data: No price data in quote for ${ticker}`);
            }
            return null;
        }

        // parseFloat coerces undefined → NaN; the `|| 0` / `|| 1` fallbacks already
        // handle that, so the ?? '' is just for TS type narrowing (close was checked
        // above so it's non-empty, the rest may be missing on partial responses).
        const volume = parseFloat(data.volume ?? '') || 0;
        const avgVolume = parseFloat(data.average_volume ?? '') || parseFloat(data.volume ?? '') || 1;
        const lastPrice = parseFloat(data.close ?? '') || 0;
        const fiftyTwoWeek = data.fifty_two_week;
        const high52w = fiftyTwoWeek?.high != null ? parseFloat(fiftyTwoWeek.high) : undefined;

        let rsi: number | undefined;
        let sma21: number | undefined;
        const indicators = await fetchIndicatorsFromTwelveData(ticker, apiKey);
        rsi = indicators.rsi;
        sma21 = indicators.sma21;

        const ath = high52w;
        const pctFromAth = ath != null && ath > 0 ? ((lastPrice - ath) / ath) * 100 : undefined;
        const tags = computeNewlogicTags({
            sma21,
            lastClose: lastPrice,
            sma21TouchThresholdPct: config.sma21TouchThresholdPct,
            pctFromAth,
            closes: [], // Twelve Data quote has no history; only Pullback 15% can apply
        });

        return {
            ticker,
            currentVolume: volume,
            avgVolume,
            rvol: volume / avgVolume,
            priceChange: parseFloat(data.percent_change ?? '') || 0,
            lastPrice,
            sma21,
            rsi,
            ath,
            athSource: '52w',
            pctFromAth,
            tags,
        };
    } catch (error) {
        if (attempt < MAX_ATTEMPTS) {
            const delay = attempt * 500;
            logger.warn(`⚠️ Twelve Data fetch failed for ${ticker} (${(error as Error).message}), retrying in ${delay}ms... (attempt ${attempt}/${MAX_ATTEMPTS})`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            return fetchFromTwelveData(ticker, isFallback, attempt + 1);
        }
        logger.error(`❌ Twelve Data fetch failed for ${ticker} after ${MAX_ATTEMPTS} attempts:`, (error as Error).message);
        return null;
    }
}

export interface FetchAllStocksResult {
    stocks: StockData[];
    failedTickers: string[];
}

/**
 * Fetch all stocks as of a specific date (Yahoo only; Twelve Data has no asOfDate support).
 * Used for daily scan to ensure data matches scan date regardless of run time.
 */
export async function fetchAllStocksAsOfDate(
    tickers: string[],
    asOfDate: string
): Promise<FetchAllStocksResult> {
    logger.info(`🚀 Starting fetch for ${tickers.length} tickers as of ${asOfDate} (Yahoo only)...`);

    const limit = pLimit(3);
    const results: StockData[] = [];
    const failedTickers: string[] = [];

    const tasks = tickers.map((ticker, index) =>
        limit(async () => {
            logger.info(`[${index + 1}/${tickers.length}] Fetching ${ticker}...`);

            let result = await fetchYahooChartAsOfDate(ticker, asOfDate);
            let successSource = 'Yahoo Chart (asOfDate)';

            if (!result && COMMON_TYPO_FALLBACKS[ticker.toUpperCase()]) {
                const fallbacks = COMMON_TYPO_FALLBACKS[ticker.toUpperCase()]!;
                for (const fallbackTicker of fallbacks) {
                    logger.info(`🔍 Ticker ${ticker} failed, trying common typo fallback: ${fallbackTicker}`);
                    result = await fetchYahooChartAsOfDate(fallbackTicker, asOfDate);
                    if (result) {
                        result.ticker = fallbackTicker;
                        break;
                    }
                }
            }

            if (result) {
                // Low-liquidity filter (skip pump-and-dump candidates).
                if (result.avgVolume > 0 && result.avgVolume < MIN_AVG_DAILY_VOLUME) {
                    logger.warn(
                        `⏭️ ${ticker}: avgVolume=${result.avgVolume.toFixed(0)} < ${MIN_AVG_DAILY_VOLUME} — dropped (low liquidity)`
                    );
                    return { ticker, data: null };
                }
                logger.info(`✅ ${ticker}: RVOL=${formatRVOL(result.rvol)} (${successSource})`);
                return { ticker, data: result };
            }
            logger.warn(`❌ ${ticker}: No data from Yahoo as of ${asOfDate}`);
            return { ticker, data: null };
        })
    );

    const fetchResults = await Promise.all(tasks);
    fetchResults.forEach((res) => {
        if (res.data) {
            results.push(res.data);
        } else {
            failedTickers.push(res.ticker);
        }
    });

    logger.info(`📊 Final: ${results.length}/${tickers.length} stocks fetched successfully`);
    if (failedTickers.length > 0) {
        logger.warn(`⚠️ Failed to fetch: ${failedTickers.join(', ')}`);
    }
    return { stocks: results, failedTickers };
}

/**
 * Fetch all stocks with multiple fallback strategies
 */
export async function fetchAllStocks(tickers: string[]): Promise<FetchAllStocksResult> {
    logger.info(`🚀 Starting fetch for ${tickers.length} tickers using concurrency...`);

    // Limit concurrency to avoid aggressive rate limiting from Yahoo/Twelve Data
    const limit = pLimit(3);
    const results: StockData[] = [];
    const failedTickers: string[] = [];

    const tasks = tickers.map((ticker, index) => limit(async () => {
        logger.info(`[${index + 1}/${tickers.length}] Fetching ${ticker}...`);

        // Try Yahoo Chart API first
        let result = await fetchFromYahooChart(ticker);
        let successSource = 'Yahoo Chart';

        if (!result) {
            // Try Twelve Data as fallback
            result = await fetchFromTwelveData(ticker);
            successSource = 'Twelve Data';
        }

        // Try common typo fallback if still no result
        if (!result && COMMON_TYPO_FALLBACKS[ticker.toUpperCase()]) {
            const fallbacks = COMMON_TYPO_FALLBACKS[ticker.toUpperCase()]!;
            for (const fallbackTicker of fallbacks) {
                logger.info(`🔍 Ticker ${ticker} failed, trying common typo fallback: ${fallbackTicker}`);

                result = await fetchFromYahooChart(fallbackTicker);
                if (result) {
                    successSource = 'Yahoo Chart (Typo Fallback)';
                    result.ticker = fallbackTicker;
                    break;
                }

                result = await fetchFromTwelveData(fallbackTicker);
                if (result) {
                    successSource = 'Twelve Data (Typo Fallback)';
                    result.ticker = fallbackTicker;
                    break;
                }
            }
        }

        if (result) {
            logger.info(`✅ ${ticker}: RVOL=${formatRVOL(result.rvol)} (${successSource})`);
            return { ticker, data: result };
        } else {
            logger.warn(`❌ ${ticker}: No data from any source (Yahoo or Twelve Data). Check for typos (e.g. COBE vs CBOE), if the symbol is delisted, or if it requires a specific exchange suffix (e.g. .L, .TA) or format (e.g. BRK-B vs BRK.B).`);
            return { ticker, data: null };
        }
    }));

    const fetchResults = await Promise.all(tasks);

    fetchResults.forEach((res) => {
        if (res.data) {
            results.push(res.data);
        } else {
            failedTickers.push(res.ticker);
        }
    });

    logger.info(`📊 Final: ${results.length}/${tickers.length} stocks fetched successfully`);
    if (failedTickers.length > 0) {
        logger.warn(`⚠️ Failed to fetch: ${failedTickers.join(', ')}`);
    }
    return { stocks: results, failedTickers };
}
