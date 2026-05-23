/**
 * Smart Volume Radar — Champion Score layer (2026-05-06).
 *
 * Inspired by championscan.com after research session 2026-05-06.
 * This layer pairs the existing tier-based momentum signal with two
 * orthogonal signals familiar to growth investors:
 *
 *   1. A continuous quality score 0-100 (composite of stable predictors
 *      from our 2026-05-06 criteria-importance analysis)
 *   2. An action label (BUY / WATCH / CAUTION_* / PASS / PASS_TOO_LATE)
 *      that turns the score into a recommendation by also considering
 *      breakout stage, extension %, and volume confirmation.
 *
 * Plus a trade plan (pivot / buy zone / stop / risk %) for execution.
 *
 * All weights here are derived from the criteria-importance analysis on
 * 86 days of data (Jan 5 → May 4 2026). Stable train/test predictors
 * get weight; unstable ones (`tightness`, `bigMoveToday`) are excluded.
 *
 * This module is pure & synchronous. It expects `stock.momentum` to
 * already be populated by `evaluateMomentumSetup`.
 */
import type {
    ActionLabel,
    BreakoutStage,
    MomentumCriteria,
    StockData,
    TradePlan,
} from '../types/index.js';

/** Weights — derived from train+test stable lifts in the 86-day analysis. */
const WEIGHTS = {
    /** pivotBreakout: lift 1.75x train → 10x test, the strongest single predictor */
    pivotBreakout: 25,
    /** stage2: lift 1.37x train → 3.29x test */
    stage2: 15,
    /** rvolPass (≥2 in bull / ≥3 in bear): mild positive at +3-10td, mild anti at +20td.
     *  Net contribution kept small but positive — RVOL ≥ threshold remains useful as
     *  a confirmation gate. */
    rvolPass: 8,
    /** antsAccumulation: lift 2.0x in test, small sample but consistent direction */
    antsAccumulation: 5,
    /** aboveGapAvwap: stable ~1.0x (neutral) but a meaningful guard when a gap exists */
    aboveGapAvwap: 5,
    /** lowRiskEntry: lift 0.74-0.82x stable across both halves — penalty when TRUE
     *  in this bull regime ("don't chase pullbacks; ride strength"). Re-evaluate
     *  in a bear regime — likely flips. */
    lowRiskEntryPenalty: -10,
    /** Stocks below SMA200 are off-trend in this regime — hard penalty. */
    belowSma200: -15,
    // ─── Phase 2 weights (2026-05-07) ──────────────────────────────────
    /** Accumulation days ≥ 3 in last 25 = institutional buying confirmation. */
    accumulation: 5,
    /** Distribution days ≥ 3 in last 25 = institutional selling warning. */
    distributionPenalty: -10,
    /** RS percentile ≥ 80 = top quintile of watchlist by 63d alpha vs SPY. */
    topRS: 5,
    /** Bollinger Band squeeze (BB-width / price < 5%) = volatility contraction
     *  preceding many breakouts. */
    bbSqueeze: 3,
    // ─── Phase 3 weights (fundamentals, 2026-05-07) ────────────────────
    /** EPS YoY growth-rate accelerating Q-over-Q — institutional buying fuel. */
    epsAccelerating: 5,
    /** EPS YoY growth-rate decelerating — material slowdown, reduce score. */
    epsDeceleratingPenalty: -5,
    /** Revenue YoY growth-rate accelerating — confirms top-line expansion. */
    revAccelerating: 3,
    // ─── Phase 4B (sector rank, 2026-05-09) ───────────────────────────
    /** Top-3 sector by 63d median return — only when sector has ≥5 stocks. */
    topSector: 5,
} as const;

/** Minimum sector size for the top-3 bonus to apply (anti-gaming guard). */
const MIN_SECTOR_SIZE_FOR_BONUS = 5;

/** Threshold for the BB squeeze flag: (upper - lower) / price as a fraction. */
const BB_SQUEEZE_FRACTION = 0.05;

/** Threshold for `rvolPass` is regime-aware (mirrors evaluateMomentumSetup). */
function rvolPassThreshold(regime: 'bull' | 'bear' | undefined): number {
    return regime === 'bear' ? 3.0 : 2.0;
}

