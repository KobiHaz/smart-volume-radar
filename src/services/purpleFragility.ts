/**
 * Purple List Fragility Score (2026-07-19).
 *
 * Daily "euphoria/fragility" gauge over a fixed basket of semi/AI tickers
 * (config/purple-list.json). The score is the mean of six expanding-window
 * z-scores computed across the basket — methodology ported 1:1 from the
 * Purple List drawdown study (Purple_List_250d research, 2026-07-16):
 *
 *   wick10      — avg upper-wick ratio, 10-day mean ("selling into strength")
 *   pctAbove50  — fraction of tickers above their MA50 ("euphoric breadth")
 *   dist20      — avg distribution days in last 20 ("quiet institutional selling")
 *   ext50       — avg extension above MA50 ("parabolic overstretch")
 *   corr20      — mean 20d pairwise return correlation ("one trade")
 *   disp10      — cross-sectional return std-dev, 10-day mean
 *
 * Z-scores use an expanding window with a one-day lag — every value was
 * computable in real time on its own day (no lookahead). In-sample, score
 * > 1.0 preceded 75% of >7% basket drawdowns within 15 trading days.
 *
 * DISPLAY + MEASUREMENT ONLY. The result gates nothing: it feeds a header
 * line in the daily Telegram report, a one-off threshold-crossing alert,
 * and the fragility_daily D1 table (out-of-sample validation record).
 * Fail-open everywhere: any fetch/parse problem → null → the report simply
 * omits the line.
 */
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { normalizePriceUnitJumps } from './marketData.js';
import { mean, stdDev, pearson, rollingMean, expandingZ } from '../utils/statistics.js';
import logger from '../utils/logger.js';

// process.cwd() is the project root in every run mode (npm start, tsx scripts,
// GHA) — same convention as championScore.ts, and keeps Jest (CJS transform)
// away from import.meta.
const PURPLE_LIST_PATH = path.join(process.cwd(), 'config', 'purple-list.json');

export const FRAGILITY_THRESHOLD = 1.0;
/** Minimum surviving tickers — below this the basket no longer matches the calibrated study. */
export const MIN_TICKERS = 8;
/** Expanding-z burn-in: prior observations required before a z is emitted. */
export const Z_MIN_PRIOR = 60;
/** A drop of more than this from the running peak counts as "away from high" for the canary. */
const NEAR_HIGH_PCT = 0.02;
/** Canary = a ticker whose most recent 250d closing high is older than this many trading days. */
const CANARY_STALE_DAYS = 10;
const HIGH_LOOKBACK_DAYS = 250;

export interface PurpleTickerEntry {
    ticker: string;
    /** Yahoo symbol override (e.g. IFX → IFNNY). Data is reported under `ticker`. */
    yahooSymbol?: string;
}

export interface OhlcvSeries {
    /** Canonical ticker (config `ticker`, not the Yahoo override). */
    ticker: string;
    /** YYYY-MM-DD, ascending; all arrays aligned to it. */
    dates: string[];
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    volume: number[];
}

export interface FragilityComponents {
    wick10: number | null;
    pctAbove50: number | null;
    dist20: number | null;
    ext50: number | null;
    corr20: number | null;
    disp10: number | null;
}

export interface FragilityDay {
    date: string;
    /** Mean of the non-null component z's; null during burn-in or when <5 of 6 are available. */
    score: number | null;
    z: FragilityComponents;
    raw: FragilityComponents;
    /** Equal-weight basket index, growth of $1 from the first aligned day. */
    indexValue: number;
    /** % below the running peak (≤ 0). */
    drawdownPct: number;
    /** Tickers whose latest 250d closing high is >10 trading days old — only counted near the index high. */
    canaryCount: number | null;
    indexNearHigh: boolean;
}

