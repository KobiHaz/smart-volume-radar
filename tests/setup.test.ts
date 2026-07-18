/**
 * Momentum Setup brain — covers the 5 spec scenarios plus AVWAP/Ants/regime.
 */
import { evaluateMomentumSetup } from '../src/utils/setup.js';
import type { StockData } from '../src/types/index.js';

/** Build a StockData fixture with Intel-like Stage 2 momentum defaults. */
function intelLike(overrides: Partial<StockData> = {}): StockData {
    return {
        ticker: 'INTC',
        currentVolume: 30_000_000,
        avgVolume: 10_000_000,
        rvol: 3.0,
        priceChange: 4,
        lastPrice: 52,
        sma21: 50,
        sma50: 48,
        sma200: 40,
        sma200Slope: 'up',
        ath: 51.5,
        daysSinceAth: 22,
        consecutiveGreenDays: 5,
        gapDay: null,
        avwapFromGap: undefined,
        projectedRvol: 3.0,
        marketRegime: 'bull',
        return63d: 25, // momentumGate ✓ (>= 20%)
        ...overrides,
    };
}

describe('evaluateMomentumSetup — core scenarios', () => {
    it('Intel scenario → FULL (clean entry, no extended-entry flag)', () => {
        const r = evaluateMomentumSetup(intelLike());
        expect(r.level).toBe('full');
        // All four mandatory + at least lowRiskEntry & tightness quality markers ✓
        expect(r.criteria.rvolPass).toBe(true);
        expect(r.criteria.stage2).toBe(true);
        expect(r.criteria.lowRiskEntry).toBe(true);
        expect(r.criteria.pivotBreakout).toBe(true);
        expect(r.criteria.tightness).toBe(true);
        // Pristine entry → no extended-entry flag.
        expect(r.highConvictionBypass).toBeUndefined();
    });

    it('Overextended from a real base → FULL with extended-entry flag', () => {
        // Price 15% above SMA21 (chase) but daysSinceAth=22 → tightness ✓ provides
        // the quality marker. New design: Full granted, but extended-entry flag set.
        const r = evaluateMomentumSetup(
            intelLike({ lastPrice: 57.5, sma21: 50, rvol: 2.5, projectedRvol: 2.5 })
        );
        expect(r.level).toBe('full');
        expect(r.highConvictionBypass).toBe(true); // entry not pristine
        expect(r.failures).toContain('lowRiskEntry'); // failure still recorded
    });

    it('Overextended AND no quality marker (no base, no Ants, no big move, RVOL<3) → CLOSE', () => {
        const r = evaluateMomentumSetup(
            intelLike({
                lastPrice: 57.5,
                sma21: 50,
                rvol: 2.5,
                projectedRvol: 2.5,
                daysSinceAth: 1, // tightness fails
                consecutiveGreenDays: 0, // ants fails
                priceChange: 1, // bigMoveToday fails (<3%)
            })
        );
        expect(r.level).toBe('close');
        expect(r.failures).toContain('lowRiskEntry');
        expect(r.failures).toContain('tightness');
        expect(r.failures).toContain('bigMoveToday');
    });

    it('lowRiskEntry alone no longer grants Close (removed 2026-07-17, 4y replay Δ≈−26pp)', () => {
        // Near SMA21 (lowRiskEntry ✓) but far from the 52w high (pivotBreakout ✗):
        // under the pre-2026-07-17 gate `pivot || lowRisk` this was 'close';
        // now only pivotBreakout promotes.
        const r = evaluateMomentumSetup(
            intelLike({
                lastPrice: 45,
                sma21: 44, // ~2.3% away → lowRiskEntry ✓
                ath: 60, // 45 < 60*0.98 → pivotBreakout ✗
                rvol: 2.0,
                projectedRvol: 2.0,
            })
        );
        expect(r.criteria.lowRiskEntry).toBe(true);
        expect(r.criteria.pivotBreakout).toBe(false);
        expect(r.level).toBe('none');
    });

    it('Fake breakout (RVOL 0.8) → NONE, rvolPass fails', () => {
        const r = evaluateMomentumSetup(
            intelLike({ rvol: 0.8, projectedRvol: 0.8 })
        );
        expect(r.level).toBe('none');
        expect(r.failures).toContain('rvolPass');
    });
});

