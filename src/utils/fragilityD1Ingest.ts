/**
 * Purple List Fragility → D1 ingest (dashboard integration).
 *
 * Writes the recomputed fragility series into `fragility_daily`, a table the
 * Smart pipeline OWNS EXCLUSIVELY (same isolation rationale as setup_signals
 * — see setupD1Ingest.ts).
 *
 * Backfills up to the last {@link BACKFILL_DAYS} scored rows every run rather
 * than just the latest row: the dashboard gets full chartable history from
 * day one, and historical rows stay consistent with today's expanding-window
 * recomputation (past z's can shift slightly as data corrections land — the
 * table is "as recomputed today", not an immutable archive).
 *
 * Never throws — a D1/network failure must not fail the scan (Telegram
 * already went out). Missing CF_* env → silent skip.
 */
import type { FragilityDay, FragilityResult } from '../services/purpleFragility.js';
import { runBatch, type Batch, type D1Config } from './setupD1Ingest.js';
import { logger } from './logger.js';

const BACKFILL_DAYS = 250;

const FRAGILITY_COLS =
    '(scan_date,score,core3,climax,capitulation,wick10_z,pct_above50_z,dist20_z,ext50_z,corr20_z,disp10_z,' +
    'index_value,drawdown_pct,canary_count,ingested_at)';
/** D1 caps at 100 bound params/query: 15 cols × 6 rows = 90. Adding a column
 *  requires lowering ROWS_PER_INSERT — the unit test asserts the arithmetic.
 *  Only the combined `capitulation` score is stored (not its 4 sub-components)
 *  — the dashboard only plots the one line (FR5, PRD-capitulation-score.md). */
export const FRAGILITY_COL_COUNT = 15;
export const ROWS_PER_INSERT = 6;

const round = (x: number | null, digits: number): number | null =>
    x == null ? null : Math.round(x * 10 ** digits) / 10 ** digits;

export function buildFragilityBatches(days: FragilityDay[], stamp: string): Batch[] {
    const rows = days.filter((d) => d.score != null).slice(-BACKFILL_DAYS);
    const batches: Batch[] = [
        {
            sql: `CREATE TABLE IF NOT EXISTS fragility_daily (
                scan_date TEXT PRIMARY KEY,
                score REAL, core3 REAL, climax REAL, capitulation REAL, wick10_z REAL, pct_above50_z REAL, dist20_z REAL,
                ext50_z REAL, corr20_z REAL, disp10_z REAL,
                index_value REAL, drawdown_pct REAL, canary_count INTEGER, ingested_at TEXT)`,
            params: [],
        },
    ];
    if (rows.length === 0) return batches;
    // Range delete (not per-date): removes rows a calendar shift would orphan.
    batches.push({
        sql: 'DELETE FROM fragility_daily WHERE scan_date >= ?',
        params: [rows[0]!.date],
    });
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
        const slice = rows.slice(i, i + ROWS_PER_INSERT);
        const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
        const params: unknown[] = [];
        for (const d of slice) {
            params.push(
                d.date,
                round(d.score, 4),
                round(d.core3, 4),
                round(d.climax, 4),
                round(d.capitulation, 4),
                round(d.z.wick10, 4), round(d.z.pctAbove50, 4), round(d.z.dist20, 4),
                round(d.z.ext50, 4), round(d.z.corr20, 4), round(d.z.disp10, 4),
                round(d.indexValue, 4), round(d.drawdownPct, 2),
                d.canaryCount, stamp
            );
        }
        batches.push({
            sql: `INSERT OR REPLACE INTO fragility_daily ${FRAGILITY_COLS} VALUES ${placeholders}`,
            params,
        });
    }
    return batches;
}

/**
 * Ingest the recomputed fragility series into D1. Reads CF_* from env when
 * `cfg` is not provided. Returns true on success, false on skip/failure —
 * NEVER throws. No-op when `result` is null (fragility compute failed today).
 */
export async function ingestFragilityToD1(
    result: FragilityResult | null,
    scanDate: string,
    cfg?: D1Config
): Promise<boolean> {
    try {
        if (!result) return false;
        const config: D1Config = cfg ?? {
            accountId: process.env.CF_ACCOUNT_ID ?? '',
            databaseId: process.env.D1_DATABASE_ID ?? '',
            apiToken: process.env.CF_API_TOKEN ?? '',
        };
        if (!config.accountId || !config.databaseId || !config.apiToken) {
            logger.info('🟣 D1 fragility ingest skipped (CF_* env not configured)');
            return false;
        }
        const stamp = `fragility-daily ${new Date().toISOString()}`;
        // One-time migrations for tables created before each model version:
        // ALTER fails harmlessly once the column exists — swallow that case only.
        try {
            await runBatch({ sql: 'ALTER TABLE fragility_daily ADD COLUMN core3 REAL', params: [] }, config);
        } catch {
            // column already present (or table missing — CREATE below handles it)
        }
        try {
            await runBatch({ sql: 'ALTER TABLE fragility_daily ADD COLUMN climax REAL', params: [] }, config);
        } catch {
            // column already present (or table missing — CREATE below handles it)
        }
        try {
            await runBatch({ sql: 'ALTER TABLE fragility_daily ADD COLUMN capitulation REAL', params: [] }, config);
        } catch {
            // column already present (or table missing — CREATE below handles it)
        }
        const batches = buildFragilityBatches(result.series, stamp);
        for (const batch of batches) {
            await runBatch(batch, config);
        }
        const rowCount = result.series.filter((d) => d.score != null).slice(-BACKFILL_DAYS).length;
        logger.info(`🟣 D1 fragility ingest: ${rowCount} rows through ${scanDate}`);
        return true;
    } catch (err) {
        logger.warn(`D1 fragility ingest failed (non-fatal): ${(err as Error).message}`);
        return false;
    }
}