export interface FragilityResult {
    scanDate: string;
    /** Full recomputed series on the aligned calendar (includes burn-in days with null score). */
    series: FragilityDay[];
    latest: FragilityDay;
    prevScore: number | null;
    /** True only on the day the score crosses FRAGILITY_THRESHOLD upward. */
    crossedUp: boolean;
    canaryCount: number;
    indexNearHigh: boolean;
    tickersUsed: string[];
    tickersFailed: string[];
}

export function loadPurpleList(): PurpleTickerEntry[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(PURPLE_LIST_PATH, 'utf-8')) as {
            tickers?: Array<{ ticker?: string; yahooSymbol?: string }>;
        };
        const entries = (parsed.tickers ?? [])
            .filter((t): t is PurpleTickerEntry => typeof t.ticker === 'string' && t.ticker.length > 0);
        if (entries.length === 0) logger.warn('🟣 purple-list.json contains no tickers');
        return entries;
    } catch (err) {
        logger.warn(`🟣 Failed to load purple-list.json: ${(err as Error).message}`);
        return [];
    }
}

/**
 * Fetch one ticker's raw daily OHLCV from Yahoo, trimmed to asOfDate.
 * Same endpoint/retry conventions as fetchYahooChartAsOfDate in marketData,
 * but returns the raw aligned arrays instead of derived StockData scalars
 * (the fragility math needs full OHLCV; threading bulk arrays through
 * StockData would bloat a hot type for a 10-ticker side feature).
 * range=2y — ample for the 60-day z burn-in + 250 rows of D1 backfill.
 */
export async function fetchPurpleOhlcv(
    yahooSymbol: string,
    canonicalTicker: string,
    asOfDate: string,
    attempt = 1
): Promise<OhlcvSeries | null> {
    const MAX_ATTEMPTS = 5;
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=2y`;
        const response = await fetch(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                Accept: 'application/json',
            },
        });
        if (!response.ok) {
            if ((response.status === 429 || response.status >= 500 || response.status === 404) && attempt < MAX_ATTEMPTS) {
                const delay = attempt * 500;
                logger.warn(`⚠️ 🟣 Yahoo ${response.status} for ${yahooSymbol}, retrying in ${delay}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
                await new Promise((r) => setTimeout(r, delay));
                return fetchPurpleOhlcv(yahooSymbol, canonicalTicker, asOfDate, attempt + 1);
            }
            logger.warn(`❌ 🟣 Yahoo error ${response.status} for ${yahooSymbol}`);
            return null;
        }
        const data = (await response.json()) as {
            chart?: {
                result?: Array<{
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
                }>;
            };
        };
        const result = data.chart?.result?.[0];
        const ts = result?.timestamp;
        const quote = result?.indicators?.quote?.[0];
        if (!ts?.length || !quote?.close) return null;

        const asOfEnd = new Date(asOfDate + 'T23:59:59Z').getTime() / 1000;
        const series: OhlcvSeries = {
            ticker: canonicalTicker,
            dates: [], open: [], high: [], low: [], close: [], volume: [],
        };
        for (let i = 0; i < ts.length; i++) {
            if (ts[i]! > asOfEnd) break;
            const c = quote.close[i];
            if (c == null || c <= 0) continue;
            const h = quote.high?.[i];
            const l = quote.low?.[i];
            const o = quote.open?.[i];
            const v = quote.volume?.[i];
            series.close.push(c);
            series.high.push(h != null && h > 0 ? h : c);
            series.low.push(l != null && l > 0 ? l : c);
            series.open.push(o != null && o > 0 ? o : c);
            series.volume.push(v != null && v > 0 ? v : 0);
            series.dates.push(new Date(ts[i]! * 1000).toISOString().slice(0, 10));
        }
        if (series.close.length === 0) return null;
        const jumps = normalizePriceUnitJumps({
            closes: series.close, highs: series.high, lows: series.low, opens: series.open,
        });
        if (jumps > 0) {
            logger.warn(`⚠️ 🟣 ${canonicalTicker}: repaired ${jumps} price-unit discontinuities`);
        }
        return series;
    } catch (error) {
        if (attempt < MAX_ATTEMPTS) {
            const delay = attempt * 500;
            await new Promise((r) => setTimeout(r, delay));
            return fetchPurpleOhlcv(yahooSymbol, canonicalTicker, asOfDate, attempt + 1);
        }
        logger.warn(`❌ 🟣 Fetch failed for ${yahooSymbol} after ${MAX_ATTEMPTS} attempts: ${(error as Error).message}`);
        return null;
    }
}

