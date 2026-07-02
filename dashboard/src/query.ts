// dashboard/src/query.ts
export interface Query { sql: string; params: unknown[]; }
export interface SignalParams { from?: string; to?: string; }

const SELECT = 'SELECT scan_date,ticker,region,sector,signal,signals,signal_count,rvol,ath_pct,day_pct,stage2,dist_pivot,score,price FROM lean_signals';

export function buildSignalsQuery(p: SignalParams): Query {
  if (p.from && p.to) {
    return { sql: `${SELECT} WHERE scan_date BETWEEN ? AND ? ORDER BY scan_date DESC, score DESC`, params: [p.from, p.to] };
  }
  return { sql: `${SELECT} WHERE scan_date = (SELECT MAX(scan_date) FROM lean_signals) ORDER BY score DESC`, params: [] };
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
      SUM(score>=65) AS score65
      FROM lean_signals GROUP BY scan_date ORDER BY scan_date DESC`,
    params: [],
  };
}