/** Effective RVOL: prefer projectedRvol when available (intraday-aware). */
function effectiveRvol(s: StockData): number {
    return s.projectedRvol ?? s.rvol ?? 0;
}

/**
 * Compute the continuous Champion Score 0-100 from the momentum criteria
 * snapshot. Returns 50 (baseline) when criteria are missing.
 */
export function computeChampionScore(stock: StockData): number {
    const criteria: MomentumCriteria | undefined = stock.momentum?.criteria;
    if (!criteria) return 50;

    let score = 50;

    // Positive contributions (stable predictors)
    if (criteria.pivotBreakout) score += WEIGHTS.pivotBreakout;
    if (criteria.stage2) score += WEIGHTS.stage2;
    if (criteria.rvolPass) score += WEIGHTS.rvolPass;
    if (criteria.antsAccumulation) score += WEIGHTS.antsAccumulation;
    if (criteria.aboveGapAvwap) score += WEIGHTS.aboveGapAvwap;

    // Penalty: lowRiskEntry was anti-predictive in our bull-only data.
    if (criteria.lowRiskEntry) score += WEIGHTS.lowRiskEntryPenalty;

    // Hard penalty: price below SMA200 = off-trend
    if (stock.sma200 != null && stock.lastPrice < stock.sma200) {
        score += WEIGHTS.belowSma200;
    }

    // Bonus from raw RVOL beyond pass threshold (continuous, capped).
    // RVOL of 2 → +0, RVOL of 4 → +5, RVOL of 6+ → +10.
    const rvol = effectiveRvol(stock);
    if (rvol > 2) {
        const bonus = Math.min(10, (rvol - 2) * 2.5);
        score += bonus;
    }

    // ─── Phase 2 contributors ─────────────────────────────────────────
    if ((stock.accumulationDays ?? 0) >= 3) score += WEIGHTS.accumulation;
    if ((stock.distributionDays ?? 0) >= 3) score += WEIGHTS.distributionPenalty;
    if ((stock.rsPercentile ?? 0) >= 80) score += WEIGHTS.topRS;
    if (isBBSqueeze(stock)) score += WEIGHTS.bbSqueeze;

    // ─── Phase 3 contributors (fundamentals) ──────────────────────────
    if (stock.epsAcceleration === 'accelerating') score += WEIGHTS.epsAccelerating;
    else if (stock.epsAcceleration === 'decelerating') score += WEIGHTS.epsDeceleratingPenalty;
    if (stock.revAcceleration === 'accelerating') score += WEIGHTS.revAccelerating;

    // ─── Phase 4B: Top-sector bonus ───────────────────────────────────
    if (
        stock.sectorRank != null &&
        stock.sectorRank <= 3 &&
        (stock.sectorTotalCount ?? 0) >= MIN_SECTOR_SIZE_FOR_BONUS
    ) {
        score += WEIGHTS.topSector;
    }

    return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

/** True when Bollinger Band width is < 5% of price (volatility contraction). */
export function isBBSqueeze(stock: StockData): boolean {
    if (stock.bbUpper == null || stock.bbLower == null || !stock.lastPrice) return false;
    const width = stock.bbUpper - stock.bbLower;
    if (width <= 0) return false;
    return width / stock.lastPrice < BB_SQUEEZE_FRACTION;
}

/**
 * Determine breakout stage from price relative to ATH and `daysSinceAth`.
 * Returns null when ATH isn't available.
 *
 * Rules:
 *   - Breaking Out: price ≥ ATH AND daysSinceAth ≤ 1 (today or yesterday set new high)
 *   - Fresh:        1 < daysSinceAth ≤ 3 AND price ≥ ATH × 0.97
 *   - Aging:        3 < daysSinceAth ≤ 10 AND price ≥ ATH × 0.95
 *   - Failed:       price < ATH × 0.85 (deep below pivot — base broken)
 *   - Pre-Pivot:    daysSinceAth > 10 AND price ≥ ATH × 0.90 (in tight base near top)
 *   - Setup:        otherwise (in a base, lower in range)
 */
export function computeBreakoutStage(stock: StockData): BreakoutStage | undefined {
    if (stock.ath == null || stock.ath <= 0 || stock.lastPrice == null) return undefined;
    const ratio = stock.lastPrice / stock.ath;
    const days = stock.daysSinceAth ?? 0;

    if (days <= 1 && ratio >= 1.0) return 'Breaking Out';
    if (days <= 3 && ratio >= 0.97) return 'Fresh';
    if (days <= 10 && ratio >= 0.95) return 'Aging';
    if (ratio < 0.85) return 'Failed';
    if (ratio >= 0.90) return 'Pre-Pivot';
    return 'Setup';
}

/**
 * Build the trade plan: pivot, buy zone, stop loss, risk %, distance, extension.
 * Returns undefined when ATH/price not available.
 */
export function computeTradePlan(stock: StockData): TradePlan | undefined {
    if (stock.ath == null || stock.ath <= 0 || stock.lastPrice == null) return undefined;
    const pivot = stock.ath;
    const buyZoneLow = pivot * 0.98;
    const buyZoneHigh = pivot * 1.02;
    const stopLoss = stock.sma21 != null && stock.sma21 > 0 ? stock.sma21 * 0.95 : null;
    const riskPct =
        stopLoss != null && stock.lastPrice > 0
            ? ((stopLoss - stock.lastPrice) / stock.lastPrice) * 100
            : null;
    // distanceToEntry: positive when price is BELOW pivot (still need to climb).
    // negative when ABOVE pivot (extension).
    const distanceToEntryPct = ((pivot - stock.lastPrice) / pivot) * 100;
    const extensionPct = stock.lastPrice > pivot ? ((stock.lastPrice - pivot) / pivot) * 100 : 0;
    return {
        pivot,
        buyZoneLow,
        buyZoneHigh,
        stopLoss,
        riskPct,
        distanceToEntryPct,
        extensionPct,
    };
}

/**
 * Decide the action label from score + breakout stage + extension + volume.
 * Inspired by ChampionScan's 6-state vocabulary, adapted to our criteria.
 *
 * Decision tree:
 *   1. If score < 40 → PASS (weak setup overall)
 *   2. If sector 63d median < 0 → PASS (TD-10: loser-cohort gate)
 *   3. Determine the base action from stage/extension/RVOL cascade.
 *   4. If base action is BUY or WATCH AND distributionDays ≥ 4 → demote
 *      to CAUTION_DISTRIBUTION (institutional selling on an otherwise-
 *      actionable setup is the only case where the warning is meaningful).
 *   5. Otherwise return base action.
 */
export function determineAction(
    stock: StockData,
    score: number,
    stage: BreakoutStage | undefined,
    plan: TradePlan | undefined
): ActionLabel {
    if (score < 40) return 'PASS';

    // Negative-sector guard (TD-10, 2026-05-22): sectors with 63d median return < 0
    // were a coherent loser cohort in the 60-day study (Aerospace & Defense: 55
    // alerts, 24% hit rate, −9.8% median). Hiding these from the action tier is
    // more truthful than warning about them. The NOTABLE filter has belt-and-
    // suspenders for the same condition. Stocks are still TRACKED (their signal
    // level + criteria are computed) but they don't propagate to the Telegram
    // action list.
    if (stock.sectorMedianReturn63d != null && stock.sectorMedianReturn63d < 0) {
        return 'PASS';
    }

    // ─── Base action from the stage/extension/RVOL cascade ────────────
    const baseAction = computeBaseAction(stock, score, stage, plan);

    // Distribution-pressure demotion (TD-13, 2026-05-23): institutional
    // selling pressure only matters when there's a setup to protect.
    //
    // Old design (2026-05-22 spam-fix predecessor): distributionDays ≥ 4
    // returned CAUTION_DISTRIBUTION unconditionally, BEFORE the stage/plan
    // checks. Result on 2026-05-22: 93 CAUTION_DISTRIBUTION alerts, of which
    // 86 had momentum=none (no setup at all) and 78 had RVOL<1.2 (stock not
    // waking up). The warning fired on dead stocks just because the
    // market-wide pullback racked up down-days-with-volume across the board.
    //
    // New design: only demote BUY/WATCH base actions to CAUTION_DISTRIBUTION.
    // A stock that would otherwise be PASS stays PASS — no false-positive
    // "watch out" warning on stocks the trader wasn't going to act on anyway.
    if (
        (baseAction === 'BUY' || baseAction === 'WATCH') &&
        (stock.distributionDays ?? 0) >= 4
    ) {
        return 'CAUTION_DISTRIBUTION';
    }

    return baseAction;
}

/**
 * The base action from stage/extension/RVOL, before the distribution-pressure
 * demotion is applied. Exported only for test usage; production code should
 * call `determineAction` which layers the demotion on top.
 */
function computeBaseAction(
    stock: StockData,
    score: number,
    stage: BreakoutStage | undefined,
    plan: TradePlan | undefined
): ActionLabel {
    if (!stage || !plan) return score >= 60 ? 'WATCH' : 'PASS';

    if (plan.extensionPct > 10) return 'PASS_TOO_LATE';
    if (plan.extensionPct > 5) return 'CAUTION_EXTENDED';
    if (stage === 'Failed') return 'PASS';

    const rvolConfirmed = effectiveRvol(stock) >= rvolPassThreshold(stock.marketRegime);

    if (stage === 'Breaking Out') {
        return rvolConfirmed ? 'BUY' : 'CAUTION_NO_VOL';
    }
    if (stage === 'Fresh' || stage === 'Aging') {
        return rvolConfirmed ? 'BUY' : 'CAUTION_NO_VOL';
    }
    // WATCH gates (tightened 2026-05-10):
    // - Score thresholds raised (Pre-Pivot 60→65, Setup 65→70) to cut noise.
    // - Minimum RVOL ≥ 1.2 — anything below = the stock isn't waking up.
    //   Without this, dead-quiet bases were flooding the report.
    const rvol = effectiveRvol(stock);
    const MIN_WATCH_RVOL = 1.2;
    if (rvol < MIN_WATCH_RVOL) return 'PASS';
    if (stage === 'Pre-Pivot' && score >= 65) return 'WATCH';
    if (stage === 'Setup' && score >= 70) return 'WATCH';
    return 'PASS';
}

/**
 * Run the full Champion Score evaluation, mutating the stock in place
 * (in line with how evaluateMomentumSetup is wired). Returns a summary
 * for logging convenience.
 */
export function applyChampionScore(stock: StockData): {
    score: number;
    action: ActionLabel;
    stage: BreakoutStage | undefined;
} {
    const score = computeChampionScore(stock);
    const stage = computeBreakoutStage(stock);
    const plan = computeTradePlan(stock);
    const action = determineAction(stock, score, stage, plan);

    stock.championScore = score;
    stock.breakoutStage = stage;
    stock.tradePlan = plan;
    stock.action = action;

    return { score, action, stage };
}

/** Hebrew label for the action — used in Telegram blocks. */
export const ACTION_LABEL_HE: Record<ActionLabel, string> = {
    BUY: 'קנייה — על ה-pivot, נפח מאשר',
    WATCH: 'מעקב — setup מתפתח',
    CAUTION_EXTENDED: 'זהירות — extended מעבר ל-pivot',
    CAUTION_NO_VOL: 'זהירות — על ה-pivot אבל ללא נפח מספק',
    CAUTION_DISTRIBUTION: 'זהירות — לחץ מכירה מוסדי (distribution days)',
    PASS_TOO_LATE: 'דילוג — extended יותר מדי, איחרת',
    PASS: 'דילוג — לא עומד בקריטריונים',
};

/** Emoji prefix per action — used in Telegram blocks. */
export const ACTION_EMOJI: Record<ActionLabel, string> = {
    BUY: '🟢',
    WATCH: '👀',
    CAUTION_EXTENDED: '⚠️',
    CAUTION_NO_VOL: '⚠️',
    CAUTION_DISTRIBUTION: '🔻',
    PASS_TOO_LATE: '⏰',
    PASS: '⏭️',
};