describe('evaluateMomentumSetup — regime', () => {
    it('Bear regime tightens RVOL threshold to 3.0 (2.5 → not Full)', () => {
        const r = evaluateMomentumSetup(
            intelLike({ rvol: 2.5, projectedRvol: 2.5, marketRegime: 'bear' })
        );
        expect(r.rvolThreshold).toBe(3.0);
        expect(r.level).not.toBe('full');
        expect(r.failures).toContain('rvolPass');
    });

    it('Same setup in bull regime → Full (threshold 2.0)', () => {
        const r = evaluateMomentumSetup(
            intelLike({ rvol: 2.5, projectedRvol: 2.5, marketRegime: 'bull' })
        );
        expect(r.rvolThreshold).toBe(2.0);
        expect(r.level).toBe('full');
    });

    it('Regime from opts overrides stock.marketRegime', () => {
        const r = evaluateMomentumSetup(
            intelLike({ marketRegime: 'bear' }),
            { regime: 'bull' }
        );
        expect(r.rvolThreshold).toBe(2.0);
    });
});

describe('evaluateMomentumSetup — Ants', () => {
    it('13/15 green days + RVOL ≥ 1.2 sets antsAccumulation, independent of Full', () => {
        const r = evaluateMomentumSetup(
            intelLike({
                consecutiveGreenDays: 13,
                rvol: 1.3,
                projectedRvol: 1.3,
                ath: 100, // far from breakout
                lastPrice: 80,
            })
        );
        expect(r.criteria.antsAccumulation).toBe(true);
        expect(r.level).not.toBe('full'); // pivot fails
    });

    it('Ants requires both ≥12 green days AND RVOL ≥ 1.2', () => {
        const r = evaluateMomentumSetup(
            intelLike({ consecutiveGreenDays: 13, rvol: 1.0, projectedRvol: 1.0 })
        );
        expect(r.criteria.antsAccumulation).toBe(false);
    });
});

describe('evaluateMomentumSetup — AVWAP guard', () => {
    it('No gap day → aboveGapAvwap is true (guard does not block)', () => {
        const r = evaluateMomentumSetup(intelLike({ gapDay: null }));
        expect(r.criteria.aboveGapAvwap).toBe(true);
        expect(r.level).toBe('full');
    });

    it('Gap day + price below anchored AVWAP → aboveGapAvwap fails, blocks Full', () => {
        const r = evaluateMomentumSetup(
            intelLike({
                lastPrice: 45,
                ath: 51.5,
                sma21: 47, // adjust so lowRiskEntry stays true
                sma50: 44,
                gapDay: { date: '2024-08-01', level: 50, barsAgo: 20 },
                avwapFromGap: 48,
            })
        );
        expect(r.criteria.aboveGapAvwap).toBe(false);
        expect(r.failures).toContain('aboveGapAvwap');
        expect(r.level).not.toBe('full');
    });

    it('Fresh gap (barsAgo < 3) → guard auto-satisfied (AVWAP not yet meaningful)', () => {
        // Sep 18 INTC pattern: gap is TODAY, AVWAP collapses to typical price = noise.
        const r = evaluateMomentumSetup(
            intelLike({
                lastPrice: 30.57,
                ath: 30.57,
                sma21: 30,
                sma50: 26,
                sma200: 22,
                gapDay: { date: '2025-09-18', level: 25, barsAgo: 0 },
                avwapFromGap: 31.04, // higher than close — would have failed without the freshness skip
            })
        );
        expect(r.criteria.aboveGapAvwap).toBe(true);
    });

    it('Gap day + price ABOVE anchored AVWAP → guard satisfied', () => {
        const r = evaluateMomentumSetup(
            intelLike({
                gapDay: { date: '2024-08-01', level: 50, barsAgo: 20 },
                avwapFromGap: 49,
                lastPrice: 52,
            })
        );
        expect(r.criteria.aboveGapAvwap).toBe(true);
        expect(r.level).toBe('full');
    });
});

