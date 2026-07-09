/**
 * Smart Volume Radar — daily Setup → D1 ingest (dashboard integration).
 *
 * Writes the day's Momentum-Setup signals + RS percentiles to the radar
 * dashboard's D1, into two tables the Smart pipeline OWNS EXCLUSIVELY:
 *
 *   setup_signals(scan_date, ticker, region, sector, sig, rvol, ath_pct,
 *                 day_pct, stage2, score, price, rs, ingested_at)
 *   rs_daily(scan_date, ticker, rs)
 *
 * The Lean scan's ingest does DELETE-first on `lean_signals` per scan_date
 * (including the 23:45 UTC refresh) — writing there from this pipeline would
 * be clobbered. Separate tables + read-time merge in the dashboard API avoid
 * the write race entirely and keep each pipeline idempotent on its own data.
 * (The 2026-06-08..07-08 backfill lives directly in lean_signals; those dates
 * have no setup_signals rows, so the read-merge never double-counts.)
 *
 * Never throws out of ingestSetupToD1 — a D1/network failure must not fail
 * the scan (Telegram already went out). Missing CF_* env → silent skip.
 */
import type { StockData } from '../types/index.js';
import { logger } from './logger.js';

export interface SetupRow {
    scanDate: string;
    ticker: string;
    region: 'US' | 'TASE' | 'Foreign';
    sector: string;
    sig: 'setupFull' | 'setupClose' | 'setupRecovery';
    rvol: number;
    athPct: number | null;
    dayPct: number;
    stage2: 0 | 1;
    score: number;
    price: number;
    rs: number | null;
}

export interface RsRow {
    scanDate: string;
    ticker: string;
    rs: number;
}

const FOREIGN_SUFFIXES = [
    '.TW', '.KS', '.T', '.MI', '.PA', '.L', '.AS', '.SW', '.VI',
    '.SA', '.BK', '.HK', '.DE', '.CO', '.ST', '.HE', '.OL', '.MC', '.BR', '.TO',
];

export function regionOf(ticker: string): 'US' | 'TASE' | 'Foreign' {
    if (ticker.endsWith('.TA')) return 'TASE';
    if (FOREIGN_SUFFIXES.some((s) => ticker.endsWith(s))) return 'Foreign';
    return 'US';
}

/** Display-score base per setup tier — same scale as the lean dashboard score
 *  (used only for sane sorting among lean rows; NOT a probability signal). */
const SETUP_BASE: Record<SetupRow['sig'], number> = {
    setupFull: 60,
    setupRecovery: 55,
    setupClose: 40,
};

const LEVEL_TO_SIG: Record<string, SetupRow['sig']> = {
    full: 'setupFull',
    close: 'setupClose',
    recovery: 'setupRecovery',
};

/** Build the day's setup rows from the scanned (momentum-evaluated) stocks. */
export function buildSetupRows(stocks: StockData[], scanDate: string): SetupRow[] {
    const rows: SetupRow[] = [];
    for (const s of stocks) {
        const level = s.momentum?.level;
        const sig = level ? LEVEL_TO_SIG[level] : undefined;
        if (!sig || s.lastPrice == null) continue;
        const rvol = s.projectedRvol ?? s.rvol ?? 0;
        const stage2: 0 | 1 = s.momentum?.criteria.stage2 ? 1 : 0;
        const rs = s.rsPercentile ?? null;
        const score = Math.round(
            SETUP_BASE[sig] + Math.min(rvol, 6) * 5 + (stage2 ? 20 : 0) + ((rs ?? 0) >= 90 ? 10 : 0)
        );
        rows.push({
            scanDate,
            ticker: s.ticker,
            region: regionOf(s.ticker),
            sector: s.sector ?? '',
            sig,
            rvol: Math.round(rvol * 100) / 100,
            athPct: s.pctFromAth != null ? Math.round(s.pctFromAth * 100) / 100 : null,
            dayPct: Math.round((s.priceChange ?? 0) * 100) / 100,
            stage2,
            score,
            price: s.lastPrice,
            rs,
        });
    }
    return rows;
}

/** RS percentile for every scanned stock — lets the dashboard show RS on lean rows too. */
export function buildRsRows(stocks: StockData[], scanDate: string): RsRow[] {
    return stocks
        .filter((s) => s.rsPercentile != null)
        .map((s) => ({ scanDate, ticker: s.ticker, rs: s.rsPercentile! }));
}

