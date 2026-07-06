/**
 * Smart Volume Radar - Technical Analysis Utility
 * Calculates SMA, RSI, ATH, and consolidation metrics from price history
 */

import { SMA as SMAIndicator, RSI as RSIIndicator } from 'trading-signals';

/**
 * Calculate Simple Moving Average (delegates to `trading-signals`, verified
 * byte-identical to the prior hand-rolled implementation).
 */
export function calculateSMA(prices: number[], periods: number): number | undefined {
    if (prices.length < periods) return undefined;
    const sma = new SMAIndicator(periods);
    let result: number | null = null;
    for (const p of prices) result = sma.update(p, false) ?? result;
    return result ?? undefined;
}

/** ~21 trading days per month */
const TRADING_DAYS_PER_MONTH = 21;

/** ~252 trading days per year (52 weeks) */
const TRADING_DAYS_52W = 252;

/**
 * Calculate 52-week high, % from high, and months in consolidation
 * Uses last 252 trading days (1 year) instead of 5y – more relevant for breakout setups
 */
export function calculate52wHighAndConsolidation(closes: number[]): {
    ath: number;
    pctFromAth: number;
    monthsInConsolidation: number;
} | null {
    if (closes.length < 22) return null; // need ~1 month of data
    const lookback = closes.slice(-TRADING_DAYS_52W);
    const ath = Math.max(...lookback);
    const lastClose = lookback[lookback.length - 1];
    const pctFromAth = ath > 0 ? ((lastClose - ath) / ath) * 100 : 0;

    // Find last index (within 52w window) where price was within 2% of 52w high
    let athIndex = -1;
    const athThreshold = ath * 0.98;
    for (let i = lookback.length - 1; i >= 0; i--) {
        if (lookback[i] >= athThreshold) {
            athIndex = i;
            break;
        }
    }
    const tradingDaysSinceAth = athIndex >= 0 ? lookback.length - 1 - athIndex : lookback.length - 1;
    const monthsInConsolidation = tradingDaysSinceAth / TRADING_DAYS_PER_MONTH;

    return { ath, pctFromAth, monthsInConsolidation };
}

/**
 * Check if price is "touching" SMA (within threshold %)
 */
export function isNearSMA(price: number, sma: number, thresholdPct: number): boolean {
    if (sma <= 0) return false;
    const pctDiff = Math.abs(price - sma) / sma * 100;
    return pctDiff <= thresholdPct;
}

import type { NewlogicTag } from '../types/index.js';

/** ~21 trading days = 1 month consolidation window */
const CONSOLIDATION_DAYS_1M = 21;

/**
 * Compute Newlogic tags from raw inputs.
 * - SMA21 Touch: |Close − SMA21| / SMA21 ≤ thresholdPct
 * - Pullback 15%: pctFromAth ≤ -15 (52w high)
 * - 1M Breakout: consolidated ~1 month, then lastClose > rangeHigh
 */
export function computeNewlogicTags(params: {
    sma21?: number;
    lastClose?: number;
    sma21TouchThresholdPct?: number;
    pctFromAth?: number;
    closes: number[];
}): NewlogicTag[] {
    const tags: NewlogicTag[] = [];
    const { sma21, lastClose: explicitLastClose, sma21TouchThresholdPct = 3, pctFromAth, closes } = params;

    const lastClose = explicitLastClose ?? (closes.length > 0 ? closes[closes.length - 1] : undefined);
    if (sma21 != null && sma21 > 0 && lastClose != null && lastClose > 0) {
        if (isNearSMA(lastClose, sma21, sma21TouchThresholdPct)) tags.push('SMA21 Touch');
    }

    if (pctFromAth != null && pctFromAth <= -15) tags.push('Pullback 15%');

    if (closes.length >= CONSOLIDATION_DAYS_1M + 1) {
        const lookback = closes.slice(-CONSOLIDATION_DAYS_1M - 1);
        const rangeCloses = lookback.slice(0, -1);
        const lastClose = lookback[lookback.length - 1];
        const rangeHigh = Math.max(...rangeCloses);
        if (lastClose > rangeHigh) tags.push('1M Breakout');
    }

    return tags;
}

/**
 * Trading days since the **prior cycle high** (i.e. the previous close at/near the 52w high,
 * EXCLUDING today's bar). On a fresh-ATH breakout day, this returns the length of the base
 * the stock just broke out of — not 0 (which is what a naive "days since current ATH" would give).
 *
 * Algorithm:
 *   1. Take all closes except today.
 *   2. priorHigh = max(those closes).
 *   3. Walk backward to find the most recent close ≥ priorHigh * 0.995.
 *   4. Return the gap (in trading days) between that index and today.
 *
 * Returns undefined when fewer than 22 closes are available.
 *
 * Examples:
 *   • Stock consolidates near $25 for 22 days, then breaks to $30 today → returns ~22.
 *   • Stock makes a new high every day in a steady uptrend → returns ~1 (no base).
 *   • Stock has never been near today's level → returns lookback length (no prior high in window).
 */
