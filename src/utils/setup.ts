/**
 * Smart Volume Radar — Momentum Edition: setup brain.
 *
 * Single source of truth for the Stage 2 Momentum Breakout criteria:
 *   1. RVOL              — projectedRvol >= regime-aware threshold
 *   2. Stage 2 Advance   — price > SMA50 > SMA200, slope not declining
 *   3. Low Risk Entry    — distance from SMA21 ≤ 8%
 *   4. Pivot Breakout    — lastPrice >= ath * 0.98
 *   5. Tightness (VCP)   — daysSinceAth >= 15
 *   6. Momentum Gate     — return63d >= 20% (mandatory for Full AND Close)
 *
 * Plus an AVWAP guard (gap-day breakout must hold its anchored VWAP) and an
 * "Ants" accumulation flag (≥12 green days in last 15 — independent signal).
 *
 * This module is pure and synchronous. Wire it into the pipeline (index.ts) by
 * setting `stock.momentum = evaluateMomentumSetup(stock, { regime })` after fetch.
 */

import type { MomentumCriteria, MomentumLevel, MomentumResult, StockData } from '../types/index.js';

/** RVOL threshold for Full setup, regime-aware (bull=2.0, bear=3.0 — only the strongest fly in a downtrend). */
function rvolThresholdForRegime(regime: 'bull' | 'bear' | undefined): number {
    return regime === 'bear' ? 3.0 : 2.0;
}

/**
 * RVOL threshold above which a hot pivot break may BYPASS the SMA21-distance entry guard.
 * Rationale: when RVOL ≥ 3 AND price is at the pivot AND we're in Stage 2, that's institutional
 * conviction strong enough to override the "don't chase" rule. Without this, fast breakouts
 * (40%-in-2-weeks moves like INTC Sep '25) can never qualify as Full because SMA21 lags by design.
 */
const HIGH_CONVICTION_RVOL = 3.0;

/**
 * RVOL threshold for the Recovery Rally tier — higher than Full's 2.0 because we're
 * relaxing the Stage 2 SMA200 requirement. The bigger volume bar offsets the higher
 * false-positive risk of bear-market bounces.
 */
const RECOVERY_RVOL_THRESHOLD = 2.5;

/**
 * Minimum 63-day return (%) for the Momentum Gate — mandatory for Full and Close.
 * 1y replay (599 tickers, 2025-07→2026-07, episode-deduped 21d, 63d forward window):
 * Full WITHOUT the gate: 76.4% win / +10.9% median — statistically identical to the
 * watchlist baseline (76.3% / +11.6%), i.e. zero added edge. Full WITH mom63≥20:
 * 78.8% win / +15.7% median / 83.2% hit-rate(≥10%), consistent across both half-years
 * and directionally confirmed on the out-of-watchlist universe (54.3%→57.1% win,
 * +1.4%→+6.3% median). Sweep 0→40 is monotonic (no overfit spike). Independently
 * CONFIRMED by radar-criteria-tester on Apr–Jul 2026 real scans: suppressed Fulls
 * won 33% / −3.3% median vs kept 73% / +9.7%, with zero peak-≥30% false negatives.
 */
const MOMENTUM_GATE_MIN_RETURN_63D = 20;

/** Distance from SMA21 in % (absolute). Returns Infinity when SMA21 missing/zero (treated as fail). */
function distFromSma21Pct(price: number | undefined, sma21: number | undefined): number {
    if (price == null || sma21 == null || sma21 <= 0) return Infinity;
    return (Math.abs(price - sma21) / sma21) * 100;
}

/**
 * Evaluate the 5-criteria Momentum Setup for one stock.
 * Returns level + per-criterion booleans + names of failed criteria (for diagnostics).
 *
 * Levels:
 *   - 'full'  — all 5 main criteria true AND aboveGapAvwap true.
 *   - 'close' — RVOL ≥ 1.5 AND momentumGate AND pivotBreakout.
 *   - 'none'  — neither.
 *
 * Notes:
 *   - antsAccumulation is independent — does NOT gate Full (per spec it's a separate flag).
 *   - aboveGapAvwap returns true when there is no gap day (no AVWAP guard needed).
 *   - When projectedRvol is missing, falls back to raw rvol (after-close they are equal anyway).
 */
