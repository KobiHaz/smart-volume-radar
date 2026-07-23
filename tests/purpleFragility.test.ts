// Mock p-limit to avoid ESM import issues in Jest
jest.mock('p-limit', () => () => (fn: () => Promise<unknown>) => fn());

import {
    buildFragilityDays,
    computeFragilityFromSeries,
    splicePredecessor,
    FRAGILITY_THRESHOLD,
    CORE3_THRESHOLD,
    CLIMAX_THRESHOLD,
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
        expect(CORE3_THRESHOLD).toBe(1.0);
        expect(MIN_TICKERS).toBe(8);
    });
});

describe('splicePredecessor', () => {
    it('scale-adjusts predecessor OHLC so the seam is continuous, volumes untouched', () => {
        const pre = makeSeries('SNDK', 10, () => ({ o: 100, h: 110, l: 90, c: 100, v: 5000 }));
        const post: OhlcvSeries = {
            ticker: 'SNDK',
            dates: [dateAt(10), dateAt(11)],
            open: [50, 51], high: [55, 56], low: [45, 46], close: [50, 52], volume: [1000, 1100],
        };
        const s = splicePredecessor(pre, post);
        expect(s.ticker).toBe('SNDK');
        expect(s.dates.length).toBe(12);
        // pre close 100 → post first close 50 → scale 0.5 applied to pre OHLC
        expect(s.close[9]).toBeCloseTo(50, 10);
        expect(s.high[0]).toBeCloseTo(55, 10);
        // seam onward is the real data
        expect(s.close[10]).toBe(50);
        expect(s.close[11]).toBe(52);
        // volumes are NOT rescaled
        expect(s.volume[0]).toBe(5000);
        expect(s.volume[10]).toBe(1000);
    });

    it('drops predecessor bars that overlap the main symbol', () => {
        const pre = makeSeries('X', 12, () => ({ o: 10, h: 11, l: 9, c: 10, v: 100 }));
        const post: OhlcvSeries = {
            ticker: 'X', dates: [dateAt(10), dateAt(11)],
            open: [20, 20], high: [21, 21], low: [19, 19], close: [20, 20], volume: [50, 50],
        };
        const s = splicePredecessor(pre, post);
        expect(s.dates.length).toBe(12); // 10 pre (pre-boundary) + 2 post
        expect(new Set(s.dates).size).toBe(12); // no duplicate dates
    });

    it('returns post unchanged when predecessor has no pre-boundary bars', () => {
        const pre = makeSeries('X', 3, () => ({ o: 1, h: 2, l: 1, c: 1, v: 10 }));
        const post: OhlcvSeries = {
            ticker: 'X', dates: [dateAt(0), dateAt(1)],
            open: [5, 5], high: [6, 6], low: [4, 4], close: [5, 5], volume: [7, 7],
        };
        const s = splicePredecessor(pre, post);
        expect(s).toBe(post);
    });
});

describe('core3 (Watch tier)', () => {
    it('is the mean of the wick/dist/disp z components only', () => {
        const T = 140;
        const mk = (name: string, phase: number) => makeSeries(name, T, (t) => quietBar(t, phase));
        const result = computeFragilityFromSeries([mk('A', 0), mk('B', 1), mk('C', 2)], dateAt(T - 1))!;
        const d = result.latest;
        expect(d.core3).not.toBeNull();
        const expected = (d.z.wick10! + d.z.dist20! + d.z.disp10!) / 3;
        expect(d.core3!).toBeCloseTo(expected, 12);
    });
});

