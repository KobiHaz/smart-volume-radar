/**
 * Tests for the acceleration logic — pure & synchronous, no API.
 * The fetch functions in finnhubFundamentals.ts are integration-tested in production.
 */
import { computeAcceleration } from '../src/utils/acceleration';

describe('computeAcceleration', () => {
    // Helper: build quarterly series newest-first.
    const series = (values: number[]): Array<{ actual: number | null }> =>
        values.map((v) => ({ actual: v }));

    it('returns null when fewer than 5 quarters', () => {
        expect(computeAcceleration(series([10, 9, 8, 7]))).toBeNull();
        expect(computeAcceleration([])).toBeNull();
    });

    it('accelerating: latest YoY growth >> prior YoY growth', () => {
        // Q[0]=20, Q[4]=10 → +100% YoY
        // Q[1]=11, Q[5]=10 → +10% YoY
        // delta = +90% → accelerating
        const r = computeAcceleration(series([20, 11, 10, 10, 10, 10]));
        expect(r).toBe('accelerating');
    });

    it('decelerating: latest YoY growth far below prior', () => {
        // Q[0]=11, Q[4]=10 → +10% YoY
        // Q[1]=20, Q[5]=10 → +100% YoY
        // delta = -90% → decelerating
        const r = computeAcceleration(series([11, 20, 15, 12, 10, 10]));
        expect(r).toBe('decelerating');
    });

    it('flat: deltas within ±5%', () => {
        // Both YoY = +20%, ish
        const r = computeAcceleration(series([12, 12, 11, 11, 10, 10]));
        expect(r).toBe('flat');
    });

    it('falls back to QoQ when 6th quarter missing', () => {
        // Only 5 quarters: latest=20, yearAgo=10 (yoy=100%); fallback prior = QoQ Q[1] vs Q[2]
        // Q[1]=11, Q[2]=10 → +10%. delta = +90% → accelerating
        const r = computeAcceleration(series([20, 11, 10, 10, 10]));
        expect(r).toBe('accelerating');
    });

    it('returns null when key denominators are zero', () => {
        // yearAgo (Q[4]) = 0 → undefined denominator
        const r = computeAcceleration(series([10, 5, 5, 5, 0, 5]));
        expect(r).toBeNull();
    });

    it('handles negative values via abs() in denominator', () => {
        // Q[0] = +5, Q[4] = -10 → (5-(-10))/|-10| = +1.5
        // Q[1] = -8, Q[5] = -10 → (-8-(-10))/|-10| = +0.2
        // delta = 1.3 → accelerating (recovery from loss)
        const r = computeAcceleration(series([5, -8, -9, -10, -10, -10]));
        expect(r).toBe('accelerating');
    });

    it('returns null when latest actual is null', () => {
        const r = computeAcceleration(series([0]).concat(series([10, 10, 10, 10, 10])).map((q, i) =>
            i === 0 ? { actual: null } : q
        ));
        expect(r).toBeNull();
    });
});
