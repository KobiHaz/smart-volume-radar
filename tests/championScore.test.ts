/**
 * Tests for the Champion Score layer.
 */
import {
    computeChampionScore,
    computeBreakoutStage,
    computeTradePlan,
    determineAction,
    applyChampionScore,
    isBBSqueeze,
} from '../src/utils/championScore';
import type { MomentumCriteria, MomentumResult, StockData } from '../src/types';

const makeCriteria = (over: Partial<MomentumCriteria> = {}): MomentumCriteria => ({
    rvolPass: false,
    stage2: false,
    lowRiskEntry: false,
    pivotBreakout: false,
    tightness: false,
    aboveGapAvwap: true,
    antsAccumulation: false,
    bigMoveToday: false,
    ...over,
});

const makeMomentum = (criteria: MomentumCriteria): MomentumResult => ({
    level: 'close',
    criteria,
    failures: [],
});

const makeStock = (over: Partial<StockData> = {}): StockData => ({
    ticker: 'TEST',
    currentVolume: 1,
    avgVolume: 1,
    rvol: 2.0,
    priceChange: 0,
    lastPrice: 100,
    sma21: 95,
    sma50: 90,
    sma200: 80,
    ath: 100,
    pctFromAth: 0,
    daysSinceAth: 0,
    marketRegime: 'bull',
    ...over,
});

describe('computeChampionScore', () => {
    it('returns 50 baseline when momentum criteria missing', () => {
        const stock = makeStock();
        expect(computeChampionScore(stock)).toBe(50);
    });

    it('rewards stable predictors heavily (pivotBreakout + stage2 = +40)', () => {
        const stock = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true, stage2: true })),
        });
        const score = computeChampionScore(stock);
        // 50 base + 25 pivot + 15 stage2 + 5 aboveGapAvwap = 95
        expect(score).toBe(95);
    });

    it('penalizes lowRiskEntry in bull (anti-predictor in our 86-day analysis)', () => {
        const stock = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true, lowRiskEntry: true })),
        });
        const noPenalty = computeChampionScore(makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
        }));
        const withPenalty = computeChampionScore(stock);
        expect(withPenalty).toBeLessThan(noPenalty);
    });

    it('hard-penalizes price below SMA200 (-15)', () => {
        const stock = makeStock({
            lastPrice: 70,
            sma200: 80,
            momentum: makeMomentum(makeCriteria({ stage2: false })),
        });
        // 50 base + 5 aboveGapAvwap - 15 belowSma200 = 40
        expect(computeChampionScore(stock)).toBe(40);
    });

    it('caps score at 100', () => {
        const stock = makeStock({
            rvol: 10,
            momentum: makeMomentum(
                makeCriteria({
                    pivotBreakout: true,
                    stage2: true,
                    rvolPass: true,
                    antsAccumulation: true,
                    bigMoveToday: true,
                })
            ),
        });
        expect(computeChampionScore(stock)).toBeLessThanOrEqual(100);
    });

    it('caps score at 0', () => {
        const stock = makeStock({
            lastPrice: 50,
            sma200: 80,
            momentum: makeMomentum(
                makeCriteria({ aboveGapAvwap: false, lowRiskEntry: true })
            ),
        });
        expect(computeChampionScore(stock)).toBeGreaterThanOrEqual(0);
    });
});

describe('computeBreakoutStage', () => {
    it('Breaking Out: at ATH today (daysSinceAth=0)', () => {
        const stock = makeStock({ lastPrice: 100, ath: 100, daysSinceAth: 0 });
        expect(computeBreakoutStage(stock)).toBe('Breaking Out');
    });

    it('Fresh: 2 days since ATH, still near pivot', () => {
        const stock = makeStock({ lastPrice: 99, ath: 100, daysSinceAth: 2 });
        expect(computeBreakoutStage(stock)).toBe('Fresh');
    });

    it('Aging: 7 days since ATH', () => {
        const stock = makeStock({ lastPrice: 96, ath: 100, daysSinceAth: 7 });
        expect(computeBreakoutStage(stock)).toBe('Aging');
    });

    it('Pre-Pivot: in tight base, close to ATH', () => {
        const stock = makeStock({ lastPrice: 92, ath: 100, daysSinceAth: 30 });
        expect(computeBreakoutStage(stock)).toBe('Pre-Pivot');
    });

    it('Setup: deeper in base', () => {
        const stock = makeStock({ lastPrice: 87, ath: 100, daysSinceAth: 30 });
        expect(computeBreakoutStage(stock)).toBe('Setup');
    });

    it('Failed: significantly below pivot', () => {
        const stock = makeStock({ lastPrice: 75, ath: 100, daysSinceAth: 30 });
        expect(computeBreakoutStage(stock)).toBe('Failed');
    });

    it('returns undefined when ATH missing', () => {
        const stock = makeStock({ ath: undefined });
        expect(computeBreakoutStage(stock)).toBeUndefined();
    });
});

