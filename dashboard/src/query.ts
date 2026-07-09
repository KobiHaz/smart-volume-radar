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

/**
 * Setup rows written daily by the Smart pipeline into its OWN table
 * (setup_signals) — merged into lean rows at read time by mergeSetup.ts.
 * The table may not exist until the first Smart ingest runs: callers must
 * treat a query error as "no rows".
 */
export function buildSetupRowsQuery(p: SignalParams): Query {
  const SEL = 'SELECT scan_date,ticker,region,sector,sig,rvol,ath_pct,day_pct,stage2,score,price,rs,ingested_at FROM setup_signals';
  if (p.from && p.to) {
    return { sql: `${SEL} WHERE scan_date BETWEEN ? AND ?`, params: [p.from, p.to] };
  }
  return { sql: `${SEL} WHERE scan_date = (SELECT MAX(scan_date) FROM lean_signals)`, params: [] };
}

/** RS percentiles for all scanned tickers (rs_daily) — fills rs on lean rows. */
export function buildRsDailyQuery(p: SignalParams): Query {
  const SEL = 'SELECT scan_date,ticker,rs FROM rs_daily';
  if (p.from && p.to) {
    return { sql: `${SEL} WHERE scan_date BETWEEN ? AND ?`, params: [p.from, p.to] };
  }
  return { sql: `${SEL} WHERE scan_date = (SELECT MAX(scan_date) FROM lean_signals)`, params: [] };
}

/** Per-date setup counts for the summary merge. setup_new = setup rows with
 *  no lean row that day (added to the day's total). */
export function buildSetupSummaryQuery(): Query {
  return {
    sql: `SELECT scan_date,
      SUM(sig='setupFull') AS setup_full,
      SUM(sig!='setupFull') AS setup_other,
      SUM(NOT EXISTS (SELECT 1 FROM lean_signals ls
                      WHERE ls.scan_date=setup_signals.scan_date
                        AND ls.ticker=setup_signals.ticker)) AS setup_new,
      SUM(rs>=90) AS rs90
      FROM setup_signals GROUP BY scan_date`,
    params: [],
  };
}

export function buildSummaryQuery(_p: SignalParams): Query {
  return {
    sql: `SELECT scan_date,
      COUNT(*) AS total,
      SUM(signals LIKE '%setupFull%') AS setup_full,
      SUM(signals LIKE '%setupClose%' OR signals LIKE '%setupRecovery%') AS setup_other,
      SUM(signal='breakout') AS breakout,
      SUM(signal='highVolume') AS high_volume,
      SUM(signal='pullback') AS pullback,
      SUM(signal='creep') AS creep,
      SUM(signal LIKE 'near%') AS near_all,
      SUM(score>=70) AS score70,
      SUM(score>=65) AS score65,
      SUM(rs>=90) AS rs90,
      MAX(ingested_at) AS last_run
      FROM lean_signals GROUP BY scan_date ORDER BY scan_date DESC`,
    params: [],
  };
}
