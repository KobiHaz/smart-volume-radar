// dashboard/src/mergeSetup.ts
//
// Read-time merge of the Smart pipeline's tables (setup_signals + rs_daily)
// into the lean_signals rows served by /api/signals.
//
// Why read-time: the lean ingest does DELETE-first on lean_signals per
// scan_date (incl. the 23:45 UTC refresh), so anything another pipeline
// writes there gets clobbered. Each pipeline owns its table; the API merges.
// Backfilled dates (2026-06-08..07-08) were merged directly INTO lean_signals
// and have no setup_signals rows — this merge is a no-op for them.

export interface LeanRowLike {
  scan_date: string;
  ticker: string;
  region?: string | null;
  sector?: string | null;
  signal: string;
  signals: string;
  signal_count: number;
  score: number;
  rs?: number | null;
  [k: string]: unknown;
}

export interface SetupRowD1 {
  scan_date: string;
  ticker: string;
  region: string | null;
  sector: string | null;
  sig: string;
  rvol: number | null;
  ath_pct: number | null;
  day_pct: number | null;
  stage2: number | null;
  score: number | null;
  price: number | null;
  rs: number | null;
  ingested_at: string | null;
}

export interface RsDailyRow {
  scan_date: string;
  ticker: string;
  rs: number | null;
}

const CONFLUENCE_BONUS = 12;
/** setupFull/setupRecovery outrank every lean kind as the primary badge. */
const PRIMARY_SETUP = new Set(['setupFull', 'setupRecovery']);

/**
 * Merge setup + RS rows into the lean rows for the same dates.
 * Returns a NEW array (input rows are shallow-copied when modified).
 */
export function mergeSetupRows<T extends LeanRowLike>(
  leanRows: T[],
  setupRows: SetupRowD1[],
  rsRows: RsDailyRow[],
): T[] {
  const byKey = new Map<string, T>();
  const out: T[] = [];
  for (const r of leanRows) {
    const copy = { ...r };
    byKey.set(`${r.scan_date}|${r.ticker}`, copy);
    out.push(copy);
  }

  for (const s of setupRows) {
    const key = `${s.scan_date}|${s.ticker}`;
    const existing = byKey.get(key);
    if (existing) {
      const sigs = (existing.signals || existing.signal || '')
        .split(',').map((x) => x.trim()).filter(Boolean);
      if (sigs.includes(s.sig)) continue; // already merged (e.g. backfilled date)
      sigs.push(s.sig);
      existing.signals = sigs.join(',');
      existing.signal_count = sigs.length;
      existing.score = (existing.score ?? 0) + CONFLUENCE_BONUS;
      if (existing.rs == null && s.rs != null) existing.rs = s.rs;
      if (PRIMARY_SETUP.has(s.sig) && existing.signal !== 'setupFull') {
        existing.signal = s.sig;
      }
    } else {
      const row = {
        scan_date: s.scan_date,
        ticker: s.ticker,
        region: s.region ?? '',
        sector: s.sector ?? '',
        signal: s.sig,
        signals: s.sig,
        signal_count: 1,
        rvol: s.rvol,
        ath_pct: s.ath_pct,
        day_pct: s.day_pct,
        stage2: s.stage2 ?? 0,
        dist_pivot: null,
        score: s.score ?? 0,
        price: s.price,
        ingested_at: s.ingested_at,
        rs: s.rs,
      } as unknown as T;
      byKey.set(key, row);
      out.push(row);
    }
  }

  if (rsRows.length > 0) {
    const rsMap = new Map(rsRows.map((r) => [`${r.scan_date}|${r.ticker}`, r.rs]));
    for (const r of out) {
      if (r.rs == null) {
        const rs = rsMap.get(`${r.scan_date}|${r.ticker}`);
        if (rs != null) r.rs = rs;
      }
    }
  }

  return out;
}

export interface SetupSummaryRow {
  scan_date: string;
  setup_full: number;
  setup_other: number;
  setup_new: number; // setup rows with NO lean row that day (add to total)
  rs90: number;
}

/**
 * Merge per-date setup summary counts into the lean summary rows.
 * Backfilled dates have no setup_signals rows → no double counting.
 */
export function mergeSummary<
  T extends { scan_date: string; total?: number; setup_full?: number; setup_other?: number; rs90?: number },
>(summaryRows: T[], setupSummary: SetupSummaryRow[]): T[] {
  if (setupSummary.length === 0) return summaryRows;
  const byDate = new Map(setupSummary.map((s) => [s.scan_date, s]));
  return summaryRows.map((r) => {
    const s = byDate.get(r.scan_date);
    if (!s) return r;
    return {
      ...r,
      total: (r.total ?? 0) + (s.setup_new ?? 0),
      setup_full: (r.setup_full ?? 0) + (s.setup_full ?? 0),
      setup_other: (r.setup_other ?? 0) + (s.setup_other ?? 0),
      rs90: (r.rs90 ?? 0) + (s.rs90 ?? 0),
    };
  });
}