export interface D1Config {
    accountId: string;
    databaseId: string;
    apiToken: string;
}

interface Batch {
    sql: string;
    params: unknown[];
}

async function runBatch(batch: Batch, cfg: D1Config): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: batch.sql, params: batch.params }),
    });
    if (!res.ok) throw new Error(`D1 request failed ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { success: boolean; errors?: unknown };
    if (!body.success) throw new Error(`D1 error: ${JSON.stringify(body.errors)}`);
}

const SETUP_COLS =
    '(scan_date,ticker,region,sector,sig,rvol,ath_pct,day_pct,stage2,score,price,rs,ingested_at)';

/** D1 caps at 100 bound params/query: 13 cols × 7 = 91 for setup, 3 × 30 = 90 for rs. */
export function buildBatches(setupRows: SetupRow[], rsRows: RsRow[], stamp: string): Batch[] {
    const batches: Batch[] = [
        {
            sql: `CREATE TABLE IF NOT EXISTS setup_signals (
                scan_date TEXT NOT NULL, ticker TEXT NOT NULL, region TEXT, sector TEXT,
                sig TEXT NOT NULL, rvol REAL, ath_pct REAL, day_pct REAL, stage2 INTEGER,
                score INTEGER, price REAL, rs INTEGER, ingested_at TEXT,
                PRIMARY KEY (scan_date, ticker))`,
            params: [],
        },
        {
            sql: `CREATE TABLE IF NOT EXISTS rs_daily (
                scan_date TEXT NOT NULL, ticker TEXT NOT NULL, rs INTEGER,
                PRIMARY KEY (scan_date, ticker))`,
            params: [],
        },
    ];
    const dates = [...new Set([...setupRows, ...rsRows].map((r) => r.scanDate))];
    for (const d of dates) {
        batches.push({ sql: 'DELETE FROM setup_signals WHERE scan_date = ?', params: [d] });
        batches.push({ sql: 'DELETE FROM rs_daily WHERE scan_date = ?', params: [d] });
    }
    for (let i = 0; i < setupRows.length; i += 7) {
        const slice = setupRows.slice(i, i + 7);
        const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
        const params: unknown[] = [];
        for (const r of slice) {
            params.push(r.scanDate, r.ticker, r.region, r.sector, r.sig, r.rvol,
                r.athPct, r.dayPct, r.stage2, r.score, r.price, r.rs, stamp);
        }
        batches.push({ sql: `INSERT OR REPLACE INTO setup_signals ${SETUP_COLS} VALUES ${placeholders}`, params });
    }
    for (let i = 0; i < rsRows.length; i += 30) {
        const slice = rsRows.slice(i, i + 30);
        const placeholders = slice.map(() => '(?,?,?)').join(',');
        const params: unknown[] = [];
        for (const r of slice) params.push(r.scanDate, r.ticker, r.rs);
        batches.push({ sql: `INSERT OR REPLACE INTO rs_daily (scan_date,ticker,rs) VALUES ${placeholders}`, params });
    }
    return batches;
}

/**
 * Ingest the day's setup + RS rows into D1. Reads CF_* from env when `cfg`
 * is not provided. Returns true on success, false on skip/failure — NEVER throws.
 */
export async function ingestSetupToD1(
    stocks: StockData[],
    scanDate: string,
    cfg?: D1Config
): Promise<boolean> {
    try {
        const config: D1Config = cfg ?? {
            accountId: process.env.CF_ACCOUNT_ID ?? '',
            databaseId: process.env.D1_DATABASE_ID ?? '',
            apiToken: process.env.CF_API_TOKEN ?? '',
        };
        if (!config.accountId || !config.databaseId || !config.apiToken) {
            logger.info('📊 D1 setup ingest skipped (CF_* env not configured)');
            return false;
        }
        const setupRows = buildSetupRows(stocks, scanDate);
        const rsRows = buildRsRows(stocks, scanDate);
        const stamp = `setup-daily ${new Date().toISOString()}`;
        for (const batch of buildBatches(setupRows, rsRows, stamp)) {
            await runBatch(batch, config);
        }
        logger.info(`📊 D1 setup ingest: ${setupRows.length} setup rows + ${rsRows.length} RS rows for ${scanDate}`);
        return true;
    } catch (err) {
        logger.warn(`D1 setup ingest failed (non-fatal): ${(err as Error).message}`);
        return false;
    }
}
