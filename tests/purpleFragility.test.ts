// Mock p-limit to avoid ESM import issues in Jest
jest.mock('p-limit', () => () => (fn: () => Promise<unknown>) => fn());

import {
    buildFragilityDays,
    computeFragilityFromSeries,
    FRAGILITY_THRESHOLD,
    MIN_TICKERS,
    type OhlcvSeries,
} from '../src/services/purpleFragility.js';

interface Bar {
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
}

function dateAt(t: number): string {
    const d = new Date(Date.UTC(2024, 0, 1));
    d.setUTCDate(d.getUTCDate() + t);
    return d.toISOString().slice(0, 10);
}

function makeSeries(ticker: string, T: number, bar: (t: number) => Bar): OhlcvSeries {
    const s: OhlcvSeries = { ticker, dates: [], open: [], high: [], low: [], close: [], volume: [] };
    for (let t = 0; t < T; t++) {
        const b = bar(t);
        s.dates.push(dateAt(t));
        s.open.push(b.o);
        s.high.push(b.h);
        s.low.push(b.l);
        s.close.push(b.c);
        s.volume.push(b.v);
    }
    return s;
}

/** Quiet, deterministic pseudo-noisy bars — every feature has small but real variance. */
function quietBar(t: number, phase: number): Bar {
    const c = 100 + 0.5 * Math.sin(t * 0.7 + phase);
    const prev = 100 + 0.5 * Math.sin((t - 1) * 0.7 + phase);
    const o = t === 0 ? c : prev;
    const hi = Math.max(o, c) + 0.2 + 0.1 * Math.sin(t * 1.3 + phase);
    const lo = Math.min(o, c) - 0.2;
    return { o, h: hi, l: lo, c, v: 1000 + Math.round(100 * Math.sin(t * 0.9 + phase)) };
}

describe('buildFragilityDays — raw aggregates', () => {
    it('computes the upper-wick ratio (constant bars o=10 h=12 l=8 c=10 → wick10 = 0.5)', () => {
        const mk = (name: string) => makeSeries(name, 80, () => ({ o: 10, h: 12, l: 8, c: 10, v: 1000 }));
        const built = buildFragilityDays([mk('A'), mk('B'), mk('C')])!;
        expect(built).not.toBeNull();
        const last = built.days[built.days.length - 1]!;
        // wick = (12 − max(10,10)) / (12 − 8) = 0.5, identical every day and ticker.
        expect(last.raw.wick10).toBeCloseTo(0.5, 12);
        // close == ma50 → not strictly above → 0; extension exactly 0.
        expect(last.raw.pctAbove50).toBe(0);
        expect(last.raw.ext50).toBeCloseTo(0, 12);
        // zero returns → no distribution days.
        expect(last.raw.dist20).toBe(0);
        // zero-variance return windows → all pairs excluded → corr null.
        expect(last.raw.corr20).toBeNull();
    });

    it('wick is 0 when high === low', () => {
        const mk = (name: string) => makeSeries(name, 80, () => ({ o: 10, h: 10, l: 10, c: 10, v: 1000 }));
        const built = buildFragilityDays([mk('A'), mk('B')])!;
        expect(built.days[built.days.length - 1]!.raw.wick10).toBe(0);
    });

    it('rising closes → pctAbove50 = 1 and positive ext50', () => {
        const mk = (name: string) =>
            makeSeries(name, 80, (t) => {
                const c = 100 + t;
                return { o: c, h: c + 1, l: c - 1, c, v: 1000 };
            });
        const built = buildFragilityDays([mk('A'), mk('B')])!;
        const last = built.days[built.days.length - 1]!;
        expect(last.raw.pctAbove50).toBe(1);
        expect(last.raw.ext50!).toBeGreaterThan(0);
    });

    it('counts distribution days: down >0.2% on above-average volume', () => {
        // Close 100 except a −1% drop every 10th day (t%10===5), recovered next day.
        // Drop days carry 5000 volume vs 1000 base → volume > 50d avg → counted.
        const mk = (name: string) =>
            makeSeries(name, 80, (t) => {
                const drop = t % 10 === 5;
                const c = drop ? 99 : 100;
                return { o: 100, h: 101, l: 98, c, v: drop ? 5000 : 1000 };
            });
        const built = buildFragilityDays([mk('A'), mk('B')])!;
        const last = built.days[built.days.length - 1]!;
        // Window t=60..79 contains drops at t=65 and t=75 → 2 per ticker.
        expect(last.raw.dist20).toBe(2);
    });

    it('aligns on the intersection of dates — a date missing in one series drops for all', () => {
        const a = makeSeries('A', 81, (t) => quietBar(t, 0));
        const b = makeSeries('B', 81, (t) => quietBar(t, 1));
        // Remove one mid-series date from B.
        const cut = 40;
        for (const key of ['dates', 'open', 'high', 'low', 'close', 'volume'] as const) {
            (b[key] as unknown[]).splice(cut, 1);
        }
        const built = buildFragilityDays([a, b])!;
        expect(built.days.length).toBe(80);
        expect(built.days.some((d) => d.date === dateAt(cut))).toBe(false);
    });

    it('returns null when aligned history is shorter than the feature warm-up', () => {
        const mk = (name: string) => makeSeries(name, 79, (t) => quietBar(t, 0));
        expect(buildFragilityDays([mk('A'), mk('B')])).toBeNull();
    });
});

