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
    EntryGrade,
    MomentumCriteria,
    StockData,
    TradePlan,
} from '../types/index.js';
import type { TickerStats } from './tickerStats.js';
import { isSectorBlacklisted } from './sectorOutcomes.js';
import path from 'node:path';

// Project results dir — used to read results/sector-outcomes.json at runtime
// for the dynamic TD-15 sector blacklist. process.cwd() is the project root
// when running via npm/tsx; tests don't read this file (sectorOutcomes falls
// back to its hardcoded list when the file is missing).
const RESULTS_DIR_CS = path.join(process.cwd(), 'results');

// ─── TD-15 (2026-05-23) — Persistent-Loser Sector Blacklist (DYNAMIC) ──
// Originally a hardcoded constant. Now loaded from `results/sector-outcomes.json`
// at runtime (see src/utils/sectorOutcomes.ts), which is refreshed weekly via
// scripts/bootstrap-ticker-outcomes.ts → automated GHA workflow. Sectors flip
// in/out of the blacklist as the data shifts. Hardcoded fallback in sectorOutcomes.ts
// kicks in if the file is missing.

// ─── TD-18 (2026-05-23) — Cleantech Utility Soft-Action Blacklist ───────
// US regulated utilities + sector ETFs that constantly trigger CAUTION_NO_VOL
// in Cleantech but never break out (regulated business, no catalyst). Suppresses
// ONLY CAUTION_NO_VOL and WATCH — genuine BUY setups still surface.
// Reduces Cleantech alerts 673→353 (-47.5%), lifts win rate 30%→54%.
const CLEANTECH_UTILITY_BLACKLIST = new Set<string>([
    'SUN', 'AEP', 'SRE', 'NEE', 'PPL', 'GNRC', 'NRG', 'ENLT', 'ENLT.TA',
    'TAN', 'ENRG.TA', 'ORA', 'ORA.TA', 'RUN', 'ARRY',
]);

// ─── TD-16 (2026-05-23) — Sector-Too-Hot Demotion Threshold ─────────────
// Sectors with median 63d ≥ this fraction → BUY demoted to WATCH (don't chase
// already-extended sectors). Precision analysis: ≥30% median → only 31% win
// vs 61% in the 20-30% sweet spot.
const SECTOR_TOO_HOT_THRESHOLD = 35;

// ─── TD-20 (2026-05-23) — Ticker-Fatigue Threshold ──────────────────────
// After N alerts on the same ticker in the last 20 trading days → demote to
// PASS. Multi-event analysis: 52% of alerts were 11th+ on same ticker, with
// median forward-now return only +7% vs +20% on first alert.
const FATIGUE_THRESHOLD = 10;

// ─── TD-22 (2026-05-23) — Sector-Override Promotion Threshold ───────────
// In a top-3 sector, ≥N BUY/WATCH flags in last 10 td → promote CAUTION_NO_VOL
// to WATCH (label was hiding good signals on DELL/AIXA.DE/NOKI.VI — 89-100% win
// rates as C_NO_VOL).
const IN_TREND_THRESHOLD = 2;

// ─── TD-14 (2026-05-23) — CAUTION_NO_VOL minimum RVOL ───────────────────
// RVOL below this → suppress CAUTION_NO_VOL entirely. Precision analysis:
// RVOL<1.0 bucket (1,772 alerts) had only 36% win. Stocks with sub-average
// volume don't deserve a Telegram line.
const MIN_RVOL_FOR_NO_VOL_WARNING = 1.0;

// ─── TD-25 (2026-06-02) — Entry-Quality Grade (flag-only) ───────────────
// From the entry-precision study (scripts/entry-precision-study.ts over 2,762
// historical flags), four dials independently isolate the highest-precision
// entries. Each lifts win-rate from a ~51% baseline:
//   • momentum level full/recovery   → 64% / 70%   (vs close 53%)
//   • RVOL in [3, 10)                 → 66% / 63%   (vs <2 51%, ≥10 53% climax)
//   • championScore ≥ 90              → 66%         (monotonic from 44% @<60)
//   • distributionDays ≤ 2            → 60%         (vs 6+ days 48%)
// Grade = count of dials hit: 4 → A+, 3 → A, 2 → B, else ungraded.
const TD25_RVOL_FLOOR = 3;
const TD25_RVOL_CEIL = 10; // ≥10 is exhaustion/climax — does NOT earn the dial
const TD25_SCORE_FLOOR = 90;
const TD25_MAX_DISTRIBUTION = 2;