export function calculateDaysSinceLastHigh(closes: number[], lookbackDays: number = 252): number | undefined {
    if (closes.length < 22) return undefined;
    const lookback = closes.slice(-lookbackDays);
    if (lookback.length < 2) return undefined;

    const priorCloses = lookback.slice(0, -1);
    const priorHigh = Math.max(...priorCloses);
    if (priorHigh <= 0) return undefined;

    const threshold = priorHigh * 0.995;
    let priorHighIdx = -1;
    for (let i = priorCloses.length - 1; i >= 0; i--) {
        if (priorCloses[i]! >= threshold) {
            priorHighIdx = i;
            break;
        }
    }
    if (priorHighIdx < 0) return lookback.length - 1;
    return lookback.length - 1 - priorHighIdx;
}

/**
 * Linear-regression slope of an arbitrary SMA series over the last `lookback` bars.
 * Returns 'up' if normalized slope > +0.05% per bar, 'down' if < -0.05%, else 'flat'.
 * Returns undefined when not enough data to compute the SMA over the lookback.
 *
 * @param closes  daily close prices (most recent at end)
 * @param smaPeriod  SMA window (e.g. 50, 200)
 * @param lookback  number of bars over which to measure slope
 */
export function calculateSmaSlope(
    closes: number[],
    smaPeriod: number,
    lookback: number
): 'up' | 'flat' | 'down' | undefined {
    if (closes.length < smaPeriod + lookback) return undefined;
    const series: number[] = [];
    for (let i = closes.length - lookback; i < closes.length; i++) {
        const sma = calculateSMA(closes.slice(0, i + 1), smaPeriod);
        if (sma == null) return undefined;
        series.push(sma);
    }
    const n = series.length;
    const xMean = (n - 1) / 2;
    const yMean = series.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - xMean) * (series[i]! - yMean);
        den += (i - xMean) ** 2;
    }
    if (den === 0 || yMean === 0) return 'flat';
    const slopePerBar = num / den;
    const pctPerBar = (slopePerBar / yMean) * 100;
    if (pctPerBar > 0.05) return 'up';
    if (pctPerBar < -0.05) return 'down';
    return 'flat';
}

/** Backward-compat wrapper — SMA200 slope over the last 20 bars. */
export function calculateSMA200Slope(
    closes: number[],
    lookback: number = 20
): 'up' | 'flat' | 'down' | undefined {
    return calculateSmaSlope(closes, 200, lookback);
}

/**
 * Count consecutive-up days within the last `window` bars.
 * Green = close[i] > close[i-1]. Returns the count (0..window).
 * Used for the "Ants" accumulation signal (≥12 of 15).
 */
export function countConsecutiveGreenDays(closes: number[], window: number = 15): number {
    if (closes.length < 2) return 0;
    const slice = closes.slice(-Math.min(window + 1, closes.length));
    let count = 0;
    for (let i = 1; i < slice.length; i++) {
        if (slice[i]! > slice[i - 1]!) count++;
    }
    return count;
}

/**
 * Detect the most recent earnings/news gap-up within `lookback` bars.
 * Gap = open[i] > prevHigh AND (open - prevHigh) / prevHigh >= minGapPct (default 3%).
 * Returns { date, level } where level = the prevHigh that was gapped over (the AVWAP anchor reference).
 * Returns null when no gap found or inputs incomplete.
 */
export function detectEarningsGap(
    opens: number[],
    highs: number[],
    dates: string[],
    lookback: number = 60,
    minGapPct: number = 3
): { date: string; level: number; index: number } | null {
    const len = Math.min(opens.length, highs.length, dates.length);
    if (len < 2) return null;
    const start = Math.max(1, len - lookback);
    let last: { date: string; level: number; index: number } | null = null;
    for (let i = start; i < len; i++) {
        const o = opens[i];
        const prevHigh = highs[i - 1];
        if (o == null || prevHigh == null || prevHigh <= 0) continue;
        const pct = ((o - prevHigh) / prevHigh) * 100;
        if (pct >= minGapPct) {
            last = { date: dates[i]!, level: prevHigh, index: i };
        }
    }
    return last;
}

/**
 * Anchored VWAP starting at `anchorIndex` (inclusive) running forward to end of series.
 * VWAP = Σ(typicalPrice·vol) / Σ(vol), typicalPrice = (high+low+close)/3.
 * Returns the AVWAP value at the latest bar, or undefined when inputs invalid.
 */
export function calculateAVWAP(
    highs: number[],
    lows: number[],
    closes: number[],
    volumes: number[],
    anchorIndex: number
): number | undefined {
    const len = Math.min(highs.length, lows.length, closes.length, volumes.length);
    if (anchorIndex < 0 || anchorIndex >= len) return undefined;
    let pvSum = 0;
    let vSum = 0;
    for (let i = anchorIndex; i < len; i++) {
        const h = highs[i];
        const l = lows[i];
        const c = closes[i];
        const v = volumes[i];
        if (h == null || l == null || c == null || v == null || v <= 0) continue;
        const typical = (h + l + c) / 3;
        pvSum += typical * v;
        vSum += v;
    }
    if (vSum <= 0) return undefined;
    return pvSum / vSum;
}