describe('computeTradePlan', () => {
    it('builds zone, stop, and risk from ATH and SMA21', () => {
        const stock = makeStock({ lastPrice: 100, ath: 100, sma21: 90 });
        const plan = computeTradePlan(stock);
        expect(plan).toBeDefined();
        expect(plan!.pivot).toBe(100);
        expect(plan!.buyZoneLow).toBeCloseTo(98, 2);
        expect(plan!.buyZoneHigh).toBeCloseTo(102, 2);
        expect(plan!.stopLoss).toBeCloseTo(85.5, 2);
        expect(plan!.riskPct).toBeCloseTo(-14.5, 1);
    });

    it('extension is 0 when not above pivot', () => {
        const stock = makeStock({ lastPrice: 95, ath: 100 });
        const plan = computeTradePlan(stock);
        expect(plan!.extensionPct).toBe(0);
        expect(plan!.distanceToEntryPct).toBeCloseTo(5, 1);
    });

    it('extension is positive when above pivot', () => {
        const stock = makeStock({ lastPrice: 110, ath: 100 });
        const plan = computeTradePlan(stock);
        expect(plan!.extensionPct).toBeCloseTo(10, 1);
        expect(plan!.distanceToEntryPct).toBeLessThan(0);
    });

    it('returns undefined when ATH missing', () => {
        const stock = makeStock({ ath: undefined });
        expect(computeTradePlan(stock)).toBeUndefined();
    });
});

describe('determineAction', () => {
    it('PASS when score < 40', () => {
        const stock = makeStock();
        const plan = computeTradePlan(stock);
        expect(determineAction(stock, 35, 'Setup', plan)).toBe('PASS');
    });

    it('PASS_TOO_LATE when extension > 10%', () => {
        const stock = makeStock({ lastPrice: 115, ath: 100 });
        const plan = computeTradePlan(stock);
        expect(determineAction(stock, 80, 'Aging', plan)).toBe('PASS_TOO_LATE');
    });

    it('CAUTION_EXTENDED when extension 5-10%', () => {
        const stock = makeStock({ lastPrice: 107, ath: 100 });
        const plan = computeTradePlan(stock);
        expect(determineAction(stock, 80, 'Aging', plan)).toBe('CAUTION_EXTENDED');
    });

    it('BUY when Breaking Out + rvolPass', () => {
        const stock = makeStock({ lastPrice: 100, ath: 100, rvol: 2.5 });
        const plan = computeTradePlan(stock);
        expect(determineAction(stock, 80, 'Breaking Out', plan)).toBe('BUY');
    });

    it('CAUTION_NO_VOL when Breaking Out without rvolPass', () => {
        const stock = makeStock({ lastPrice: 100, ath: 100, rvol: 1.5 });
        const plan = computeTradePlan(stock);
        expect(determineAction(stock, 80, 'Breaking Out', plan)).toBe('CAUTION_NO_VOL');
    });

    it('WATCH when Pre-Pivot with score >= 60', () => {
        const stock = makeStock({ lastPrice: 92, ath: 100 });
        const plan = computeTradePlan(stock);
        expect(determineAction(stock, 65, 'Pre-Pivot', plan)).toBe('WATCH');
    });

    it('PASS when Failed regardless of score', () => {
        const stock = makeStock({ lastPrice: 75, ath: 100 });
        const plan = computeTradePlan(stock);
        expect(determineAction(stock, 90, 'Failed', plan)).toBe('PASS');
    });

    it('regime affects rvolPass threshold (bear needs RVOL ≥ 3)', () => {
        const stock = makeStock({
            lastPrice: 100,
            ath: 100,
            rvol: 2.5,
            marketRegime: 'bear',
        });
        const plan = computeTradePlan(stock);
        // bear threshold is 3.0, so rvol 2.5 fails
        expect(determineAction(stock, 80, 'Breaking Out', plan)).toBe('CAUTION_NO_VOL');
    });
});

describe('Phase 2 score contributors', () => {
    it('+5 for accumulationDays >= 3', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            accumulationDays: 0,
        });
        const withAcc = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            accumulationDays: 4,
        });
        expect(computeChampionScore(withAcc) - computeChampionScore(base)).toBe(5);
    });

    it('-10 for distributionDays >= 3', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            distributionDays: 0,
        });
        const withDist = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            distributionDays: 4,
        });
        expect(computeChampionScore(withDist) - computeChampionScore(base)).toBe(-10);
    });

    it('+5 for rsPercentile >= 80', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            rsPercentile: 50,
        });
        const topRS = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            rsPercentile: 88,
        });
        expect(computeChampionScore(topRS) - computeChampionScore(base)).toBe(5);
    });

    it('+3 for BB squeeze (band-width / price < 5%)', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            lastPrice: 100,
            bbUpper: 110,
            bbLower: 90, // width = 20, 20% — no squeeze
        });
        const squeezed = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            lastPrice: 100,
            bbUpper: 102,
            bbLower: 98, // width = 4, 4% — squeeze
        });
        expect(computeChampionScore(squeezed) - computeChampionScore(base)).toBe(3);
    });
});

