import { mean, stdDev, pearson, rollingMean, rollingMax, expandingZ } from '../src/utils/statistics.js';

describe('mean', () => {
    it('returns null on empty input', () => {
        expect(mean([])).toBeNull();
    });
    it('computes the arithmetic mean', () => {
        expect(mean([1, 2, 3, 4])).toBeCloseTo(2.5, 12);
    });
});

describe('stdDev', () => {
    it('returns null when fewer than 2 values', () => {
        expect(stdDev([])).toBeNull();
        expect(stdDev([5])).toBeNull();
    });
    it('computes the sample standard deviation (n-1)', () => {
        // [2,4,4,4,5,5,7,9]: mean 5, sum sq dev 32, sample var 32/7
        expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
    });
});

describe('pearson', () => {
    it('returns +1 for perfectly correlated series', () => {
        expect(pearson([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
    });
    it('returns -1 for perfectly anti-correlated series', () => {
        expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
    });
    it('returns null on zero variance', () => {
        expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    });
    it('returns null on length mismatch or n<2', () => {
        expect(pearson([1, 2], [1, 2, 3])).toBeNull();
        expect(pearson([1], [2])).toBeNull();
    });
});

describe('rollingMean', () => {
    it('is null until the window fills, then averages the window', () => {
        expect(rollingMean([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    });
    it('returns all nulls when the series is shorter than the window', () => {
        expect(rollingMean([1, 2], 3)).toEqual([null, null]);
    });
});

describe('rollingMax', () => {
    it('is null until the window fills, then takes the max of the window', () => {
        expect(rollingMax([3, 1, 4, 1, 5], 3)).toEqual([null, null, 4, 4, 5]);
    });
    it('returns all nulls when the series is shorter than the window', () => {
        expect(rollingMax([1, 2], 3)).toEqual([null, null]);
    });
    it('propagates null when any value in the window is null', () => {
        expect(rollingMax([1, null, 3], 2)).toEqual([null, null, null]);
        expect(rollingMax([1, 2, 3], 2)).toEqual([null, 2, 3]);
    });
});

describe('expandingZ', () => {
    it('is null during burn-in and matches hand computation after', () => {
        const xs = [1, 2, 3, 10];
        const z = expandingZ(xs, 3);
        expect(z[0]).toBeNull();
        expect(z[1]).toBeNull();
        expect(z[2]).toBeNull();
        // t=3: prior [1,2,3] → mean 2, sample std 1 → z = (10-2)/1 = 8
        expect(z[3]).toBeCloseTo(8, 12);
    });
    it('has no lookahead: z[t] is unchanged when x[t+1] is mutated', () => {
        const a = [1, 2, 3, 4, 5, 100];
        const b = [1, 2, 3, 4, 5, -100];
        const za = expandingZ(a, 3);
        const zb = expandingZ(b, 3);
        // All z's before the last index must be identical.
        expect(za.slice(0, 5)).toEqual(zb.slice(0, 5));
    });
    it('propagates input nulls and excludes them from expanding stats', () => {
        const z = expandingZ([1, null, 2, 3, 10], 3);
        expect(z[1]).toBeNull();
        // priors for t=4 are [1,2,3] (null excluded) → z = (10-2)/1 = 8
        expect(z[4]).toBeCloseTo(8, 12);
    });
    it('returns null when prior std is degenerate (all priors equal)', () => {
        const z = expandingZ([5, 5, 5, 5, 7], 3);
        expect(z[4]).toBeNull();
    });
});
