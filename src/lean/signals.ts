/**
 * Smart Volume Radar — Lean Radar signal detectors (stable branch).
 *
 * Three crisp, research-backed signals:
 *
 *   1. CONSOLIDATION BREAKOUT (Minervini VCP / IBD bases)
 *      - 1M, 3M, 1Y windows with progressively wider tightness allowance.
 *      - Today's close > window high.
 *      - Stage 2 confirmed (price > SMA50 > SMA200).
 *      - RVOL ≥ 1.5 on the breakout (IBD's 40-50% above-avg minimum).
 *
 *   2. HIGH VOLUME (institutional participation threshold)
 *      - RVOL ≥ 3.0 = "high"
 *      - RVOL ≥ 5.0 = "extreme" (gets a special tag)
 *
 *   3. HEALTHY PULLBACK (Stage 2 buy zone)
 *      - −25% ≤ pctFromAth ≤ −15%
 *      - lastPrice > SMA200 (filter out falling knives)
 *
 * Each detector also exposes a near-miss variant for the Silent Watchlist.
 *
 * Pure & synchronous — works on already-fetched StockData.
 */
import type { StockData } from '../types/index.js';

// ─── Window thresholds ────────────────────────────────────────────────
export const CONSOLIDATION_WINDOWS = [
    { label: '1M' as const, days: 21, maxRangePct: 10 },
    { label: '3M' as const, days: 63, maxRangePct: 15 },
    { label: '1Y' as const, days: 252, maxRangePct: 25 },
] as const;

export const BREAKOUT_MIN_RVOL = 1.5;
export const HIGH_VOLUME_RVOL = 3.0;
export const EXTREME_VOLUME_RVOL = 5.0;
// 2026-07-08 precision study (145K-day event-study): the -30..-25 zone is
// NEGATIVE (-2.42% med21, win 45%) even WITH survivorship bias in its favor.
// Gold zone is -20..-15 (+6.42% med21, win 65%). Reverts the 2026-07-02 deepening.
export const PULLBACK_MIN_PCT = -25;
export const PULLBACK_MAX_PCT = -15;

// Near-miss bands for Silent Watchlist
export const NEAR_PIVOT_PCT = 2; // within 2% below the pivot
export const NEAR_VOLUME_RVOL_MIN = 2.5;
export const NEAR_VOLUME_RVOL_MAX = 3.0;
export const NEAR_PULLBACK_MIN_PCT = -15;
export const NEAR_PULLBACK_MAX_PCT = -12;

// ─── Types ────────────────────────────────────────────────────────────
export interface ConsolidationSignal {
    window: '1M' | '3M' | '1Y';
    /** The (high − low) / mid range over the window, as %. */
    baseRangePct: number;
    /** Range high price — the pivot the stock just broke. */
    windowHigh: number;
}

export interface HighVolumeSignal {
    level: 'high' | 'extreme';
}

export interface PullbackSignal {
    /** Negative number, e.g. -18.3. */
    pctFromAth: number;
}

export interface ConsolidationNearMiss {
    window: '1M' | '3M' | '1Y';
    baseRangePct: number;
    windowHigh: number;
    /** Distance from price to window high as % (positive = below pivot). */
    distanceToPivotPct: number;
}

export interface VolumeNearMiss {
    rvol: number;
}

export interface PullbackNearMiss {
    pctFromAth: number;
}

// ─── Stage 2 helper ───────────────────────────────────────────────────
/** Stage 2 = price > SMA50 > SMA200. Exported for the Telegram formatter. */
export function isStage2(stock: StockData): boolean {
    return (
        stock.lastPrice != null &&
        stock.sma50 != null &&
        stock.sma200 != null &&
        stock.lastPrice > stock.sma50 &&
        stock.sma50 > stock.sma200
    );
}

// ─── Momentum-leader gate (2026-07-02 study: pullback + Stage2 + RS + volume) ──
export const LEADER_RVOL_MIN = 1.2;
export const LEADER_MOM63_MIN = 20; // % 63-trading-day momentum (relative strength)

/** 63-trading-day price momentum in %, or null if history too short. */
export function momentum63(closes: number[]): number | null {
    if (closes.length < 64) return null;
    const now = closes[closes.length - 1]!;
    const then = closes[closes.length - 1 - 63]!;
    return then > 0 ? (now / then - 1) * 100 : null;
}

/** Momentum-leader quality gate: Stage 2 uptrend + volume + strong 63d RS. */
export function passesLeaderGate(stock: StockData, closes: number[]): boolean {
    if (!isStage2(stock)) return false;
    if ((stock.rvol ?? 0) < LEADER_RVOL_MIN) return false;
    const m = momentum63(closes);
    return m != null && m >= LEADER_MOM63_MIN;
}

// ─── Window range helper ──────────────────────────────────────────────
/**
 * Compute the (high − low) / mid range over the LAST `days` bars EXCLUDING today.
 * Returns null when fewer than `days` bars in the lookback (today excluded).
 */