describe('evaluateMomentumSetup — Stage 2 nuances', () => {
    it('SMA200 sloping down → stage2 fails', () => {
        const r = evaluateMomentumSetup(intelLike({ sma200Slope: 'down' }));
        expect(r.criteria.stage2).toBe(false);
        expect(r.failures).toContain('stage2');
    });

    it('SMA50 < SMA200 → stage2 fails', () => {
        const r = evaluateMomentumSetup(
            intelLike({ sma50: 35, sma200: 40 })
        );
        expect(r.criteria.stage2).toBe(false);
    });

    it('Tightness fails when daysSinceAth < 15', () => {
        const r = evaluateMomentumSetup(intelLike({ daysSinceAth: 5 }));
        expect(r.criteria.tightness).toBe(false);
        expect(r.failures).toContain('tightness');
    });
});

describe('evaluateMomentumSetup — Recovery Rally tier', () => {
    it('Bear market bounce reclaiming SMA50 → RECOVERY (not Full, not Close)', () => {
        // WOLF/NBIS pattern: SMA200 still down (Stage 2 ✗) but price > SMA50 with rising slope,
        // pivotBreakout ✓ on RVOL ≥ 2.5 → Recovery Rally fires.
        const r = evaluateMomentumSetup(
            intelLike({
                rvol: 3.35,
                projectedRvol: 3.35,
                lastPrice: 36.76,
                sma21: 25,
                sma50: 24,
                sma50Slope: 'up',
                sma200: 30, // sma50 < sma200 → stage2 fails
                sma200Slope: 'down',
                ath: 36.76,
                daysSinceAth: 1,
                consecutiveGreenDays: 5,
                priceChange: 24, // big breakout day
            })
        );
        expect(r.level).toBe('recovery');
        expect(r.criteria.stage2).toBe(false); // Stage 2 broken — wouldn't be Full
    });

    it('Recovery requires RVOL ≥ 2.5 (RVOL 2.0 → Close, not Recovery)', () => {
        // Non-Stage-2, but momentumGate ✓ + pivot ✓ + rvol ≥ 1.5 → still qualifies
        // as Close (the ARM/ALAB/MU pattern the Close tier deliberately keeps).
        const r = evaluateMomentumSetup(
            intelLike({
                rvol: 2.0,
                projectedRvol: 2.0,
                lastPrice: 36,
                sma21: 25,
                sma50: 24,
                sma50Slope: 'up',
                sma200: 30,
                sma200Slope: 'down',
                ath: 36,
                daysSinceAth: 1,
                consecutiveGreenDays: 5,
                priceChange: 8,
            })
        );
        expect(r.level).toBe('close');
    });

    it('Recovery requires SMA50 sloping up (flat/down → Close)', () => {
        const r = evaluateMomentumSetup(
            intelLike({
                rvol: 3.5,
                projectedRvol: 3.5,
                lastPrice: 36,
                sma21: 25,
                sma50: 24,
                sma50Slope: 'flat', // not yet turning
                sma200: 30,
                sma200Slope: 'down',
                ath: 36,
                daysSinceAth: 1,
                consecutiveGreenDays: 5,
                priceChange: 8,
            })
        );
        expect(r.level).toBe('close'); // momentumGate ✓ + pivot ✓ keeps it in Close
    });

    it('Recovery does NOT downgrade Full (Stage 2 stock with high RVOL stays Full)', () => {
        // Even with sma50Slope='up', if Stage 2 already passes, level stays 'full'.
        const r = evaluateMomentumSetup(intelLike({ sma50Slope: 'up' }));
        expect(r.level).toBe('full');
    });
});

describe('evaluateMomentumSetup — projectedRvol fallback', () => {
    it('Falls back to raw rvol when projectedRvol missing', () => {
        const stock = intelLike({ projectedRvol: undefined });
        const r = evaluateMomentumSetup(stock);
        expect(r.level).toBe('full'); // raw rvol = 3.0 still passes
    });
});

