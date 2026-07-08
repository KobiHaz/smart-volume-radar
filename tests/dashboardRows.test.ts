import { regionOf, isETFSector } from '../src/lean/dashboardRows.js';
import { scoreRow } from '../src/lean/dashboardRows.js';
import { rowsFromLeanResult } from '../src/lean/dashboardRows.js';
import { rowsFromReconstructed } from '../src/lean/dashboardRows.js';

const base = {
  scanDate: '2026-06-29', ticker: 'X', region: 'US' as const, sector: 'Semis',
  rvol: 0, athPct: -20, dayPct: 1, stage2: 0 as 0 | 1, distPivot: null, price: 100,
};

describe('regionOf', () => {
  it('classifies US, TASE, Foreign', () => {
    expect(regionOf('AAPL')).toBe('US');
    expect(regionOf('TEVA.TA')).toBe('TASE');
    expect(regionOf('ASML.AS')).toBe('Foreign');
    expect(regionOf('6531.TW')).toBe('Foreign');
  });
});

describe('isETFSector', () => {
  it('detects ETF sectors', () => {
    expect(isETFSector('ETF - US')).toBe(true);
    expect(isETFSector('Semiconductor')).toBe(false);
  });
});

describe('scoreRow', () => {
  it('rewards Stage2 + volume for a healthy pullback', () => {
    const s = scoreRow({ ...base, signal: 'pullback', signals: ['pullback'], signalCount: 1, rvol: 4, stage2: 1 });
    // 50 base + min(4,6)*5=20 + stage2 20 + confluence 0 = 90
    expect(s).toBe(90);
  });
  it('penalizes a high-volume down-day (climax) and deep ATH', () => {
    // RENK-like: highVolume, RVOL 6+, dayPct<0, athPct -52, not stage2
    const s = scoreRow({ ...base, signal: 'highVolume', signals: ['highVolume'], signalCount: 1, rvol: 12, dayPct: -2, athPct: -52, stage2: 0 });
    // 30 + min(12,6)*5=30 + 0 - 25 (down-day climax) - 20 (deep ATH) - 15 (rvol>=8 climax) = 0
    expect(s).toBe(0);
  });
  it('penalizes RVOL >= 8 by 15 (2026-07-08 study: climax RVOL is noise)', () => {
    const at6 = scoreRow({ ...base, signal: 'highVolume', signals: ['highVolume'], signalCount: 1, rvol: 6, stage2: 1 });
    const at9 = scoreRow({ ...base, signal: 'highVolume', signals: ['highVolume'], signalCount: 1, rvol: 9, stage2: 1 });
    // rvol contribution capped at 6*5=30 for both — the only delta is the -15 penalty.
    expect(at6 - at9).toBe(15);
  });
  it('adds proximity bonus for a near-breakout at the pivot', () => {
    const s = scoreRow({ ...base, signal: 'nearBreakout', signals: ['nearBreakout'], signalCount: 1, rvol: 0, stage2: 1, distPivot: 0 });
    // 8 + 0 + 20 + max(0,10-0*4)=10 = 38
    expect(s).toBe(38);
  });
  it('de-prioritizes ETFs', () => {
    const s = scoreRow({ ...base, signal: 'pullback', signals: ['pullback'], signalCount: 1, rvol: 0, sector: 'ETF - US' });
    // 50 + 0 + 0 - 12 = 38
    expect(s).toBe(38);
  });
  it('rewards multi-signal confluence (+12 per extra signal, base = strongest)', () => {
    // pullback + highVolume: base = max(50,30)=50, +confluence (2-1)*12=12
    const s = scoreRow({ ...base, signal: 'pullback', signals: ['pullback', 'highVolume'], signalCount: 2, rvol: 0, stage2: 0 });
    // 50 base + 0 + 0 + 12 confluence = 62
    expect(s).toBe(62);
  });
  it('applies climax penalty when highVolume is present in a multi-signal row on a down day', () => {
    // pullback + highVolume, down day → base 50 + confluence 12 - climax 25 = 37
    const s = scoreRow({ ...base, signal: 'pullback', signals: ['pullback', 'highVolume'], signalCount: 2, rvol: 0, dayPct: -1, athPct: -20, stage2: 0 });
    expect(s).toBe(37);
  });
});

