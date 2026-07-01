import { regionOf, isETFSector } from '../src/lean/dashboardRows.js';
import { scoreRow } from '../src/lean/dashboardRows.js';

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
