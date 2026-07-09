// dashboard/src/query.ts
export interface Query { sql: string; params: unknown[]; }
export interface SignalParams { from?: string; to?: string; }

const SELECT = 'SELECT scan_date,ticker,region,sector,signal,signals,signal_count,rvol,ath_pct,day_pct,stage2,dist_pivot,score,price,ingested_at,rs FROM lean_signals';

export function buildSignalsQuery(p: SignalParams): Query {
  if (p.from && p.to) {
    return { sql: `${SELECT} WHERE scan_date BETWEEN ? AND ? ORDER BY scan_date DESC, score DESC`, params: [p.from, p.to] };
  }
  return { sql: `${SELECT} WHERE scan_date = (SELECT MAX(scan_date) FROM lean_signals) ORDER BY score DESC`, params: [] };
}

/** Recent DISTINCT scan_dates on/before `day`, most recent first. */
export function buildRecentDatesQuery(day: string, limit = 12): Query {
  return {
    sql: 'SELECT DISTINCT scan_date FROM lean_signals WHERE scan_date <= ? ORDER BY scan_date DESC LIMIT ?',
    params: [day, limit],
  };
}

/** History rows (for enrichment) across the given dates. One placeholder per date. */
export function buildHistoryRowsQuery(dates: string[]): Query {
  if (dates.length === 0) {
    return {
      sql: 'SELECT scan_date,ticker,signal,signals,score FROM lean_signals WHERE scan_date IN (SELECT NULL WHERE 0)',
      params: [],
    };
  }
  const placeholders = dates.map(() => '?').join(',');
  return {
    sql: `SELECT scan_date,ticker,signal,signals,score FROM lean_signals WHERE scan_date IN (${placeholders})`,
    params: [...dates],
  };
}

export function buildSummaryQuery(_p: SignalParams): Query {
  return {
    sql: `SELECT scan_date,
      COUNT(*) AS total,
      SUM(signal='breakout') AS breakout,
      SUM(signal='highVolume') AS high_volume,
      SUM(signal='pullback') AS pullback,
      SUM(signal LIKE 'near%') AS near_all,
      SUM(score>=70) AS score70,
      SUM(score>=65) AS score65,
      MAX(ingested_at) AS last_run
      FROM lean_signals GROUP BY scan_date ORDER BY scan_date DESC`,
    params: [],
  };
}
