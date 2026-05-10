/**
 * Smart Volume Radar — Snapshot Writer (2026-05-10).
 *
 * Writes a full per-run debug snapshot for either scanner:
 *
 *   results/radar-{YYYY-MM-DD}.json   — Radar (main branch)
 *   results/lean-{YYYY-MM-DD}.json    — Lean Radar (stable branch)
 *
 * Each snapshot captures the complete computed StockData for every ticker
 * (all derived fields: rvol, sma, rsi, score, action, criteria, sector rank,
 * fundamentals etc.) plus run-level metadata. Snapshots are gitignored —
 * persisted via the GitHub Actions artifact mechanism (365-day retention).
 *
 * For Radar additionally captures action distribution and how many stocks
 * went to Telegram.
 *
 * For Lean Radar additionally captures the detection breakdown: which
 * windows of consolidation, which volume tier, which pullback bucket each
 * stock was classified into.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ActionLabel, StockData } from '../types/index.js';

/** Shared metadata captured in every snapshot. */
export interface SnapshotMeta {
    scanner: 'radar' | 'lean-radar';
    scanDate: string;
    runStartedAt: string;
    version: string;
    /** Optional — Lean Radar doesn't compute regime; Radar does. */
    marketRegime?: 'bull' | 'bear';
    watchlist: {
        total: number;
        fetched: number;
        failed: string[];
    };
    topSectors?: Array<{ sector: string; rank: number; median63d: number; count: number }>;
}

/** Radar-specific snapshot (main scanner). */
export interface RadarSnapshot extends SnapshotMeta {
    scanner: 'radar';
    actionDistribution: Record<string, number>;
    telegramSentCount: number;
    stocks: StockData[];
}

/** Lean Radar snapshot fields specific to its 3-signal architecture. */
export interface LeanSnapshot extends SnapshotMeta {
    scanner: 'lean-radar';
    detections: {
        consolidationBreakouts: Array<{ ticker: string; window: string; baseRangePct: number; windowHigh: number }>;
        highVolume: Array<{ ticker: string; level: 'high' | 'extreme'; rvol: number }>;
        pullbacks: Array<{ ticker: string; pctFromAth: number }>;
        nearConsolidation: Array<{ ticker: string; window: string; distanceToPivotPct: number }>;
        nearVolume: Array<{ ticker: string; rvol: number }>;
        nearPullback: Array<{ ticker: string; pctFromAth: number }>;
    };
    stocks: StockData[];
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Strip large/redundant fields from a StockData before serializing.
 * - `news` array (~10-30 entries) is omitted (we have it elsewhere if needed).
 * - Other fields kept intact for full debug fidelity.
 */
function sanitizeStock(s: StockData): Record<string, unknown> {
    const { ...rest } = s;
    // RVOLResult has `news` and `isVolumeWithoutPrice`; both noisy for debug.
    const out: Record<string, unknown> = { ...rest };
    delete out.news;
    delete out.isVolumeWithoutPrice;
    return out;
}

/**
 * Write a Radar snapshot. Returns the absolute path written, or null when
 * `stocks` is empty (no scan happened).
 */
export function writeRadarSnapshot(
    snapshot: Omit<RadarSnapshot, 'scanner'>,
    outDir: string
): string | null {
    if (snapshot.stocks.length === 0) return null;
    ensureDir(outDir);
    const payload: RadarSnapshot = { scanner: 'radar', ...snapshot };
    const file = path.join(outDir, `radar-${snapshot.scanDate}.json`);
    const serialized = JSON.stringify(
        { ...payload, stocks: payload.stocks.map(sanitizeStock) },
        (_, v) => (v instanceof Date ? v.toISOString() : v),
        2
    );
    fs.writeFileSync(file, serialized, 'utf-8');
    return file;
}

/**
 * Write a Lean Radar snapshot. Returns the absolute path written, or null
 * when `stocks` is empty.
 */
export function writeLeanSnapshot(
    snapshot: Omit<LeanSnapshot, 'scanner'>,
    outDir: string
): string | null {
    if (snapshot.stocks.length === 0) return null;
    ensureDir(outDir);
    const payload: LeanSnapshot = { scanner: 'lean-radar', ...snapshot };
    const file = path.join(outDir, `lean-${snapshot.scanDate}.json`);
    const serialized = JSON.stringify(
        { ...payload, stocks: payload.stocks.map(sanitizeStock) },
        (_, v) => (v instanceof Date ? v.toISOString() : v),
        2
    );
    fs.writeFileSync(file, serialized, 'utf-8');
    return file;
}

/** Compute the action distribution for use in RadarSnapshot. */
export function computeActionDistribution(stocks: StockData[]): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const s of stocks) {
        const a: ActionLabel | undefined = s.action;
        const key = a ?? 'NO_ACTION';
        dist[key] = (dist[key] ?? 0) + 1;
    }
    return dist;
}