export function evaluateMomentumSetup(
    s: StockData,
    opts: { regime?: 'bull' | 'bear' } = {}
): MomentumResult {
    const regime = opts.regime ?? s.marketRegime;
    const rvolThreshold = rvolThresholdForRegime(regime);

    const effectiveRvol = s.projectedRvol ?? s.rvol ?? 0;

    // 1. RVOL gate
    const rvolPass = effectiveRvol >= rvolThreshold;

    // 2. Stage 2 Advance: price > SMA50 > SMA200 AND slope not 'down'
    const stage2 =
        s.lastPrice != null &&
        s.sma50 != null &&
        s.sma200 != null &&
        s.lastPrice > s.sma50 &&
        s.sma50 > s.sma200 &&
        s.sma200Slope !== 'down';

    // 3. Low Risk Entry: distance from SMA21 ≤ 8%
    const lowRiskEntry = distFromSma21Pct(s.lastPrice, s.sma21) <= 8;

    // 4. Pivot Breakout: lastPrice >= ath * 0.98.
    // A 0.99 tightening was tried 2026-07-09 and REVERTED same day: the 1y replay gave
    // it only +0.5pp win / +1.3 median, while the 90d real-scan validation showed the
    // newly-cut 1–2%-below band OUTPERFORMING (UCTT +58%, SNDK +51%, 000660.KS +51%
    // all suppressed). Marginal measured gain + concrete false negatives → keep 0.98.
    const pivotBreakout =
        s.ath != null && s.ath > 0 && s.lastPrice != null && s.lastPrice >= s.ath * 0.98;

    // 5. Tightness: daysSinceAth >= 15
    const tightness = (s.daysSinceAth ?? 0) >= 15;

    // 6. Momentum Gate: 63-day return >= 20%. Missing return63d (history < 64 bars,
    // e.g. recent IPOs) fails the gate — a stock we can't measure momentum on is not
    // a momentum setup. See MOMENTUM_GATE_MIN_RETURN_63D for the 1y-replay evidence.
    const momentumGate = (s.return63d ?? 0) >= MOMENTUM_GATE_MIN_RETURN_63D;

    // AVWAP guard: only meaningful once the AVWAP has had several bars to develop.
    // On the gap day itself (and the next ~2 bars), AVWAP collapses to ~the bar's typical price —
    // pure intraday noise, not a trend reference. Skip the guard until day 3+ post-gap.
    const MIN_BARS_AFTER_GAP = 3;
    const aboveGapAvwap =
        s.gapDay == null || s.avwapFromGap == null || s.lastPrice == null
            ? true
            : s.gapDay.barsAgo < MIN_BARS_AFTER_GAP
              ? true
              : s.lastPrice >= s.avwapFromGap;

    // Ants accumulation (independent flag, does not gate Full):
    // ≥12 green days in last 15 AND projectedRvol ≥ 1.2 (some institutional warmth).
    const antsAccumulation = (s.consecutiveGreenDays ?? 0) >= 12 && effectiveRvol >= 1.2;

    // Big-move quality marker: today's price move ≥ 3% — captures explosive continuation
    // breakouts even when there's no fresh base (INTC continuation $50→$100 case).
    // Requires the move to be UP (not a 3% selloff).
    const bigMoveToday = (s.priceChange ?? 0) >= 3;

    const criteria: MomentumCriteria = {
        rvolPass,
        stage2,
        lowRiskEntry,
        pivotBreakout,
        tightness,
        aboveGapAvwap,
        antsAccumulation,
        bigMoveToday,
        momentumGate,
    };

    // ─── Level decision (redesigned) ──────────────────────────────────────
    //
    // Empirical finding from 17-month backtest across INTC/AMKR/MXL/NBIS:
    // the original "all 5 criteria mandatory" design caught 1 Full alert during
    // INTC's $30→$100 +230% rally, missed every single MXL +270% breakout day
    // (incl. RVOL 18.81 on 24.4.26), missed 4 NBIS breakouts, missed 2 AMKR
    // breakouts — because lowRiskEntry+tightness *both* fail on continuation
    // breakouts (price extends from SMA21 fast; new ATH every day = no base).
    //
    // New design separates *mandatory trend/conviction signals* from *quality
    // markers* (pristine entry from base):
    //
    //   MANDATORY (all four must pass):
    //     • rvolPass        — institutional volume (regime-aware threshold)
    //     • stage2          — uptrend regime not broken
    //     • pivotBreakout   — actually at/breaking the 52w high
    //     • aboveGapAvwap   — gap-day breakout (if any) still respected
    //
    //   QUALITY (at least ONE must pass — proves "not pure noise"):
    //     • lowRiskEntry        — clean entry near SMA21
    //     • tightness           — real consolidation base ≥ 15 days
    //     • antsAccumulation    — quiet uptrend signal (≥12 green/15)
    //     • effectiveRvol ≥ 3   — extreme institutional confirmation
    //
    //   `momentumGate` ADDED to MANDATORY 2026-07-09 (1y replay, 599×252d): without
    //   it Full carried zero edge over the watchlist baseline (76.4% vs 76.3% win);
    //   with it 79.3% win / +17.0% median / 84.5% hit-rate. The demoted cohort
    //   (mom63<20 or >1% below ATH) won only 69.9% with +5.5% median — correctly cut.
    const MANDATORY: Array<keyof MomentumCriteria> = [
        'rvolPass',
        'stage2',
        'pivotBreakout',
        'aboveGapAvwap',
        'momentumGate',
    ];
    // QUALITY bucket — at least ONE must pass to qualify Full.
    // `lowRiskEntry` REMOVED 2026-05-22 (TD-9) — empirically the strongest
    // anti-predictor: −25.6% lift (60d), −65.3% lift (1y bull). Validated by
    // radar-criteria-tester subagent: removing it cuts 8 alerts (all outside
    // Semi/AI engines, all below cohort median), bumps median +1.8pp, hit-rate
    // (>10%) +5.9pp. See ~/cabinet/outputs/2026-05-22-svr-criteria-test-drop-lowRiskEntry.md
    // and decisions-log. 2026-07-17: also removed from the Close tier gate
    // (4y replay confirmed Δ≈−26pp; see comment on the gate below). The boolean
    // is still computed and used in:
    //   - highConvictionBypass flag: "extended entry" diagnostic
    //   - championScore penalty + gold-tier alert gate (requires FAIL)
    const QUALITY: Array<keyof MomentumCriteria> = [
        'tightness',
        'antsAccumulation',
        'bigMoveToday',
    ];

    const mandatoryAllPass = MANDATORY.every((k) => criteria[k]);
    const qualityFromCriteria = QUALITY.some((k) => criteria[k]);
    const qualityFromHighRvol = effectiveRvol >= HIGH_CONVICTION_RVOL;
    const hasQualityMarker = qualityFromCriteria || qualityFromHighRvol;

    // Failures list: every criterion currently NOT met (informational, for UI/debug).
    // `lowRiskEntry` is included here even though it's not in the QUALITY gate
    // (TD-9, 2026-05-22) nor the Close tier (2026-07-17) anymore — it remains a
    // useful diagnostic and is still consumed by the highConvictionBypass flag,
    // the score penalty, and the gold-tier alert gate (which requires it to FAIL).
    const allKeys: Array<keyof MomentumCriteria> = [...MANDATORY, ...QUALITY, 'lowRiskEntry'];
    const failures = allKeys.filter((k) => !criteria[k]);

    let level: MomentumLevel;
    let highConvictionBypass = false;
    if (mandatoryAllPass && hasQualityMarker) {
        level = 'full';
        // Flag "extended entry" cases: Full granted but lowRiskEntry/tightness aren't
        // both clean (i.e., the entry isn't from a textbook VCP base). Useful for the
        // trader to know "this is a continuation chase, not a clean breakout entry".
        if (!lowRiskEntry || !tightness) highConvictionBypass = true;
    } else if (effectiveRvol >= 1.5 && momentumGate && pivotBreakout) {
        // Close gate tightened 2026-07-09 (1y replay + 90d real-scan validation): the old
        // rvol≥1.5 & (pivot|lowRisk) fired 1,674 episodes/yr at +12.0% median; adding
        // momentumGate cuts to 700 (−58%) at +18.9% median / 84.6% hit-rate, stable across
        // both half-years. Deliberately does NOT require stage2: the high-momentum
        // non-Stage-2 cohort (ATH break while SMA200 structure still lags — ARM/ALAB/MU
        // pattern) was the best slice of the whole tier (80.3% win, +35.6% median), and
        // the Recovery tier's RVOL≥2.5 bar does not rescue it (those fired at rvol ~1.9-2.0).
        //
        // `lowRiskEntry` REMOVED from this gate 2026-07-17 — its last promoting role.
        // 4-year production replay (1,008 td, 2022-07→2026-07, 42,131 flags, ±10%/21td):
        // flags where lowRiskEntry PASSES win 10-22% vs 36%+ when it FAILS (Δ≈−26pp,
        // n≈7.3k/6.1k), consistent in every yearly fold. Aligned with TD-9 (2026-05-22)
        // which already dropped it from the Full QUALITY bucket. The boolean is still
        // computed for diagnostics, the score penalty, and highConvictionBypass.
        level = 'close';
    } else {
        level = 'none';
    }

    // Recovery Rally tier — for stocks reclaiming key levels out of a bear market
    // BEFORE SMA200 has turned up. Caught NBIS (+450%) and WOLF (+128%) which
    // strict Stage 2 correctly rejected as Full but missed entirely.
    //
    // Conditions (all required):
    //   • Stage 2 currently FAILING (otherwise it'd already be Full above)
    //   • lastPrice > SMA50 (above mid-term mean — proves base above the wreckage)
    //   • SMA50 slope = up (mid-term trend turning, even if SMA200 still down)
    //   • pivotBreakout ✓ (actually breaking 52w high, not just bouncing)
    //   • aboveGapAvwap ✓ (gap-day discipline holds, when applicable)
    //   • effectiveRvol ≥ 2.5 (institutional confirmation — higher bar than Full)
    //
    // Recovery never DOWNGRADES Full or Close — only PROMOTES from None.
    if (
        level !== 'full' &&
        !stage2 &&
        s.lastPrice != null &&
        s.sma50 != null &&
        s.lastPrice > s.sma50 &&
        s.sma50Slope === 'up' &&
        pivotBreakout &&
        aboveGapAvwap &&
        effectiveRvol >= RECOVERY_RVOL_THRESHOLD
    ) {
        level = 'recovery';
    }

    const result: MomentumResult = { level, criteria, failures, rvolThreshold };
    if (highConvictionBypass) result.highConvictionBypass = true;
    return result;
}

/** Human-readable failure reason for one criterion (Hebrew, used in Telegram tooltips). */
export function describeFailure(key: keyof MomentumCriteria): string {
    switch (key) {
        case 'rvolPass':
            return 'RVOL נמוך מהסף';
        case 'stage2':
            return 'לא Stage 2 (price/SMA50/SMA200)';
        case 'lowRiskEntry':
            return 'רחוק מ-SMA21 (>8%)';
        case 'pivotBreakout':
            return 'לא קרוב ל-52w high';
        case 'tightness':
            return 'אין VCP (פחות מ-15 ימים מהשיא)';
        case 'aboveGapAvwap':
            return 'מתחת ל-AVWAP של הגאפ';
        case 'antsAccumulation':
            return 'אין Ants accumulation';
        case 'bigMoveToday':
            return 'תזוזה קטנה היום (<3%)';
        case 'momentumGate':
            return 'מומנטום 63 ימים נמוך (<20%)';
    }
}