// ─── TD-26 (2026-06-02) — ADR% dial (5th entry-grade dial) ──────────────
// From scripts/adr-study.ts: ADR% (Qullamaggie's Average Daily Range) is
// monotonic with forward return (<3% → 54% win, ≥9% → 69%). Crucially, an
// ADR ≥ 5% on a 3-4-dial entry lifts win-rate to ~87% (n=39). Added as the
// 5th dial: A+ now = 5/5, A = 4/5, B = 3/5.
const TD26_ADR_FLOOR = 5;

/** Weights — derived from train+test stable lifts in the 86-day analysis. */
const WEIGHTS = {
    /** pivotBreakout: REDUCED 25 → 12 (TD-17, 2026-05-23). The +25 weight was
     *  mechanically stuffing post-breakout, distribution-heavy stocks into the
     *  80-89 score band, producing a non-monotonic win-rate curve (90-100=48%,
     *  80-89=31%, 70-79=45%). Simulation showed cutting to +12 restores
     *  monotonicity (52% → 36% → 30% → 23%). pivotBreakout still has lift but
     *  shouldn't dominate other criteria. */
    pivotBreakout: 12,
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
    plan: TradePlan | undefined,
    stats?: TickerStats
): ActionLabel {
    if (score < 40) return 'PASS';

    // ─── TD-10: Negative-sector daily guard ───────────────────────────
    // Sectors with 63d median return < 0 are demoted to PASS. The 60-day
    // study showed these were coherent loser cohorts (e.g. Aerospace & Defense:
    // 24% hit rate, -9.8% median).
    if (stock.sectorMedianReturn63d != null && stock.sectorMedianReturn63d < 0) {
        return 'PASS';
    }

    // ─── TD-15: Persistent-loser sector blacklist (DYNAMIC) ───────────
    // Reads results/sector-outcomes.json (auto-refreshed weekly). Fallback
    // hardcoded list applies if the file is missing.
    if (isSectorBlacklisted(RESULTS_DIR_CS, stock.sector)) {
        return 'PASS';
    }

    // ─── TD-21: Per-ticker auto-blacklist ─────────────────────────────
    // Tickers whose trailing-30-alert win rate dropped below 10% with n≥8.
    // Populated by scripts/bootstrap-ticker-outcomes.ts.
    if (stats?.isBlacklisted) {
        stock.isBlacklisted = true;
        return 'PASS';
    }

    // ─── TD-20: Ticker fatigue ────────────────────────────────────────
    // After 10+ alerts in the last 20 td on the same ticker, demote. Keeps
    // the watchlist visible but suppresses the daily Telegram line.
    if (stats && stats.alertCount20td >= FATIGUE_THRESHOLD) {
        stock.isFatigued = true;
        return 'PASS';
    }

    // ─── TD-18: Cleantech utility blacklist (suppresses soft actions) ─
    // Compute base FIRST so we can check what action would have fired.
    const baseAction = computeBaseAction(stock, score, stage, plan);

    if (
        stock.sector === 'Cleantech' &&
        CLEANTECH_UTILITY_BLACKLIST.has(stock.ticker.toUpperCase()) &&
        (baseAction === 'CAUTION_NO_VOL' || baseAction === 'WATCH')
    ) {
        return 'PASS';
    }

    // ─── TD-14: Minimum RVOL for CAUTION_NO_VOL ───────────────────────
    // Below 1.0 RVOL = sub-average volume = not waking up. Suppress.
    if (baseAction === 'CAUTION_NO_VOL' && effectiveRvol(stock) < MIN_RVOL_FOR_NO_VOL_WARNING) {
        return 'PASS';
    }

    // ─── TD-16: Sector-too-hot demotion ───────────────────────────────
    // Sectors that already ran ≥35% in 63d have only 31% win on BUYs. Demote
    // BUY → WATCH (force user to confirm not chasing).
    let action: ActionLabel = baseAction;
    if (
        action === 'BUY' &&
        stock.sectorMedianReturn63d != null &&
        stock.sectorMedianReturn63d >= SECTOR_TOO_HOT_THRESHOLD
    ) {
        action = 'WATCH';
    }

    // ─── TD-22: Sector-override promotion ─────────────────────────────
    // In a top-3 sector, when a ticker is in an established uptrend (≥2
    // BUY/WATCH flags in last 10 td), promote its CAUTION_NO_VOL to WATCH.
    // Catches sustained AI-Chain / Semis trends where the label was hiding good
    // signals (DELL/AIXA.DE/NOKI.VI win 89-100% as C_NO_VOL).
    if (
        action === 'CAUTION_NO_VOL' &&
        stock.sectorRank != null &&
        stock.sectorRank <= 3 &&
        stats &&
        stats.inTrendCount10td >= IN_TREND_THRESHOLD
    ) {
        action = 'WATCH';
        stock.sectorOverrideApplied = true;
    }

    // ─── TD-13: Distribution-pressure demotion (only on actionable) ───
    // distributionDays ≥ 4 demotes BUY/WATCH to CAUTION_DISTRIBUTION only.
    if (
        (action === 'BUY' || action === 'WATCH') &&
        (stock.distributionDays ?? 0) >= 4
    ) {
        action = 'CAUTION_DISTRIBUTION';
    }

    // ─── TD-19: Double-BUY flag (no demotion; flag only) ──────────────
    // BUY today AND BUY on the prior scan = 82% win rate, +49% peak. Tag for
    // formatter to highlight with 🔥.
    if (action === 'BUY' && stats?.previousDayAction === 'BUY') {
        stock.isDoubleBuy = true;
    }

    // ─── TD-23: Hot-streak flag (no demotion; flag only) ──────────────
    if (stats?.isHotStreak) {
        stock.isHotStreak = true;
    }

    // ─── TD-25: Entry-quality grade (flag only, BUY/WATCH only) ───────
    // Ranks how precise an actionable entry is. Does not change the action.
    if (action === 'BUY' || action === 'WATCH') {
        const grade = computeEntryGrade(stock, score);
        if (grade) stock.entryGrade = grade;
    }

    return action;
}