describe('evaluateMomentumSetup — high-conviction bypass (Option B)', () => {
    it('Hot pivot break (RVOL≥3 + pivot + Stage 2) bypasses lowRiskEntry → FULL', () => {
        // INTC Sep 18 pattern: explosive breakout, price 23% above SMA21, RVOL 5.4.
        // Use scaled-down SMA50/SMA200 so Stage 2 still holds at the new price level.
        const r = evaluateMomentumSetup(
            intelLike({
                rvol: 5.4,
                projectedRvol: 5.4,
                lastPrice: 30.57,
                sma21: 24.78, // 23% below price → lowRiskEntry would normally fail
                sma50: 26,
                sma200: 22,
                ath: 30.57,
                daysSinceAth: 146, // pre-existing prior cycle high
            })
        );
        expect(r.level).toBe('full');
        expect(r.highConvictionBypass).toBe(true);
        // failures still records lowRiskEntry (criterion was false) but it's informational only —
        // Full was granted via tightness quality marker.
        expect(r.criteria.lowRiskEntry).toBe(false);
        expect(r.criteria.tightness).toBe(true);
        expect(r.failures).toContain('lowRiskEntry');
    });

    it('RVOL below 3 + extended entry, BUT real base → FULL via tightness quality marker', () => {
        // New design: tightness ✓ alone is enough quality, regardless of RVOL.
        // The "RVOL must be ≥3 to bypass" rule is gone — replaced by 1-of-N quality OR.
        const r = evaluateMomentumSetup(
            intelLike({
                rvol: 2.5,
                projectedRvol: 2.5,
                lastPrice: 30,
                sma21: 24,
                sma50: 26,
                sma200: 22,
                ath: 30,
                daysSinceAth: 146, // tightness ✓ satisfies quality
            })
        );
        expect(r.level).toBe('full');
        expect(r.highConvictionBypass).toBe(true); // lowRiskEntry failed but Full granted
    });

    it('Continuation breakout +5% on RVOL 2 → FULL via bigMoveToday quality marker', () => {
        // INTC Apr 27/29/May 1 pattern: continuation breakout at new ATH, RVOL modest
        // (1.5-2.5), no base, but strong daily move ≥3% — captured via bigMoveToday.
        const r = evaluateMomentumSetup(
            intelLike({
                rvol: 2.0,
                projectedRvol: 2.0,
                lastPrice: 99,
                sma21: 70, // 41% above (lowRiskEntry fails)
                sma50: 60,
                sma200: 45,
                ath: 99,
                daysSinceAth: 1, // continuous uptrend, no base (tightness fails)
                consecutiveGreenDays: 5, // not Ants
                priceChange: 5, // +5% today → bigMoveToday ✓
            })
        );
        expect(r.level).toBe('full');
        expect(r.criteria.bigMoveToday).toBe(true);
        expect(r.highConvictionBypass).toBe(true);
    });

    it('Continuation but flat day (priceChange <3%) → CLOSE', () => {
        const r = evaluateMomentumSetup(
            intelLike({
                rvol: 2.0,
                projectedRvol: 2.0,
                lastPrice: 99,
                sma21: 70,
                sma50: 60,
                sma200: 45,
                ath: 99,
                daysSinceAth: 1,
                consecutiveGreenDays: 5,
                priceChange: 1.5, // +1.5% — not enough for bigMoveToday
            })
        );
        expect(r.level).toBe('close');
        expect(r.criteria.bigMoveToday).toBe(false);
    });

    it('Continuation breakout (no base, RVOL≥3) → FULL via high-RVOL quality marker', () => {
        // INTC 29.4.26 / MXL 24.4.26 pattern: continuous new highs (no base),
        // extended from SMA21, but RVOL ≥ 3 alone provides quality confirmation.
        const r = evaluateMomentumSetup(
            intelLike({
                rvol: 4.0,
                projectedRvol: 4.0,
                lastPrice: 99,
                sma21: 70, // 41% above
                sma50: 60,
                sma200: 45,
                ath: 99,
                daysSinceAth: 1, // continuous uptrend, no base
                consecutiveGreenDays: 5, // not Ants
            })
        );
        expect(r.level).toBe('full');
        expect(r.highConvictionBypass).toBe(true);
    });

    it('Bypass does NOT apply when MULTIPLE criteria fail (still NOT full)', () => {
        // High RVOL but ALSO Stage 2 broken — bypass should not paper over the trend break.
        const r = evaluateMomentumSetup(
            intelLike({
                rvol: 5.0,
                projectedRvol: 5.0,
                lastPrice: 30,
                sma21: 24,
                sma200Slope: 'down', // breaks stage2
                ath: 30,
                daysSinceAth: 146,
            })
        );
        expect(r.level).not.toBe('full');
        expect(r.highConvictionBypass).toBeUndefined();
        expect(r.failures).toContain('stage2');
        expect(r.failures).toContain('lowRiskEntry');
    });

    it('Bypass does NOT apply when pivotBreakout fails (only Watchlist)', () => {
        // Hot RVOL but not at ATH yet — bypass requires the pivot break to fire.
        const r = evaluateMomentumSetup(
            intelLike({
                rvol: 5.0,
                projectedRvol: 5.0,
                lastPrice: 25,
                sma21: 20,
                ath: 30,
                daysSinceAth: 146,
            })
        );
        expect(r.level).not.toBe('full');
        expect(r.highConvictionBypass).toBeUndefined();
    });
});

