// dashboard/src/ingestD1.ts
export interface Row {
  scanDate: string; ticker: string; region: string; sector: string; signal: string;
  signals: string[]; signalCount: number;
  rvol: number; athPct: number | null; dayPct: number; stage2: number;
  distPivot: number | null; score: number; price: number;
}
export interface Batch { sql: string; params: unknown[]; }

const COLS = '(scan_date,ticker,region,sector,signal,signals,signal_count,rvol,ath_pct,day_pct,stage2,dist_pivot,score,price)';

export function buildUpsertBatches(rows: Row[], batchSize = 100): Batch[] {
  const batches: Batch[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const params: unknown[] = [];
    for (const r of slice) {
      params.push(r.scanDate, r.ticker, r.region, r.sector, r.signal,
        r.signals.join(','), r.signalCount, r.rvol,
        r.athPct, r.dayPct, r.stage2, r.distPivot, r.score, r.price);
    }
    batches.push({ sql: `INSERT OR REPLACE INTO lean_signals ${COLS} VALUES ${placeholders}`, params });
  }
  return batches;
}

export interface D1Config { accountId: string; databaseId: string; apiToken: string; }

export async function ingestRows(rows: Row[], cfg: D1Config): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
  for (const batch of buildUpsertBatches(rows)) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: batch.sql, params: batch.params }),
    });
    if (!res.ok) throw new Error(`D1 ingest failed ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { success: boolean; errors?: unknown };
    if (!body.success) throw new Error(`D1 error: ${JSON.stringify(body.errors)}`);
  }
}
