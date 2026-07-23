/**
 * Pure statistics helpers for the Purple List fragility score.
 *
 * Iron rule: every helper returns `null` (never NaN) when the input is
 * insufficient, so downstream layers can filter on `!= null` uniformly.
 */

export function mean(xs: number[]): number | null {
    if (xs.length === 0) return null;
    let sum = 0;
    for (const x of xs) sum += x;
    return sum / xs.length;
}

/** Sample standard deviation (n−1). Null when fewer than 2 values. */
export function stdDev(xs: number[]): number | null {
    if (xs.length < 2) return null;
    const m = mean(xs)!;
    let sq = 0;
    for (const x of xs) sq += (x - m) * (x - m);
    return Math.sqrt(sq / (xs.length - 1));
}

/** Pearson correlation. Null on length mismatch, n<2, or zero variance in either series. */
export function pearson(a: number[], b: number[]): number | null {
    const n = a.length;
    if (n !== b.length || n < 2) return null;
    const ma = mean(a)!;
    const mb = mean(b)!;
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < n; i++) {
        const da = a[i]! - ma;
        const db = b[i]! - mb;
        cov += da * db;
        va += da * da;
        vb += db * db;
    }
    if (va < 1e-18 || vb < 1e-18) return null;
    return cov / Math.sqrt(va * vb);
}

/**
 * Rolling mean over a fixed window. Result[i] is null until the window is
 * full (i < window−1). Length-preserving.
 */
export function rollingMean(xs: number[], window: number): Array<number | null> {
    const out: Array<number | null> = new Array(xs.length).fill(null);
    if (window < 1 || xs.length < window) return out;
    let sum = 0;
    for (let i = 0; i < xs.length; i++) {
        sum += xs[i]!;
        if (i >= window) sum -= xs[i - window]!;
        if (i >= window - 1) out[i] = sum / window;
    }
    return out;
}

/**
 * Rolling sample standard deviation over a fixed window. Result[i] is null
 * until the window is full (i < window−1) or the window has near-zero
 * variance. Length-preserving. Pairs with rollingMean for a rolling z-score.
 */
export function rollingStd(xs: number[], window: number): Array<number | null> {
    const out: Array<number | null> = new Array(xs.length).fill(null);
    if (window < 2 || xs.length < window) return out;
    for (let i = window - 1; i < xs.length; i++) {
        out[i] = stdDev(xs.slice(i - window + 1, i + 1));
    }
    return out;
}

/**
 * Rolling max over a fixed trailing window (including the current day).
 * Result[i] is null until the window is full (i < window−1) or any value in
 * the window is null (matches rollingMean/rollingStd's require-the-whole-
 * window convention). Length-preserving.
 */
export function rollingMax(xs: Array<number | null>, window: number): Array<number | null> {
    const out: Array<number | null> = new Array(xs.length).fill(null);
    if (window < 1) return out;
    for (let i = window - 1; i < xs.length; i++) {
        const slice = xs.slice(i - window + 1, i + 1);
        if (slice.every((x): x is number => x != null)) out[i] = Math.max(...slice);
    }
    return out;
}

/**
 * Expanding-window z-scores with a one-day lag (no lookahead):
 *
 *   z[t] = (x[t] − mean(x[0..t−1])) / std(x[0..t−1])
 *
 * The expanding mean/std use only values strictly BEFORE t, so z[t] was
 * computable in real time on day t. Nulls in the input propagate (null in →
 * null out) and are excluded from the expanding statistics. z[t] is null
 * until at least `minPrior` non-null prior values exist, or when the prior
 * std is degenerate (< 1e-12).
 */
export function expandingZ(xs: Array<number | null>, minPrior = 60): Array<number | null> {
    const out: Array<number | null> = new Array(xs.length).fill(null);
    let count = 0;
    let sum = 0;
    let sumSq = 0;
    for (let t = 0; t < xs.length; t++) {
        const x = xs[t];
        if (x != null && count >= minPrior) {
            const m = sum / count;
            const variance = (sumSq - count * m * m) / (count - 1);
            const sd = variance > 0 ? Math.sqrt(variance) : 0;
            if (sd >= 1e-12) out[t] = (x - m) / sd;
        }
        if (x != null) {
            count++;
            sum += x;
            sumSq += x * x;
        }
    }
    return out;
}