/** Align series on the intersection of trading dates (no forward-fill — a
 *  fabricated 0% return would contaminate corr/disp/wick). */
function alignOnCommonDates(series: OhlcvSeries[]): OhlcvSeries[] {
    if (series.length === 0) return [];
    let common = new Set(series[0]!.dates);
    for (let i = 1; i < series.length; i++) {
        const own = new Set(series[i]!.dates);
        common = new Set([...common].filter((d) => own.has(d)));
    }
    const calendar = [...common].sort();
    return series.map((s) => {
        const idx = new Map(s.dates.map((d, i) => [d, i]));
        const pick = (arr: number[]): number[] => calendar.map((d) => arr[idx.get(d)!]!);
        return {
            ticker: s.ticker,
            dates: calendar,
            open: pick(s.open), high: pick(s.high), low: pick(s.low),
            close: pick(s.close), volume: pick(s.volume),
        };
    });
}

/**
 * Align the series and compute the full per-day fragility table (aggregates,
 * z-scores, index, drawdown, canary). Pure and deterministic — the core
 * unit-test surface. Returns null when the aligned history is shorter than
 * the feature warm-up (~70 bars). Days before the z burn-in have score null.
 */
export function buildFragilityDays(
    rawSeries: OhlcvSeries[]
): { days: FragilityDay[]; tickers: string[] } | null {
    const series = alignOnCommonDates(rawSeries);
    const N = series.length;
    if (N === 0) return null;
    const T = series[0]!.dates.length;
    const dates = series[0]!.dates;
    // Feature warm-up ~70 bars (dist20 needs MA50-vol + 20d window); below that
    // nothing is scorable even before the z burn-in.
    if (T < 80) {
        logger.warn(`🟣 Fragility: aligned history too short (${T} days)`);
        return null;
    }

    // ---- per-ticker precomputation on the aligned calendar ----
    const ret: Array<Array<number | null>> = [];   // daily returns, null at t=0
    const wick: number[][] = [];                    // upper-wick ratio
    const ma50: Array<Array<number | null>> = [];
    const vol50: Array<Array<number | null>> = [];
    for (const s of series) {
        const r: Array<number | null> = new Array(T).fill(null);
        const w: number[] = new Array(T).fill(0);
        for (let t = 0; t < T; t++) {
            if (t > 0 && s.close[t - 1]! > 0) r[t] = s.close[t]! / s.close[t - 1]! - 1;
            const range = s.high[t]! - s.low[t]!;
            w[t] = range > 0 ? (s.high[t]! - Math.max(s.open[t]!, s.close[t]!)) / range : 0;
        }
        ret.push(r);
        wick.push(w);
        ma50.push(rollingMean(s.close, 50));
        vol50.push(rollingMean(s.volume, 50));
    }
    // Distribution day: down >0.2% on volume above the 50d average.
    const distFlag: Array<Array<0 | 1 | null>> = series.map((s, i) => {
        const flags: Array<0 | 1 | null> = new Array(T).fill(null);
        for (let t = 0; t < T; t++) {
            const r = ret[i]![t];
            const v50 = vol50[i]![t];
            if (r == null || v50 == null) continue;
            flags[t] = r < -0.002 && s.volume[t]! > v50 ? 1 : 0;
        }
        return flags;
    });

    // ---- daily cross-sectional aggregates (null while unwarmed) ----
    const wickAvg: number[] = new Array(T);
    const dispDaily: Array<number | null> = new Array(T).fill(null);
    for (let t = 0; t < T; t++) {
        wickAvg[t] = mean(series.map((_, i) => wick[i]![t]!))!;
        const rets = ret.map((r) => r[t]).filter((x): x is number => x != null);
        dispDaily[t] = rets.length === N ? stdDev(rets) : null;
    }

    const wick10: Array<number | null> = new Array(T).fill(null);
    const pctAbove50: Array<number | null> = new Array(T).fill(null);
    const dist20: Array<number | null> = new Array(T).fill(null);
    const ext50: Array<number | null> = new Array(T).fill(null);
    const corr20: Array<number | null> = new Array(T).fill(null);
    const disp10: Array<number | null> = new Array(T).fill(null);

    for (let t = 0; t < T; t++) {
        if (t >= 9) wick10[t] = mean(wickAvg.slice(t - 9, t + 1));
        if (t >= 10) {
            const window = dispDaily.slice(t - 9, t + 1);
            if (window.every((x) => x != null)) disp10[t] = mean(window as number[]);
        }
        if (ma50.every((m) => m[t] != null)) {
            pctAbove50[t] = series.filter((s, i) => s.close[t]! > (ma50[i]![t] as number)).length / N;
            ext50[t] = mean(series.map((s, i) => s.close[t]! / (ma50[i]![t] as number) - 1));
        }
        if (t >= 20) {
            // 20-day return windows exist from t=20 (returns start at t=1).
            const windows = ret.map((r) => r.slice(t - 19, t + 1) as number[]);
            const corrs: number[] = [];
            for (let i = 0; i < N; i++) {
                for (let j = i + 1; j < N; j++) {
                    const c = pearson(windows[i]!, windows[j]!);
                    if (c != null) corrs.push(c);
                }
            }
            corr20[t] = corrs.length > 0 ? mean(corrs) : null;
        }
        if (t >= 19 && distFlag.every((f) => f.slice(t - 19, t + 1).every((x) => x != null))) {
            dist20[t] = mean(
                distFlag.map((f) => (f.slice(t - 19, t + 1) as number[]).reduce((a, b) => a + b, 0))
            );
        }
    }

    // ---- expanding z-scores (one-day lag) + composite score ----
    const zSeries = {
        wick10: expandingZ(wick10, Z_MIN_PRIOR),
        pctAbove50: expandingZ(pctAbove50, Z_MIN_PRIOR),
        dist20: expandingZ(dist20, Z_MIN_PRIOR),
        ext50: expandingZ(ext50, Z_MIN_PRIOR),
        corr20: expandingZ(corr20, Z_MIN_PRIOR),
        disp10: expandingZ(disp10, Z_MIN_PRIOR),
    };

    // ---- equal-weight index, drawdown, canary ----
    const indexValue: number[] = new Array(T);
    indexValue[0] = 1.0;
    for (let t = 1; t < T; t++) {
        const rets = ret.map((r) => r[t]).filter((x): x is number => x != null);
        indexValue[t] = indexValue[t - 1]! * (1 + (mean(rets) ?? 0));
    }

    const days: FragilityDay[] = [];
    let runningPeak = -Infinity;
    for (let t = 0; t < T; t++) {
        runningPeak = Math.max(runningPeak, indexValue[t]!);
        const z: FragilityComponents = {
            wick10: zSeries.wick10[t]!, pctAbove50: zSeries.pctAbove50[t]!,
            dist20: zSeries.dist20[t]!, ext50: zSeries.ext50[t]!,
            corr20: zSeries.corr20[t]!, disp10: zSeries.disp10[t]!,
        };
        const zVals = Object.values(z).filter((x): x is number => x != null);
        const score = zVals.length >= 5 ? mean(zVals) : null;

        // Trailing-250d index high for "near high"; per-ticker high age for the canary.
        const lb = Math.max(0, t - (HIGH_LOOKBACK_DAYS - 1));
        let idxHigh = -Infinity;
        for (let k = lb; k <= t; k++) idxHigh = Math.max(idxHigh, indexValue[k]!);
        const indexNearHigh = indexValue[t]! >= idxHigh * (1 - NEAR_HIGH_PCT);
        let canaryCount: number | null = null;
        if (indexNearHigh) {
            canaryCount = 0;
            for (const s of series) {
                let hi = -Infinity;
                let hiIdx = lb;
                for (let k = lb; k <= t; k++) {
                    if (s.close[k]! >= hi) { hi = s.close[k]!; hiIdx = k; }
                }
                if (t - hiIdx > CANARY_STALE_DAYS) canaryCount++;
            }
        }

        days.push({
            date: dates[t]!,
            score,
            z,
            raw: {
                wick10: wick10[t]!, pctAbove50: pctAbove50[t]!, dist20: dist20[t]!,
                ext50: ext50[t]!, corr20: corr20[t]!, disp10: disp10[t]!,
            },
            indexValue: indexValue[t]!,
            drawdownPct: (indexValue[t]! / runningPeak - 1) * 100,
            canaryCount,
            indexNearHigh,
        });
    }

    return { days, tickers: series.map((s) => s.ticker) };
}