function stub(ticker: string, over: any = {}) {
  return { ticker, sector: 'Semis', rvol: 2, pctFromAth: -20, priceChange: 1,
           lastPrice: 100, sma50: 110, sma200: 90, ...over };
}

describe('rowsFromLeanResult', () => {
  it('maps each category to a Row with the right signal + dist_pivot', () => {
    const result: any = {
      consolidationBreakouts: [{ stock: stub('MNST', { lastPrice: 120, sma50: 100, sma200: 90 }), signal: { window: '1M', windowHigh: 119 } }],
      highVolume: [{ stock: stub('CTRA'), signal: { level: 'extreme' } }],
      pullbacks: [{ stock: stub('ARM'), signal: { pctFromAth: -22 } }],
      nearConsolidation: [{ stock: stub('REG'), signal: { window: '1M', windowHigh: 81, distanceToPivotPct: 0.6 } }],
      nearVolume: [{ stock: stub('FOO'), signal: { rvol: 2.7 } }],
      nearPullback: [{ stock: stub('BAR'), signal: { pctFromAth: -13 } }],
    };
    const rows = rowsFromLeanResult('2026-06-29', result);
    const by = Object.fromEntries(rows.map((r) => [r.ticker, r]));
    expect(by.MNST.signal).toBe('breakout');
    expect(by.MNST.signals).toEqual(['breakout']);
    expect(by.MNST.signalCount).toBe(1);
    expect(by.MNST.distPivot).toBe(0);
    expect(by.MNST.stage2).toBe(1);            // 120>100>90
    expect(by.CTRA.signal).toBe('highVolume');
    expect(by.REG.signal).toBe('nearBreakout');
    expect(by.REG.distPivot).toBe(0.6);
    expect(by.FOO.signal).toBe('nearHighVol');
    expect(by.BAR.signal).toBe('nearPullback');
    expect(by.ARM.scanDate).toBe('2026-06-29');
    expect(typeof by.ARM.score).toBe('number');
  });

  it('maps creep detections to rows with BASE 42', () => {
    const result: any = {
      consolidationBreakouts: [], highVolume: [], pullbacks: [],
      creep: [{ stock: stub('INTC', { rvol: 0.9, pctFromAth: -3, lastPrice: 120, sma50: 100, sma200: 90 }),
                signal: { mom63: 47, pctFromAth: -3, avgDollarVolumeUsd: 50_000_000 } }],
      nearConsolidation: [], nearVolume: [], nearPullback: [],
    };
    const rows = rowsFromLeanResult('2026-07-08', result);
    expect(rows).toHaveLength(1);
    expect(rows[0].signal).toBe('creep');
    // BASE 42 + rvol 0.9*5=4.5 + stage2 20 = 66.5 → 67 (rounded)
    expect(rows[0].score).toBeGreaterThanOrEqual(42);
  });

  it('tolerates results without a creep section (older snapshots)', () => {
    const result: any = {
      consolidationBreakouts: [], highVolume: [],
      pullbacks: [{ stock: stub('ARM'), signal: { pctFromAth: -22 } }],
      nearConsolidation: [], nearVolume: [], nearPullback: [],
    };
    expect(() => rowsFromLeanResult('2026-07-08', result)).not.toThrow();
  });

  it('groups a ticker matching multiple signals into ONE row (signals ordered by BASE desc)', () => {
    const result: any = {
      consolidationBreakouts: [],
      highVolume: [{ stock: stub('ZZZ'), signal: { level: 'extreme' } }],
      pullbacks: [{ stock: stub('ZZZ', { pctFromAth: -22 }), signal: { pctFromAth: -22 } }],
      nearConsolidation: [],
      nearVolume: [],
      nearPullback: [],
    };
    const rows = rowsFromLeanResult('2026-06-29', result);
    expect(rows).toHaveLength(1);              // no duplicate tickers
    const r = rows[0];
    expect(r.ticker).toBe('ZZZ');
    expect(r.signals).toEqual(['pullback', 'highVolume']); // BASE desc: 40 > 35
    expect(r.signal).toBe('pullback');         // primary = signals[0]
    expect(r.signalCount).toBe(2);
    // score should include the +12 confluence bonus vs a single-signal pullback
    const single = rowsFromLeanResult('2026-06-29', {
      consolidationBreakouts: [], highVolume: [],
      pullbacks: [{ stock: stub('ZZZ', { pctFromAth: -22 }), signal: { pctFromAth: -22 } }],
      nearConsolidation: [], nearVolume: [], nearPullback: [],
    } as any)[0];
    expect(r.score).toBe(single.score + 12);
  });

  it('emits no duplicate tickers when a ticker appears in several category arrays', () => {
    const result: any = {
      consolidationBreakouts: [{ stock: stub('DUP', { lastPrice: 120, sma50: 100, sma200: 90 }), signal: { window: '1M', windowHigh: 119, distanceToPivotPct: 0 } }],
      highVolume: [{ stock: stub('DUP'), signal: { level: 'extreme' } }],
      pullbacks: [{ stock: stub('DUP', { pctFromAth: -22 }), signal: { pctFromAth: -22 } }],
      nearConsolidation: [],
      nearVolume: [],
      nearPullback: [],
    };
    const rows = rowsFromLeanResult('2026-06-29', result);
    const tickers = rows.map((r) => r.ticker);
    expect(new Set(tickers).size).toBe(tickers.length);
    expect(rows).toHaveLength(1);
    expect(rows[0].signals).toEqual(['pullback', 'highVolume', 'breakout']); // 50 > 30 > 12
    expect(rows[0].signal).toBe('pullback');
    expect(rows[0].distPivot).toBe(0);         // carried from breakout entry
  });
});

