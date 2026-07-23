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
 * MODEL V2 (2026-07-22) adds a 7th component, `climax` — the basket's mean
 * 60-day volume z-score, counted only for tickers within 5% of their own
 * trailing 20-day closing high ("volume only predicts in context" — the
 * same volume burst away from a high is noise, not euphoria). Validated via
 * split-half stability (2023-24 vs 2025-26) to lift recall without an
 * out-of-sample precision collapse. Two dual-tier alert rules replace the
 * single-condition crossings:
 *   🔴 Alert: mean6 >= 1.0 AND indexNearHigh
 *   🟡 Watch: core3 >= 1.0 OR (climax >= 1.5 AND indexNearHigh)
 * Both require indexNearHigh — a fragility spike while the basket is already
 * well off its highs isn't the "euphoria before a top" pattern this gauge
 * targets.
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
import { mean, stdDev, pearson, rollingMean, rollingStd, rollingMax, expandingZ } from '../utils/statistics.js';
import logger from '../utils/logger.js';

// process.cwd() is the project root in every run mode (npm start, tsx scripts,
// GHA) — same convention as championScore.ts, and keeps Jest (CJS transform)
// away from import.meta.
const PURPLE_LIST_PATH = path.join(process.cwd(), 'config', 'purple-list.json');

export const FRAGILITY_THRESHOLD = 1.0;
/** Watch-tier threshold on core3 (wick10+dist20+disp10 z-mean). Calibrated
 *  2026-07-20 on the fixed basket, 2y window, 3y fetch: core3>=1.0 preceded
 *  54% of >7% tops at 56% precision (vs 23% catch for mean6>=1.0); >=0.75
 *  preceded 77% (display tier only — no alert below 1.0). */
export const CORE3_THRESHOLD = 1.0;
export const CORE3_WATCH_DISPLAY = 0.75;
/** Watch-tier threshold on climax (contextual volume-z). Calibrated 2026-07-22
 *  via split-half stability testing: climax>=1.5 (AND indexNearHigh) contributed
 *  the majority of the OR-rule's recall lift over core3 alone, stable across
 *  both the 2023-24 and 2025-26 halves. */
export const CLIMAX_THRESHOLD = 1.5;
/** Rolling window for the per-ticker volume z-score baseline. */
const CLIMAX_VOL_WINDOW = 60;
/** A ticker counts toward climax only within this % of its own trailing 20d closing high. */
const CLIMAX_NEAR_HIGH_PCT = 0.05;
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
    /** Predecessor ticker whose scale-adjusted OHLC extends history before the
     *  main symbol's first trading day (e.g. SNDK ← WDC pre-spinoff). */
    predecessorYahoo?: string;
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

/** Sub-components of the Capitulation Score (מד המיצוי) — see FragilityDay.capitulation. */
export interface CapitulationComponents {
    depth: number | null;
    panicVolume: number | null;
    washout: number | null;
    negMom: number | null;
}

export interface FragilityDay {
    date: string;
    /** Mean of the non-null component z's; null during burn-in or when <5 of 6 are available. */
    score: number | null;
    /** Watch-tier score: mean of the wick10/dist20/disp10 z's only — the three
     *  components that carried the signal both in the original study and on the
     *  2024-26 window. Null unless all three are available. */
    core3: number | null;
    /** Contextual volume climax: basket-mean 60d volume z, counted only for
     *  tickers within CLIMAX_NEAR_HIGH_PCT of their own trailing 20d closing
     *  high. Null until every ticker's volume-z baseline is warmed up. */
    climax: number | null;
    /** Capitulation Score (מד המיצוי) — bottom-detection companion to the
     *  euphoria score above ("has selling exhausted itself?"). Mean of the 4
     *  z's in capitulationZ, null unless at least 3 of 4 are available.
     *  DISPLAY ONLY — no threshold/alert wired to this anywhere; see
     *  PRD-capitulation-score.md for why (our own validation found ~35%/29%
     *  recall/precision against real troughs, edge doesn't hold up split-half). */
    capitulation: number | null;
    capitulationZ: CapitulationComponents;
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
    prevCore3: number | null;
    /** True only on the day the Watch-tier condition — core3>=CORE3_THRESHOLD
     *  OR (climax>=CLIMAX_THRESHOLD AND indexNearHigh) — newly holds. */
    core3CrossedUp: boolean;
    /** Which condition fired the Watch tier on the latest day; null if neither. */
    watchTrigger: 'core3' | 'climax' | 'both' | null;
    canaryCount: number;
    indexNearHigh: boolean;
    tickersUsed: string[];
    tickersFailed: string[];
}

export function loadPurpleList(): PurpleTickerEntry[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(PURPLE_LIST_PATH, 'utf-8')) as {
            tickers?: Array<{ ticker?: string; yahooSymbol?: string; predecessorYahoo?: string }>;
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
 * range=5y (bumped from 3y in model v2) — gives the expanding-z baseline a
 * meaningfully longer calibration history; the aligned intersection still
 * naturally caps at each member's own real history (e.g. CRDO's ~4.5y IPO
 * float), so this only adds headroom, it doesn't force a longer scored window.
 */
