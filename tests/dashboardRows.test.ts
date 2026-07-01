import { regionOf, isETFSector } from '../src/lean/dashboardRows.js';
import { scoreRow } from '../src/lean/dashboardRows.js';
import { rowsFromLeanResult } from '../src/lean/dashboardRows.js';

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
    const s = scoreRow({ ...base, signal: 'pullback', rvol: 4, stage2: 1 });
    // 40 base + min(4,6)*5=20 + stage2 20 = 80
    expect(s).toBe(80);
  });
  it('penalizes a high-volume down-day (climax) and deep ATH', () => {
    // RENK-like: highVolume, RVOL 6+, dayPct<0, athPct -52, not stage2
    const s = scoreRow({ ...base, signal: 'highVolume', rvol: 12, dayPct: -2, athPct: -52, stage2: 0 });
    // 35 + min(12,6)*5=30 + 0 - 25 (climax) - 20 (deep ATH) = 20
    expect(s).toBe(20);
  });
  it('adds proximity bonus for a near-breakout at the pivot', () => {
    const s = scoreRow({ ...base, signal: 'nearBreakout', rvol: 0, stage2: 1, distPivot: 0 });
    // 25 + 0 + 20 + max(0,10-0*4)=10 = 55
    expect(s).toBe(55);
  });
  it('de-prioritizes ETFs', () => {
    const s = scoreRow({ ...base, signal: 'pullback', rvol: 0, sector: 'ETF - US' });
    // 40 + 0 + 0 - 12 = 28
    expect(s).toBe(28);
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
});
