// dashboard/tests/query.test.ts
import { buildSignalsQuery, buildSummaryQuery } from '../src/query.js';

describe('buildSignalsQuery', () => {
  it('defaults to latest day when no params', () => {
    const q = buildSignalsQuery({});
    expect(q.sql).toMatch(/scan_date = \(SELECT MAX\(scan_date\) FROM lean_signals\)/);
    expect(q.params).toEqual([]);
  });
  it('filters by date range', () => {
    const q = buildSignalsQuery({ from: '2026-06-01', to: '2026-06-29' });
    expect(q.sql).toMatch(/scan_date BETWEEN \? AND \?/);
    expect(q.params).toEqual(['2026-06-01', '2026-06-29']);
  });
});

describe('buildSummaryQuery', () => {
  it('groups counts by date', () => {
    const q = buildSummaryQuery({});
    expect(q.sql).toMatch(/GROUP BY scan_date/);
  });
});
