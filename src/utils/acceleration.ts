/**
 * Smart Volume Radar — Pure Acceleration Logic (Phase 3, 2026-05-07).
 *
 * Compute the YoY-growth-rate trajectory from a series of quarterly values.
 * Pure & synchronous — no fs, no API. Extracted from `finnhubFundamentals.ts`
 * so Jest can import it without hitting `import.meta` / `__dirname` issues.
 */
import type { AccelerationTrend } from '../types/index.js';

/**
 * Compute the YoY-growth-rate trajectory from a series of quarterly values.
 * Caller passes quarterly values in MOST-RECENT-FIRST order (Finnhub default).
 *
 *   yoyGrowthLatest  = (Q[0].actual - Q[4].actual) / |Q[4].actual|
 *   yoyGrowthPrior   = (Q[1].actual - Q[5].actual) / |Q[5].actual|  (when Q[5] exists)
 *
 * If Q[5] missing, fall back to QoQ growth comparison Q[1] vs Q[2] for prior.
 *
 * 'accelerating' when latest - prior > +0.05 (5 percentage points)
 * 'decelerating' when latest - prior < -0.05
 * 'flat'         otherwise
 *
 * Returns null when:
 *   - fewer than 5 entries (need latest + 4 prior),
 *   - any required denominator is 0,
 *   - latest or yearAgo actual is null.
 */
export function computeAcceleration(
    quarterly: Array<{ actual: number | null }>
): AccelerationTrend | null {
    if (quarterly.length < 5) return null;
    const v = (i: number): number | null => quarterly[i]?.actual ?? null;

    const latest = v(0);
    const yearAgo = v(4);
    if (latest == null || yearAgo == null || yearAgo === 0) return null;
    const yoyLatest = (latest - yearAgo) / Math.abs(yearAgo);

    // Prefer Q[1] vs Q[5] for the prior YoY; fall back to QoQ if Q[5] missing.
    let yoyPrior: number;
    if (quarterly.length >= 6 && v(1) != null && v(5) != null && v(5) !== 0) {
        yoyPrior = (v(1)! - v(5)!) / Math.abs(v(5)!);
    } else if (v(1) != null && v(2) != null && v(2) !== 0) {
        yoyPrior = (v(1)! - v(2)!) / Math.abs(v(2)!);
    } else {
        return null;
    }

    const delta = yoyLatest - yoyPrior;
    if (delta > 0.05) return 'accelerating';
    if (delta < -0.05) return 'decelerating';
    return 'flat';
}