describe('evaluateMomentumSetup — momentum gate (2026-07-09, 1y replay)', () => {
    it('return63d below 20% blocks Full even when all other criteria pass', () => {
        const r = evaluateMomentumSetup(intelLike({ return63d: 12 }));
        expect(r.criteria.momentumGate).toBe(false);
        expect(r.level).not.toBe('full');
        expect(r.failures).toContain('momentumGate');
    });

    it('return63d below 20% blocks Close too (drops to NONE)', () => {
        // Full-shaped stock, weak 3-month momentum → neither Full nor Close.
        const r = evaluateMomentumSetup(
            intelLike({ return63d: 5, rvol: 2.0, projectedRvol: 2.0 })
        );
        expect(r.level).toBe('none');
    });

    it('Missing return63d (short history, e.g. recent IPO) fails the gate', () => {
        const r = evaluateMomentumSetup(intelLike({ return63d: undefined }));
        expect(r.criteria.momentumGate).toBe(false);
        expect(r.level).not.toBe('full');
    });

    it('return63d exactly 20% passes the gate', () => {
        const r = evaluateMomentumSetup(intelLike({ return63d: 20 }));
        expect(r.criteria.momentumGate).toBe(true);
        expect(r.level).toBe('full');
    });

    it('Momentum gate does NOT block the Recovery tier', () => {
        // Recovery evaluates bear-market reversals where 63d return is often still weak.
        const r = evaluateMomentumSetup(
            intelLike({
                return63d: 10,
                rvol: 3.35,
                projectedRvol: 3.35,
                lastPrice: 36.76,
                sma21: 25,
                sma50: 24,
                sma50Slope: 'up',
                sma200: 30,
                sma200Slope: 'down',
                ath: 36.76,
                daysSinceAth: 1,
                priceChange: 24,
            })
        );
        expect(r.level).toBe('recovery');
    });
});

describe('evaluateMomentumSetup — pivot stays at 2% (0.99 tightening reverted 2026-07-09)', () => {
    it('Price 1.5% below ATH still counts as pivot breakout (UCTT/SNDK band kept)', () => {
        const r = evaluateMomentumSetup(intelLike({ lastPrice: 98.5, ath: 100, sma21: 95 }));
        expect(r.criteria.pivotBreakout).toBe(true);
        expect(r.level).toBe('full');
    });

    it('Price 2.5% below ATH fails the pivot', () => {
        const r = evaluateMomentumSetup(intelLike({ lastPrice: 97.5, ath: 100, sma21: 95 }));
        expect(r.criteria.pivotBreakout).toBe(false);
        expect(r.level).not.toBe('full');
    });
});

describe('evaluateMomentumSetup — Close keeps high-momentum non-Stage-2 breaks (ARM/ALAB/MU)', () => {
    it('momentumGate ✓ + pivot ✓ + rvol 2.0 but Stage 2 broken → CLOSE (not none)', () => {
        // ARM 2026-04-22 pattern: +52% in 21d after firing at rvol 2.0 with SMA200
        // structure still lagging. Stage 2 is NOT required for Close.
        const r = evaluateMomentumSetup(
            intelLike({
                rvol: 2.0,
                projectedRvol: 2.0,
                return63d: 45,
                lastPrice: 36,
                sma21: 33,
                sma50: 30,
                sma200: 34, // sma50 < sma200 → stage2 fails
                sma200Slope: 'down',
                ath: 36,
                daysSinceAth: 3,
                priceChange: 2,
            })
        );
        expect(r.criteria.stage2).toBe(false);
        expect(r.level).toBe('close');
    });
});