describe('climax (contextual volume z)', () => {
    const T = 140;
    const last = T - 1;

    it('registers a volume spike only while the ticker is near its own 20d high', () => {
        const mkNearHigh = (name: string, phase: number) =>
            makeSeries(name, T, (t) => {
                const b = quietBar(t, phase);
                return t === last ? { ...b, v: 8000 } : b; // huge volume, price stays at quiet levels (near high)
            });
        const builtNear = buildFragilityDays([mkNearHigh('A', 0), mkNearHigh('B', 1), mkNearHigh('C', 2)])!;
        const nearDay = builtNear.days[builtNear.days.length - 1]!;
        expect(nearDay.climax).not.toBeNull();
        expect(nearDay.climax!).toBeGreaterThanOrEqual(CLIMAX_THRESHOLD);

        const mkFarFromHigh = (name: string, phase: number) =>
            makeSeries(name, T, (t) => {
                const b = quietBar(t, phase);
                if (t !== last) return b;
                const c = b.c * 0.85; // 15% below the trailing 20d high — same huge volume
                return { o: b.o, h: c + 0.2, l: c - 0.2, c, v: 8000 };
            });
        const builtFar = buildFragilityDays([mkFarFromHigh('A', 0), mkFarFromHigh('B', 1), mkFarFromHigh('C', 2)])!;
        const farDay = builtFar.days[builtFar.days.length - 1]!;
        expect(farDay.climax).not.toBeNull();
        // Same volume spike, gated to 0 because price fell away from the high.
        expect(farDay.climax!).toBeLessThan(nearDay.climax!);
    });

    it('can trigger the Watch tier alone, tagged watchTrigger="climax", without core3 crossing', () => {
        const gainPct = 0.02; // identical gain across tickers → low cross-sectional dispersion, no down days
        const climaxSpikeSeries = (name: string, phase: number): OhlcvSeries => {
            let prevClose = 0;
            return makeSeries(name, T, (t) => {
                const b = quietBar(t, phase);
                if (t !== last) { prevClose = b.c; return b; }
                const c = prevClose * (1 + gainPct);
                return { o: prevClose, h: c * 1.001, l: prevClose * 0.999, c, v: 20000 };
            });
        };
        const result = computeFragilityFromSeries(
            [climaxSpikeSeries('A', 0), climaxSpikeSeries('B', 1), climaxSpikeSeries('C', 2)],
            dateAt(last)
        )!;
        expect(result.latest.indexNearHigh).toBe(true);
        expect(result.latest.climax!).toBeGreaterThanOrEqual(CLIMAX_THRESHOLD);
        expect(result.latest.core3 == null || result.latest.core3! < CORE3_THRESHOLD).toBe(true);
        expect(result.core3CrossedUp).toBe(true);
        expect(result.watchTrigger).toBe('climax');
    });
});

describe('dual-tier crossing (model v2)', () => {
    const T = 140;

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

    it('🔴 Alert requires indexNearHigh — a fragility spike while off the high does not cross', () => {
        const last = T - 1;
        // Deep decline days 60..last-1 pulls the index well below its early peak;
        // the divergent blow-off on the final day spikes mean6 without recovering
        // anywhere near the running high in a single day.
        const decliner = (name: string, phase: number, gainPct: number) => {
            let prevClose = 0;
            return makeSeries(name, T, (t) => {
                if (t === last) {
                    const b = blowOffBar(prevClose, gainPct);
                    prevClose = b.c;
                    return b;
                }
                if (t >= 60) {
                    const c = prevClose * 0.99;
                    prevClose = c;
                    return { o: prevClose / 0.99, h: prevClose / 0.99 + 0.2, l: c - 0.2, c, v: 1000 };
                }
                const b = quietBar(t, phase);
                prevClose = b.c;
                return b;
            });
        };
        const result = computeFragilityFromSeries(
            [decliner('A', 0, 0.03), decliner('B', 1, 0.08), decliner('C', 2, 0.12)],
            dateAt(last)
        )!;
        expect(result.latest.indexNearHigh).toBe(false);
        expect(result.crossedUp).toBe(false);
    });

    it('watchTrigger is "both" when core3 and climax cross on the same day', () => {
        const last = T - 1;
        const result = computeFragilityFromSeries(
            [
                blowOffSeries('A', 0, 0.03, [last]),
                blowOffSeries('B', 1, 0.08, [last]),
                blowOffSeries('C', 2, 0.12, [last]),
            ],
            dateAt(last)
        )!;
        expect(result.latest.core3!).toBeGreaterThanOrEqual(CORE3_THRESHOLD);
        expect(result.latest.climax!).toBeGreaterThanOrEqual(CLIMAX_THRESHOLD);
        expect(result.watchTrigger).toBe('both');
    });
});

