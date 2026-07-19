// dashboard/tests/query.test.ts
import {
  buildSignalsQuery,
  buildSummaryQuery,
  buildRecentDatesQuery,
  buildHistoryRowsQuery,
} from '../src/query.js';

describe('buildSignalsQuery', () => {
  it('defaults to latest day when no params', () => {
    const q = buildSignalsQuery({});
    expect(q.sql).toMatch(/scan_date = \(SELECT MAX\(scan_date\) FROM lean_signals\)/);
    expect(q.params).toEqual([]);
  });
  it('selects the signals + signal_count columns', () => {
    const q = buildSignalsQuery({});
    expect(q.sql).toMatch(/signals,signal_count/);
  });
  it('filters by date range', () => {
    const q = buildSignalsQuery({ from: '2026-06-01', to: '2026-06-29' });
    expect(q.sql).toMatch(/scan_date BETWEEN \? AND \?/);
    expect(q.params).toEqual(['2026-06-01', '2026-06-29']);
  });
});

describe('buildRecentDatesQuery', () => {
  it('selects distinct scan_dates on/before day, DESC, with limit', () => {
    const q = buildRecentDatesQuery('2026-06-03', 12);
    expect(q.sql).toBe(
      'SELECT DISTINCT scan_date FROM lean_signals WHERE scan_date <= ? ORDER BY scan_date DESC LIMIT ?',
    );
    expect(q.params).toEqual(['2026-06-03', 12]);
  });
  it('defaults limit to 12', () => {
    const q = buildRecentDatesQuery('2026-06-03');
    expect(q.params).toEqual(['2026-06-03', 12]);
  });
});

describe('buildHistoryRowsQuery', () => {
  it('emits one placeholder per date and passes dates as params', () => {
    const q = buildHistoryRowsQuery(['2026-06-03', '2026-06-02', '2026-06-01']);
    expect(q.sql).toBe(
      'SELECT scan_date,ticker,signal,signals,score FROM lean_signals WHERE scan_date IN (?,?,?)',
    );
    expect(q.params).toEqual(['2026-06-03', '2026-06-02', '2026-06-01']);
  });
  it('produces valid SQL and no params for an empty date list', () => {
    const q = buildHistoryRowsQuery([]);
    expect(q.sql).toMatch(/WHERE scan_date IN \(SELECT NULL WHERE 0\)/);
    expect(q.params).toEqual([]);
  });
});

describe('buildSummaryQuery', () => {
  it('groups counts by date', () => {
    const q = buildSummaryQuery({});
    expect(q.sql).toMatch(/GROUP BY scan_date/);
  });
});

describe('buildFragilityQuery', () => {
  // Imported lazily to keep the existing import block untouched.
  const { buildFragilityQuery } = require('../src/query.js');

  it('defaults to the full scored series with limit 250, ascending', () => {
    const q = buildFragilityQuery({});
    expect(q.sql).toMatch(/FROM fragility_daily WHERE score IS NOT NULL/);
    expect(q.sql).toMatch(/ORDER BY scan_date ASC LIMIT \?/);
    expect(q.params).toEqual([250]);
  });

  it('selects the score, six z components, index, drawdown and canary', () => {
    const q = buildFragilityQuery({});
    for (const col of ['score', 'wick10_z', 'pct_above50_z', 'dist20_z', 'ext50_z', 'corr20_z', 'disp10_z', 'index_value', 'drawdown_pct', 'canary_count']) {
      expect(q.sql).toContain(col);
    }
  });

  it('applies from-date filter and custom limit', () => {
    const q = buildFragilityQuery({ from: '2026-01-01', limit: 60 });
    expect(q.sql).toMatch(/AND scan_date >= \?/);
    expect(q.params).toEqual(['2026-01-01', 60]);
  });
});