/**
 * Pure, deterministic fragility result over pre-fetched series. Returns null
 * when the aligned history is too short or the latest day has no score yet
 * (still in the z burn-in).
 */
export function computeFragilityFromSeries(
    rawSeries: OhlcvSeries[],
    asOfDate: string
): Omit<FragilityResult, 'tickersFailed'> | null {
    const built = buildFragilityDays(rawSeries);
    if (!built) return null;
    const { days, tickers } = built;
    const latest = days[days.length - 1]!;
    if (latest.score == null) {
        logger.warn('🟣 Fragility: latest day has no score (still in burn-in)');
        return null;
    }
    const prevScore = days.length >= 2 ? days[days.length - 2]!.score : null;
    return {
        scanDate: asOfDate,
        series: days,
        latest,
        prevScore,
        crossedUp:
            prevScore != null &&
            latest.score >= FRAGILITY_THRESHOLD &&
            prevScore < FRAGILITY_THRESHOLD,
        canaryCount: latest.canaryCount ?? 0,
        indexNearHigh: latest.indexNearHigh,
        tickersUsed: tickers,
    };
}

/**
 * IO entry point for the daily scan. Fail-open: null on any failure — the
 * report omits the fragility line and D1 keeps yesterday's history.
 */
export async function computePurpleFragility(asOfDate: string): Promise<FragilityResult | null> {
    const list = loadPurpleList();
    if (list.length === 0) return null;
    const limit = pLimit(3);
    const fetched = await Promise.all(
        list.map((entry) =>
            limit(() => fetchPurpleOhlcv(entry.yahooSymbol ?? entry.ticker, entry.ticker, asOfDate))
        )
    );
    const survivors = fetched.filter((s): s is OhlcvSeries => s != null);
    const failed = list
        .filter((_, i) => fetched[i] == null)
        .map((e) => e.ticker);
    if (survivors.length < MIN_TICKERS) {
        logger.warn(`🟣 Fragility skipped: only ${survivors.length}/${list.length} tickers fetched (failed: ${failed.join(', ')})`);
        return null;
    }
    const computed = computeFragilityFromSeries(survivors, asOfDate);
    if (!computed) return null;
    const scored = computed.series.filter((d) => d.score != null).length;
    logger.info(
        `🟣 Fragility: ${survivors.length} tickers, ${computed.series.length} aligned days ` +
        `(${computed.series[0]!.date}..${computed.latest.date}), ${scored} scored`
    );
    return { ...computed, tickersFailed: failed };
}