describe('capitulation score (מד המיצוי) — display-only, no threshold/alert wired to it', () => {
    const T = 140;
    const last = T - 1;

    it('is defined once at least 3 of 4 components are available, and equals their mean', () => {
        const mk = (name: string, phase: number) => makeSeries(name, T, (t) => quietBar(t, phase));
        const built = buildFragilityDays([mk('A', 0), mk('B', 1), mk('C', 2)])!;
        const d = built.days[built.days.length - 1]!;
        expect(d.capitulation).not.toBeNull();
        const vals = Object.values(d.capitulationZ).filter((x): x is number => x != null);
        expect(vals.length).toBeGreaterThanOrEqual(3);
        expect(d.capitulation!).toBeCloseTo(vals.reduce((a, b) => a + b, 0) / vals.length, 12);
    });

    it('panicVolume registers a volume spike only on a day the ticker actually fell >1%', () => {
        // quietBar alone never has a >1% single-day move, so the panic-volume raw
        // series would be a constant zero (degenerate variance, z stays null
        // forever — see expandingZ's documented guard). Give the background a
        // periodic, modest down-day + volume bump so the series has genuine
        // variance to z-score against, then compare a real spike day to it.
        const noisyBar = (t: number, phase: number, prevClose: number): Bar => {
            const dip = t % 7 === 3;
            const c = dip ? prevClose * 0.988 : prevClose * (1 + 0.001 * Math.sin(t * 0.7 + phase));
            const v = dip ? 1500 + Math.round(200 * Math.sin(t * 0.9 + phase)) : 1000 + Math.round(100 * Math.sin(t * 1.3 + phase));
            return { o: prevClose, h: prevClose + 0.3, l: c - 0.3, c, v };
        };
        const mkFalling = (name: string, phase: number): OhlcvSeries => {
            let prevClose = 100;
            return makeSeries(name, T, (t) => {
                if (t !== last) { const b = noisyBar(t, phase, prevClose); prevClose = b.c; return b; }
                const c = prevClose * 0.98; // -2% day-over-day — clears the >1% down gate
                return { o: prevClose, h: prevClose + 0.2, l: c - 0.2, c, v: 8000 };
            });
        };
        const mkFlat = (name: string, phase: number): OhlcvSeries => {
            let prevClose = 100;
            return makeSeries(name, T, (t) => {
                const b = noisyBar(t, phase, prevClose);
                prevClose = b.c;
                return t === last ? { ...b, v: 8000 } : b; // same huge volume, no down day
            });
        };
        const fallingDay = buildFragilityDays([mkFalling('A', 0), mkFalling('B', 1), mkFalling('C', 2)])!
            .days.at(-1)!;
        const flatDay = buildFragilityDays([mkFlat('A', 0), mkFlat('B', 1), mkFlat('C', 2)])!
            .days.at(-1)!;
        expect(fallingDay.capitulationZ.panicVolume).not.toBeNull();
        expect(flatDay.capitulationZ.panicVolume).not.toBeNull();
        expect(fallingDay.capitulationZ.panicVolume!).toBeGreaterThan(flatDay.capitulationZ.panicVolume!);
    });

    it('washout is elevated when the whole basket trades below its own 20d MA', () => {
        const mk = (name: string, phase: number): OhlcvSeries => {
            let prevClose = 0;
            return makeSeries(name, T, (t) => {
                if (t < last - 5) { const b = quietBar(t, phase); prevClose = b.c; return b; }
                const c = prevClose * 0.97; // crash the last 6 days well below the trailing MA20
                const b = { o: prevClose, h: prevClose + 0.2, l: c - 0.2, c, v: 1000 };
                prevClose = c;
                return b;
            });
        };
        const d = buildFragilityDays([mk('A', 0), mk('B', 1), mk('C', 2)])!.days.at(-1)!;
        expect(d.capitulationZ.washout).not.toBeNull();
        expect(d.capitulationZ.washout!).toBeGreaterThan(0);
    });

    it('negMom is positive after a sustained trailing-20d index decline', () => {
        const mk = (name: string, phase: number): OhlcvSeries => {
            let prevClose = 0;
            return makeSeries(name, T, (t) => {
                if (t < T - 20) { const b = quietBar(t, phase); prevClose = b.c; return b; }
                const c = prevClose * 0.99; // ~-1%/day compounding decline over the trailing 20d
                const b = { o: prevClose, h: prevClose + 0.2, l: c - 0.2, c, v: 1000 };
                prevClose = c;
                return b;
            });
        };
        const d = buildFragilityDays([mk('A', 0), mk('B', 1), mk('C', 2)])!.days.at(-1)!;
        expect(d.capitulationZ.negMom).not.toBeNull();
        expect(d.capitulationZ.negMom!).toBeGreaterThan(0);
    });

    it('depth is positive when the index sits well below its running peak', () => {
        const mk = (name: string, phase: number): OhlcvSeries => {
            let prevClose = 0;
            return makeSeries(name, T, (t) => {
                if (t < 80) { const b = quietBar(t, phase); prevClose = b.c; return b; } // establish a peak
                const c = prevClose * 0.995; // steady decline from t=80 to the end
                const b = { o: prevClose, h: prevClose + 0.2, l: c - 0.2, c, v: 1000 };
                prevClose = c;
                return b;
            });
        };
        const d = buildFragilityDays([mk('A', 0), mk('B', 1), mk('C', 2)])!.days.at(-1)!;
        expect(d.capitulationZ.depth).not.toBeNull();
        expect(d.capitulationZ.depth!).toBeGreaterThan(0);
    });
});