describe('rowsFromReconstructed', () => {
  it('flattens signalsByDate into scored Rows', () => {
    const recon = {
      signalsByDate: {
        '2026-06-29': {
          ARM: { sector: 'Semis', rvol: 3.6, barGain: 2.8, pctFromAth: -22,
                 lastPrice: 343, isStage2: true, signals: ['pullback'], distanceToPivotPct: null },
        },
      },
    };
    const rows = rowsFromReconstructed(recon as never);
    expect(rows).toHaveLength(1);
    expect(rows[0].ticker).toBe('ARM');
    expect(rows[0].signal).toBe('pullback');
    expect(rows[0].signals).toEqual(['pullback']);
    expect(rows[0].signalCount).toBe(1);
    expect(rows[0].stage2).toBe(1);
    expect(rows[0].dayPct).toBe(2.8);
    expect(typeof rows[0].score).toBe('number');
  });

  it('builds one row/ticker with signals ordered by BASE desc (primary = strongest)', () => {
    const recon = {
      signalsByDate: {
        '2026-06-29': {
          MULTI: { sector: 'Semis', rvol: 0, barGain: 1, pctFromAth: -20,
                   lastPrice: 100, isStage2: false, signals: ['highVolume', 'pullback'], distanceToPivotPct: null },
        },
      },
    };
    const rows = rowsFromReconstructed(recon as never);
    expect(rows).toHaveLength(1);
    expect(rows[0].signals).toEqual(['pullback', 'highVolume']); // re-ordered BASE desc
    expect(rows[0].signal).toBe('pullback');
    expect(rows[0].signalCount).toBe(2);
    // base 50 + confluence 12 = 62
    expect(rows[0].score).toBe(62);
  });
});