describe('isBBSqueeze', () => {
    it('returns true when band width < 5% of price', () => {
        const stock = makeStock({ lastPrice: 100, bbUpper: 102, bbLower: 99 });
        expect(isBBSqueeze(stock)).toBe(true);
    });

    it('returns false when bands missing', () => {
        const stock = makeStock({ bbUpper: undefined });
        expect(isBBSqueeze(stock)).toBe(false);
    });

    it('returns false when band width >= 5%', () => {
        const stock = makeStock({ lastPrice: 100, bbUpper: 110, bbLower: 95 });
        expect(isBBSqueeze(stock)).toBe(false);
    });
});

describe('Phase 3 score contributors (fundamentals)', () => {
    it('+5 for epsAcceleration === "accelerating"', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
        });
        const accelerating = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            epsAcceleration: 'accelerating',
        });
        expect(computeChampionScore(accelerating) - computeChampionScore(base)).toBe(5);
    });

    it('-5 for epsAcceleration === "decelerating"', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
        });
        const decelerating = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            epsAcceleration: 'decelerating',
        });
        expect(computeChampionScore(decelerating) - computeChampionScore(base)).toBe(-5);
    });

    it('+3 for revAcceleration === "accelerating"', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
        });
        const accel = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            revAcceleration: 'accelerating',
        });
        expect(computeChampionScore(accel) - computeChampionScore(base)).toBe(3);
    });

    it('flat acceleration contributes 0', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
        });
        const flat = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            epsAcceleration: 'flat',
            revAcceleration: 'flat',
        });
        expect(computeChampionScore(flat)).toBe(computeChampionScore(base));
    });

    it('combined: EPS acc + Rev acc adds +8', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
        });
        const both = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            epsAcceleration: 'accelerating',
            revAcceleration: 'accelerating',
        });
        expect(computeChampionScore(both) - computeChampionScore(base)).toBe(8);
    });
});

describe('Phase 4B sector-rank bonus', () => {
    it('+5 when sectorRank ≤ 3 AND sectorTotalCount ≥ 5', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
        });
        const topSector = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            sectorRank: 1,
            sectorTotalCount: 12,
        });
        expect(computeChampionScore(topSector) - computeChampionScore(base)).toBe(5);
    });

    it('does not apply when sectorRank > 3 (rank 4+)', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
        });
        const midSector = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            sectorRank: 4,
            sectorTotalCount: 12,
        });
        expect(computeChampionScore(midSector)).toBe(computeChampionScore(base));
    });

    it('does not apply when sector has < 5 stocks (anti-gaming)', () => {
        const base = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
        });
        const tinySector = makeStock({
            momentum: makeMomentum(makeCriteria({ pivotBreakout: true })),
            sectorRank: 1,
            sectorTotalCount: 3,
        });
        expect(computeChampionScore(tinySector)).toBe(computeChampionScore(base));
    });
});

describe('CAUTION_DISTRIBUTION action', () => {
    it('overrides BUY when distributionDays >= 4', () => {
        const stock = makeStock({
            lastPrice: 100,
            ath: 100,
            rvol: 2.5,
            distributionDays: 5,
        });
        const plan = computeTradePlan(stock);
        // Without distribution would be BUY at Breaking Out
        expect(determineAction(stock, 80, 'Breaking Out', plan)).toBe('CAUTION_DISTRIBUTION');
    });

    it('does not fire when distributionDays = 3 (just below threshold)', () => {
        const stock = makeStock({
            lastPrice: 100,
            ath: 100,
            rvol: 2.5,
            distributionDays: 3,
        });
        const plan = computeTradePlan(stock);
        expect(determineAction(stock, 80, 'Breaking Out', plan)).toBe('BUY');
    });
});

describe('applyChampionScore (integration)', () => {
    it('mutates the stock with score, action, stage, and trade plan', () => {
        const stock = makeStock({
            lastPrice: 100,
            ath: 100,
            sma21: 95,
            daysSinceAth: 0,
            momentum: makeMomentum(
                makeCriteria({ pivotBreakout: true, stage2: true, rvolPass: true })
            ),
        });
        const result = applyChampionScore(stock);
        expect(stock.championScore).toBeGreaterThan(80);
        expect(stock.action).toBe('BUY');
        expect(stock.breakoutStage).toBe('Breaking Out');
        expect(stock.tradePlan).toBeDefined();
        expect(result.score).toBe(stock.championScore);
        expect(result.action).toBe(stock.action);
    });
});