function windowRange(
    closes: number[],
    highs: number[],
    lows: number[],
    days: number
): { rangePct: number; high: number } | null {
    // We want the window to be the BASE leading up to today, not including today's bar.
    // closes.length includes today; slice [length - days - 1, length - 1) takes the prior `days` bars.
    if (closes.length < days + 1) return null;
    const startIdx = closes.length - days - 1;
    const endIdx = closes.length - 1; // exclusive of today
    let high = -Infinity;
    let low = Infinity;
    for (let i = startIdx; i < endIdx; i++) {
        const h = highs[i] ?? closes[i] ?? -Infinity;
        const l = lows[i] ?? closes[i] ?? Infinity;
        if (h > high) high = h;
        if (l < low) low = l;
    }
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
    const mid = (high + low) / 2;
    if (mid <= 0) return null;
    const rangePct = ((high - low) / mid) * 100;
    return { rangePct, high };
}

// ─── 1. Consolidation Breakout ────────────────────────────────────────
/**
 * Detect a consolidation breakout. Returns the FIRST qualifying window
 * (1M → 3M → 1Y, in that order — shorter base preferred).
 *
 * Caller must pass parallel close/high/low arrays from the StockData fetch.
 */
export function detectConsolidationBreakout(
    stock: StockData,
    closes: number[],
    highs: number[],
    lows: number[]
): ConsolidationSignal | null {
    if (!isStage2(stock)) return null;
    if ((stock.rvol ?? 0) < BREAKOUT_MIN_RVOL) return null;
    if (stock.lastPrice == null) return null;

    for (const cfg of CONSOLIDATION_WINDOWS) {
        const range = windowRange(closes, highs, lows, cfg.days);
        if (!range) continue;
        if (range.rangePct > cfg.maxRangePct) continue;
        if (stock.lastPrice <= range.high) continue;
        return {
            window: cfg.label,
            baseRangePct: range.rangePct,
            windowHigh: range.high,
        };
    }
    return null;
}

/**
 * Near-miss variant — finds windows where the stock SATISFIES the tightness
 * AND Stage 2 + RVOL (anything that would have been a breakout) BUT today's
 * price is just below the pivot (within `NEAR_PIVOT_PCT`).
 */
export function detectConsolidationNearMiss(
    stock: StockData,
    closes: number[],
    highs: number[],
    lows: number[]
): ConsolidationNearMiss | null {
    if (!isStage2(stock)) return null;
    if (stock.lastPrice == null) return null;

    for (const cfg of CONSOLIDATION_WINDOWS) {
        const range = windowRange(closes, highs, lows, cfg.days);
        if (!range) continue;
        if (range.rangePct > cfg.maxRangePct) continue;
        // Below pivot but within the near band
        const distanceToPivotPct = ((range.high - stock.lastPrice) / range.high) * 100;
        if (distanceToPivotPct <= 0) continue; // already broke
        if (distanceToPivotPct > NEAR_PIVOT_PCT) continue;
        return {
            window: cfg.label,
            baseRangePct: range.rangePct,
            windowHigh: range.high,
            distanceToPivotPct,
        };
    }
    return null;
}

// ─── 2. High Volume ───────────────────────────────────────────────────
export function qualifiesAsHighVolume(stock: StockData): HighVolumeSignal | null {
    const rvol = stock.rvol ?? 0;
    if (rvol >= EXTREME_VOLUME_RVOL) return { level: 'extreme' };
    if (rvol >= HIGH_VOLUME_RVOL) return { level: 'high' };
    return null;
}

export function qualifiesAsVolumeNearMiss(stock: StockData): VolumeNearMiss | null {
    const rvol = stock.rvol ?? 0;
    if (rvol >= NEAR_VOLUME_RVOL_MIN && rvol < NEAR_VOLUME_RVOL_MAX) return { rvol };
    return null;
}

// ─── 3. Healthy Pullback ──────────────────────────────────────────────
export function qualifiesAsHealthyPullback(stock: StockData): PullbackSignal | null {
    const pct = stock.pctFromAth;
    if (pct == null) return null;
    if (pct < PULLBACK_MIN_PCT || pct > PULLBACK_MAX_PCT) return null;
    if (stock.sma200 == null || stock.lastPrice == null) return null;
    if (stock.lastPrice <= stock.sma200) return null;
    return { pctFromAth: pct };
}

export function qualifiesAsPullbackNearMiss(stock: StockData): PullbackNearMiss | null {
    const pct = stock.pctFromAth;
    if (pct == null) return null;
    if (pct <= NEAR_PULLBACK_MIN_PCT || pct >= NEAR_PULLBACK_MAX_PCT) return null;
    if (stock.sma200 == null || stock.lastPrice == null) return null;
    if (stock.lastPrice <= stock.sma200) return null;
    return { pctFromAth: pct };
}