/**
 * TD-25 + TD-26 — grade an actionable entry on the five empirically-validated
 * precision dials. Returns 'A+' (5/5), 'A' (4/5), 'B' (3/5), or undefined (<3).
 * Flag-only. Validation (BUY+WATCH, n=403): A+ 87% win / +33.7% peak,
 * A 75% / +22%, B 66%, ungraded ~53%.
 */
function computeEntryGrade(stock: StockData, score: number): EntryGrade | undefined {
    const rvol = effectiveRvol(stock);
    let dials = 0;
    if (stock.momentum?.level === 'full' || stock.momentum?.level === 'recovery') dials++;
    if (rvol >= TD25_RVOL_FLOOR && rvol < TD25_RVOL_CEIL) dials++;
    if (score >= TD25_SCORE_FLOOR) dials++;
    if ((stock.distributionDays ?? 0) <= TD25_MAX_DISTRIBUTION) dials++;
    if ((stock.adrPct ?? 0) >= TD26_ADR_FLOOR) dials++; // TD-26 ADR% dial

    if (dials >= 5) return 'A+';
    if (dials === 4) return 'A';
    if (dials === 3) return 'B';
    return undefined;
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
export function applyChampionScore(
    stock: StockData,
    stats?: TickerStats
): {
    score: number;
    action: ActionLabel;
    stage: BreakoutStage | undefined;
} {
    const score = computeChampionScore(stock);
    const stage = computeBreakoutStage(stock);
    const plan = computeTradePlan(stock);
    const action = determineAction(stock, score, stage, plan, stats);

    stock.championScore = score;
    stock.breakoutStage = stage;
    stock.tradePlan = plan;
    stock.action = action;

    return { score, action, stage };
}

/**
 * Gold-tier alert gate — the highest-conviction combination found by the
 * 4-year production replay (1,008 td, 2022-07→2026-07, 42,131 flags,
 * metric: touch +10% within 21 td):
 *
 *   action BUY/WATCH  AND  momentum level full/recovery  AND  lowRiskEntry FAILED
 *
 * Per-fold win rate 41% / 36% / 57% / 65% (bear→bull) vs 20-42% for plain
 * BUY/WATCH — the lift holds in EVERY yearly fold, ~5 alerts/week.
 * `!lowRiskEntry` is deliberate: price extended >8% from SMA21 = riding
 * strength; flags near SMA21 won only 10-22% (see setup.ts, TD-9).
 */
export function isGoldTierAlert(stock: StockData): boolean {
    const level = stock.momentum?.level;
    return (
        (stock.action === 'BUY' || stock.action === 'WATCH') &&
        (level === 'full' || level === 'recovery') &&
        stock.momentum?.criteria?.lowRiskEntry === false
    );
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