export async function fetchPurpleOhlcv(
    yahooSymbol: string,
    canonicalTicker: string,
    asOfDate: string,
    attempt = 1
): Promise<OhlcvSeries | null> {
    const MAX_ATTEMPTS = 5;
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5y`;
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

/**
 * Splice a predecessor ticker's history before the main symbol's first
 * trading day (e.g. SNDK ← WDC: Western Digital held the SanDisk flash
 * business until the Feb-2025 spinoff re-created the SNDK ticker).
 * Predecessor O/H/L/C are scale-adjusted so its last close meets the main
 * symbol's first close continuously (same idea as normalizePriceUnitJumps);
 * volumes are left untouched — dist20 compares each bar to the ticker's own
 * trailing average, so relative volume logic survives the seam.
 * Exported for tests.
 */
export function splicePredecessor(pre: OhlcvSeries, post: OhlcvSeries): OhlcvSeries {
    if (post.dates.length === 0) return { ...pre, ticker: post.ticker };
    const boundary = post.dates[0]!;
    let cut = pre.dates.findIndex((d) => d >= boundary);
    if (cut < 0) cut = pre.dates.length;
    if (cut === 0) return post;
    const scale = post.close[0]! / pre.close[cut - 1]!;
    return {
        ticker: post.ticker,
        dates: [...pre.dates.slice(0, cut), ...post.dates],
        open: [...pre.open.slice(0, cut).map((x) => x * scale), ...post.open],
        high: [...pre.high.slice(0, cut).map((x) => x * scale), ...post.high],
        low: [...pre.low.slice(0, cut).map((x) => x * scale), ...post.low],
        close: [...pre.close.slice(0, cut).map((x) => x * scale), ...post.close],
        volume: [...pre.volume.slice(0, cut), ...post.volume],
    };
}

/** Fetch one basket member, splicing its predecessor's history when declared. */
async function fetchMemberOhlcv(entry: PurpleTickerEntry, asOfDate: string): Promise<OhlcvSeries | null> {
    const main = await fetchPurpleOhlcv(entry.yahooSymbol ?? entry.ticker, entry.ticker, asOfDate);
    if (!entry.predecessorYahoo) return main;
    const pre = await fetchPurpleOhlcv(entry.predecessorYahoo, entry.ticker, asOfDate);
    if (!pre) return main; // fail-open: predecessor fetch trouble → main-only history
    if (!main || main.dates.length === 0) {
        // asOfDate predates the spinoff (replay) — predecessor alone IS the history.
        return { ...pre, ticker: entry.ticker };
    }
    return splicePredecessor(pre, main);
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
    // Per-ticker 20d MA, used by the Capitulation Score's `washout` component.
    const ma20 = series.map((s) => rollingMean(s.close, 20));
    // Per-ticker contextual volume climax: 60d volume z-score, only counted
    // while the ticker trades within CLIMAX_NEAR_HIGH_PCT of its own trailing
    // 20d closing high ("volume only predicts in context").
    const volMean60 = series.map((s) => rollingMean(s.volume, CLIMAX_VOL_WINDOW));
    const volStd60 = series.map((s) => rollingStd(s.volume, CLIMAX_VOL_WINDOW));
    const high20 = series.map((s) => {
        const out: Array<number | null> = new Array(T).fill(null);
        for (let t = 19; t < T; t++) out[t] = Math.max(...s.close.slice(t - 19, t + 1));
        return out;
    });
    const climaxContrib: Array<Array<number | null>> = series.map((s, i) => {
        const out: Array<number | null> = new Array(T).fill(null);
        for (let t = 0; t < T; t++) {
            const m = volMean60[i]![t];
            const sd = volStd60[i]![t];
            const hi = high20[i]![t];
            if (m == null || sd == null || sd < 1e-9 || hi == null) continue;
            const volZ = (s.volume[t]! - m) / sd;
            const nearHigh = s.close[t]! >= hi * (1 - CLIMAX_NEAR_HIGH_PCT);
            out[t] = nearHigh ? Math.max(volZ, 0) : 0;
        }
        return out;
    });
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

    // Basket-mean climax contribution — null until every ticker's own 60d
    // volume baseline is warmed up (consistent with the other components,
    // which also require the full basket to agree before scoring a day).
    const climaxRaw: Array<number | null> = new Array(T).fill(null);
    for (let t = 0; t < T; t++) {
        const vals = climaxContrib.map((c) => c[t]);
        if (vals.every((x): x is number => x != null)) climaxRaw[t] = mean(vals as number[]);
    }

    // Capitulation Score (מד המיצוי) — DISPLAY ONLY, no threshold/alert logic
    // anywhere (see PRD-capitulation-score.md: our own validation found ~35%/
    // 29% recall/precision against real troughs and an edge that doesn't hold
    // up in split-half testing). Bottom-detection companion to the euphoria
    // score above — "has the selling exhausted itself?" instead of "is the
    // market ripe for a top?". `panicVolume` reuses the same per-ticker 60d
    // volume-z baseline as climax but gates on down->1% days instead of
    // near-high days, then takes the rolling max of the trailing 10 days
    // (hunting for one capitulation day, not a same-day average).
    const panicDaily: Array<number | null> = new Array(T).fill(null);
    for (let t = 0; t < T; t++) {
        const vals: number[] = [];
        let allDefined = true;
        for (let i = 0; i < N; i++) {
            const m = volMean60[i]![t];
            const sd = volStd60[i]![t];
            if (m == null || sd == null || sd < 1e-9) { allDefined = false; break; }
            const volZ = (series[i]!.volume[t]! - m) / sd;
            const r = ret[i]![t];
            vals.push(r != null && r < -0.01 ? Math.max(volZ, 0) : 0);
        }
        if (allDefined) panicDaily[t] = mean(vals);
    }
    const panicVolumeRaw = rollingMax(panicDaily, 10);

    // washout: fraction of tickers below their own 20d MA (inverse-sense
    // sibling of pctAbove50, which uses a 50d MA).
    const washoutRaw: Array<number | null> = new Array(T).fill(null);
    for (let t = 0; t < T; t++) {
        if (ma20.every((m) => m[t] != null)) {
            washoutRaw[t] = series.filter((s, i) => s.close[t]! < (ma20[i]![t] as number)).length / N;
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
    const climaxZ = expandingZ(climaxRaw, Z_MIN_PRIOR);

    // ---- equal-weight index, drawdown, canary ----
    const indexValue: number[] = new Array(T);
    indexValue[0] = 1.0;
    for (let t = 1; t < T; t++) {
        const rets = ret.map((r) => r[t]).filter((x): x is number => x != null);
        indexValue[t] = indexValue[t - 1]! * (1 + (mean(rets) ?? 0));
    }

    // depth + negMom (Capitulation Score) derive from indexValue, so they're
    // computed here rather than alongside panicVolume/washout above.
    const runningPeakArr: number[] = new Array(T);
    runningPeakArr[0] = indexValue[0]!;
    for (let t = 1; t < T; t++) runningPeakArr[t] = Math.max(runningPeakArr[t - 1]!, indexValue[t]!);
    const depthRaw: number[] = indexValue.map((v, t) => -(v / runningPeakArr[t]! - 1));
    const negMomRaw: Array<number | null> = new Array(T).fill(null);
    for (let t = 20; t < T; t++) negMomRaw[t] = -(indexValue[t]! / indexValue[t - 20]! - 1);

    const capitulationZ = {
        depth: expandingZ(depthRaw, Z_MIN_PRIOR),
        panicVolume: expandingZ(panicVolumeRaw, Z_MIN_PRIOR),
        washout: expandingZ(washoutRaw, Z_MIN_PRIOR),
        negMom: expandingZ(negMomRaw, Z_MIN_PRIOR),
    };

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
        const core3Parts = [z.wick10, z.dist20, z.disp10].filter((x): x is number => x != null);
        const core3 = core3Parts.length === 3 ? mean(core3Parts) : null;

        const capZ: CapitulationComponents = {
            depth: capitulationZ.depth[t]!, panicVolume: capitulationZ.panicVolume[t]!,
            washout: capitulationZ.washout[t]!, negMom: capitulationZ.negMom[t]!,
        };
        const capVals = Object.values(capZ).filter((x): x is number => x != null);
        const capitulation = capVals.length >= 3 ? mean(capVals) : null;

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
            core3,
            climax: climaxZ[t]!,
            capitulation,
            capitulationZ: capZ,
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

/** 🔴 Alert condition: mean6 >= FRAGILITY_THRESHOLD AND the basket is near its high. */
function redFires(d: FragilityDay): boolean {
    return d.indexNearHigh && d.score != null && d.score >= FRAGILITY_THRESHOLD;
}

/** Which leg(s) of the 🟡 Watch OR-condition are active on a given day, if any. */
function watchTrigger(d: FragilityDay): 'core3' | 'climax' | 'both' | null {
    const core3On = d.core3 != null && d.core3 >= CORE3_THRESHOLD;
    const climaxOn = d.indexNearHigh && d.climax != null && d.climax >= CLIMAX_THRESHOLD;
    if (core3On && climaxOn) return 'both';
    if (core3On) return 'core3';
    if (climaxOn) return 'climax';
    return null;
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
    const prev = days.length >= 2 ? days[days.length - 2]! : null;
    const prevScore = prev?.score ?? null;
    const prevCore3 = prev?.core3 ?? null;
    const latestWatchTrigger = watchTrigger(latest);
    return {
        scanDate: asOfDate,
        series: days,
        latest,
        prevScore,
        // 🔴 Alert: fires only on the day the compound condition — mean6 above
        // threshold AND the basket itself near its high — newly holds.
        crossedUp: redFires(latest) && !(prev != null && redFires(prev)),
        prevCore3,
        // 🟡 Watch: fires only on the day the OR-condition newly holds
        // (core3 alone, or climax while the basket is near its high).
        core3CrossedUp: latestWatchTrigger != null && !(prev != null && watchTrigger(prev) != null),
        watchTrigger: latestWatchTrigger,
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
        list.map((entry) => limit(() => fetchMemberOhlcv(entry, asOfDate)))
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
