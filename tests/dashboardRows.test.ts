import { regionOf, isETFSector } from '../src/lean/dashboardRows.js';

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
