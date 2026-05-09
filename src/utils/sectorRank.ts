/**
 * Smart Volume Radar — Dynamic Sector Rank (Phase 4B, 2026-05-09).
 *
 * Inspired by championscan.com's "Top Groups" panel. Static sector labels
 * (from the Google Sheet watchlist) become a dynamic ranking based on the
 * median 63-day return of each sector's stocks within the watchlist.
 *
 * - Sectors with fewer than `MIN_SECTOR_SIZE` stocks are excluded (too noisy).
 * - Rank 1 = best-performing sector by median 63d return.
 * - Output is keyed by sector name (as it appears in StockData.sector).
 *
 * Pure & synchronous. Pipeline calls once per scan.
 */
import type { StockData } from '../types/index.js';

/** Minimum number of stocks in a sector to participate in the ranking. */
export const MIN_SECTOR_SIZE = 3;

export interface SectorRankInfo {
    /** 1-indexed rank, 1 = best 63-day median return. */
    rank: number;
    /** Number of stocks in this sector with valid `return63d`. */
    count: number;
    /** Median 63-day return for this sector, in % (e.g. +18.3). */
    median63d: number;
    /** Median 21-day return for this sector, in % (used for short-term context). */
    median21d: number | null;
}

function median(nums: number[]): number {
    if (nums.length === 0) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Compute sector ranks from a watchlist of StockData. Sectors with fewer
 * than `MIN_SECTOR_SIZE` qualifying stocks are excluded.
 *
 * @param stocks  Stocks with optional `return63d` / `return21d`. Stocks
 *                with missing `return63d` are ignored for ranking.
 * @returns       Map keyed by sector name → SectorRankInfo (rank 1 = best).
 */
export function computeSectorRanks(stocks: StockData[]): Map<string, SectorRankInfo> {
    type Bucket = { sector: string; ret63: number[]; ret21: number[] };
    const buckets = new Map<string, Bucket>();

    for (const s of stocks) {
        if (!s.sector) continue;
        if (s.return63d == null || !Number.isFinite(s.return63d)) continue;
        let b = buckets.get(s.sector);
        if (!b) {
            b = { sector: s.sector, ret63: [], ret21: [] };
            buckets.set(s.sector, b);
        }
        b.ret63.push(s.return63d);
        if (s.return21d != null && Number.isFinite(s.return21d)) {
            b.ret21.push(s.return21d);
        }
    }

    // Drop sectors below the minimum size.
    const eligible = Array.from(buckets.values()).filter(
        (b) => b.ret63.length >= MIN_SECTOR_SIZE
    );

    // Sort descending by 63d median; tie-break on count (larger sample wins).
    const ranked = eligible
        .map((b) => ({
            sector: b.sector,
            count: b.ret63.length,
            median63d: median(b.ret63),
            median21d: b.ret21.length > 0 ? median(b.ret21) : null,
        }))
        .sort((a, b) => {
            if (b.median63d !== a.median63d) return b.median63d - a.median63d;
            return b.count - a.count;
        });

    const result = new Map<string, SectorRankInfo>();
    ranked.forEach((row, i) => {
        result.set(row.sector, {
            rank: i + 1,
            count: row.count,
            median63d: row.median63d,
            median21d: row.median21d,
        });
    });
    return result;
}

/**
 * Apply the ranking to each stock — mutates `sectorRank`, `sectorMedianReturn63d`,
 * and `sectorTotalCount`. Stocks with missing/excluded sector are left untouched.
 *
 * Returns the ranking Map for further use (e.g. logging top-5).
 */
export function applySectorRanks(stocks: StockData[]): Map<string, SectorRankInfo> {
    const ranks = computeSectorRanks(stocks);
    for (const s of stocks) {
        if (!s.sector) continue;
        const info = ranks.get(s.sector);
        if (!info) continue;
        s.sectorRank = info.rank;
        s.sectorMedianReturn63d = info.median63d;
        s.sectorTotalCount = info.count;
    }
    return ranks;
}