/**
 * Calculate Relative Strength Index (RSI) using Wilder's Smoothing
 * Matches TradingView and standard charting platforms.
 * Delegates to `trading-signals` (its RSI defaults to Wilder/WSMA smoothing —
 * verified byte-identical to the prior hand-rolled implementation).
 */
export function calculateRSI(prices: number[], periods: number = 14): number | undefined {
    if (prices.length < periods + 1) return undefined;
    const rsi = new RSIIndicator(periods);
    let result: number | null = null;
    for (const p of prices) result = rsi.update(p, false) ?? result;
    return result ?? undefined;
}

// ─── ChampionScan Phase 2 Indicators (added 2026-05-07) ───────────────────

/**
 * Calculate the latest Bollinger Band values: middle = SMA(period), upper/lower = mid ± mult·σ.
 * Returns `undefined` if fewer than `period` closes are available.
 *
 * Default Bollinger Bands (Bollinger 1980): period=20, mult=2 → ~95% containment under
 * normal distribution. Squeeze (band-width / price < ~5%) = volatility contraction
 * preceding many breakouts (Bollinger Band Squeeze setup).
 *
 * Kept as a hand-rolled implementation (not delegated to `trading-signals`):
 * its `BollingerBands.update()` has an off-by-one — it only emits a result once
 * `period + 1` samples have been fed (unlike its own `SMA`, which emits at
 * exactly `period`) — which would break our "defined at exactly N closes" contract.
 */
export function calculateBollingerBands(
    closes: number[],
    period: number = 20,
    mult: number = 2
): { upper: number; mid: number; lower: number } | undefined {
    if (closes.length < period) return undefined;
    const window = closes.slice(closes.length - period);
    const mid = window.reduce((s, x) => s + x, 0) / period;
    const variance = window.reduce((s, x) => s + (x - mid) * (x - mid), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
        upper: mid + mult * stdDev,
        mid,
        lower: mid - mult * stdDev,
    };
}

/**
 * Calculate the latest Exponential Moving Average using the standard
 * 2/(N+1) smoothing factor (Wells Wilder, 1978; modern EMA convention).
 *
 * Seed: SMA of the first `period` closes. Then iteratively apply
 *   EMA[i] = price[i]·k + EMA[i-1]·(1-k),  k = 2/(period+1).
 *
 * Returns `undefined` if fewer than `period` closes available.
 *
 * Kept as a hand-rolled implementation (not delegated to `trading-signals`):
 * that library's EMA seeds with the *first price* instead of the SMA of the
 * first `period` closes, so results diverge from ours on short series (they
 * only converge after enough iterations for the seed's influence to decay).
 * SMA/RSI/BollingerBands above use the library since those were verified
 * byte-identical for all input lengths.
 */
export function calculateEMA(closes: number[], period: number): number | undefined {
    if (closes.length < period) return undefined;
    const k = 2 / (period + 1);
    // Seed with SMA of first `period` closes
    let ema = 0;
    for (let i = 0; i < period; i++) ema += closes[i]!;
    ema /= period;
    // Iterate forward
    for (let i = period; i < closes.length; i++) {
        ema = closes[i]! * k + ema * (1 - k);
    }
    return ema;
}

/**
 * Count accumulation and distribution days over a lookback window.
 *
 *   Accumulation: close[i] > close[i-1] AND volume[i] > avgVolume(20-day before i)
 *   Distribution: close[i] < close[i-1] AND volume[i] > avgVolume(20-day before i)
 *
 * 25 trading days (~5 weeks) is the IBD/Minervini convention. ≥5 distribution
 * days in 25 = institutional selling warning. ≥5 accumulation days = institutional
 * buying confirmation.
 *
 * Returns `{ accumulationDays: 0, distributionDays: 0 }` if not enough history;
 * otherwise the counts within the last `lookback` bars.
 */
export function countAccumulationDistributionDays(
    closes: number[],
    volumes: number[],
    lookback: number = 25
): { accumulationDays: number; distributionDays: number } {
    if (closes.length !== volumes.length) {
        return { accumulationDays: 0, distributionDays: 0 };
    }
    // Need at least lookback + 21 bars: 20 for the trailing avg + lookback to count.
    const VOL_AVG_PERIOD = 20;
    const start = Math.max(VOL_AVG_PERIOD + 1, closes.length - lookback);
    if (start >= closes.length) return { accumulationDays: 0, distributionDays: 0 };

    let accum = 0;
    let dist = 0;
    for (let i = start; i < closes.length; i++) {
        const prevClose = closes[i - 1]!;
        const close = closes[i]!;
        const vol = volumes[i]!;
        // Trailing 20-bar avg volume EXCLUDING today (so today's volume can stand out).
        let avgVol = 0;
        for (let j = i - VOL_AVG_PERIOD; j < i; j++) avgVol += volumes[j]!;
        avgVol /= VOL_AVG_PERIOD;
        if (avgVol <= 0) continue;
        if (vol <= avgVol) continue; // only "above-average volume" bars count

        if (close > prevClose) accum++;
        else if (close < prevClose) dist++;
    }
    return { accumulationDays: accum, distributionDays: dist };
}