describe('buildFragilityDays — canary', () => {
    it('counts tickers whose 250d high is >10 days old while the index is near its high', () => {
        // A and B peak at t=40 then drift −0.1%/day; C rises steadily and keeps
        // the equal-weight index within 2% of its running high.
        const decliner = (phase: number) => (t: number): Bar => {
            const c = t <= 40 ? 100 + t * 0.05 : (100 + 2) * Math.pow(0.999, t - 40);
            return { o: c, h: c + 0.5, l: c - 0.5, c, v: 1000 };
        };
        const riser = (t: number): Bar => {
            const c = 100 * Math.pow(1.005, t);
            return { o: c, h: c + 0.5, l: c - 0.5, c, v: 1000 };
        };
        const built = buildFragilityDays([
            makeSeries('A', 80, decliner(0)),
            makeSeries('B', 80, decliner(1)),
            makeSeries('C', 80, riser),
        ])!;
        const last = built.days[built.days.length - 1]!;
        expect(last.indexNearHigh).toBe(true);
        expect(last.canaryCount).toBe(2);
    });

    it('canary is null (not counted) when the index is >2% below its high', () => {
        // Everyone peaks at t=40 then falls hard — index far from high.
        const faller = (t: number): Bar => {
            const c = t <= 40 ? 100 + t : 140 * Math.pow(0.995, t - 40);
            return { o: c, h: c + 0.5, l: c - 0.5, c, v: 1000 };
        };
        const built = buildFragilityDays([
            makeSeries('A', 80, faller),
            makeSeries('B', 80, faller),
        ])!;
        const last = built.days[built.days.length - 1]!;
        expect(last.indexNearHigh).toBe(false);
        expect(last.canaryCount).toBeNull();
    });
});

describe('computeFragilityFromSeries — score and crossing', () => {
    const T = 140;

    /** Blow-off bar: big up move with a huge upper wick on huge volume —
     *  magnitudes differ per ticker so cross-sectional dispersion explodes. */
    function blowOffBar(prevClose: number, gainPct: number): Bar {
        const c = prevClose * (1 + gainPct);
        const o = prevClose;
        return { o, h: c * 1.15, l: o * 0.995, c, v: 20000 };
    }

    function blowOffSeries(name: string, phase: number, gainPct: number, blowDays: number[]): OhlcvSeries {
        let prevClose = 0;
        return makeSeries(name, T, (t) => {
            if (blowDays.includes(t)) {
                const b = blowOffBar(prevClose, gainPct);
                prevClose = b.c;
                return b;
            }
            const b = quietBar(t, phase);
            prevClose = b.c;
            return b;
        });
    }

    it('quiet series → score defined and small, no crossing', () => {
        const result = computeFragilityFromSeries(
            [blowOffSeries('A', 0, 0, []), blowOffSeries('B', 1, 0, []), blowOffSeries('C', 2, 0, [])],
            dateAt(T - 1)
        )!;
        expect(result).not.toBeNull();
        expect(result.latest.score).not.toBeNull();
        expect(Math.abs(result.latest.score!)).toBeLessThan(FRAGILITY_THRESHOLD);
        expect(result.crossedUp).toBe(false);
    });

    it('euphoric blow-off on the last day → score crosses upward (crossedUp = true)', () => {
        const last = T - 1;
        const result = computeFragilityFromSeries(
            [
                blowOffSeries('A', 0, 0.03, [last]),
                blowOffSeries('B', 1, 0.08, [last]),
                blowOffSeries('C', 2, 0.12, [last]),
            ],
            dateAt(last)
        )!;
        expect(result.latest.score!).toBeGreaterThanOrEqual(FRAGILITY_THRESHOLD);
        expect(result.prevScore!).toBeLessThan(FRAGILITY_THRESHOLD);
        expect(result.crossedUp).toBe(true);
    });

    it('score already above on both days → crossedUp = false (anti-spam)', () => {
        const result = computeFragilityFromSeries(
            [
                blowOffSeries('A', 0, 0.03, [T - 2, T - 1]),
                blowOffSeries('B', 1, 0.08, [T - 2, T - 1]),
                blowOffSeries('C', 2, 0.12, [T - 2, T - 1]),
            ],
            dateAt(T - 1)
        )!;
        expect(result.latest.score!).toBeGreaterThanOrEqual(FRAGILITY_THRESHOLD);
        expect(result.prevScore!).toBeGreaterThanOrEqual(FRAGILITY_THRESHOLD);
        expect(result.crossedUp).toBe(false);
    });

    it('returns null while the latest day is still in burn-in', () => {
        // 100 days: features exist but never 5 non-null z's (z needs 60 priors).
        const mk = (name: string, phase: number) => makeSeries(name, 100, (t) => quietBar(t, phase));
        expect(computeFragilityFromSeries([mk('A', 0), mk('B', 1)], dateAt(99))).toBeNull();
    });
});

describe('constants', () => {
    it('locks the study-calibrated values', () => {
        expect(FRAGILITY_THRESHOLD).toBe(1.0);
        expect(MIN_TICKERS).toBe(8);
    });
});
