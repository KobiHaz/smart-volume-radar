/**
 * Tests for the dynamic sector rank utility.
 */
import { computeSectorRanks, applySectorRanks, MIN_SECTOR_SIZE } from '../src/utils/sectorRank';
import type { StockData } from '../src/types';

const mk = (ticker: string, sector: string | undefined, return63d: number | undefined, return21d?: number): StockData => ({
    ticker,
    currentVolume: 1,
    avgVolume: 1,
    rvol: 1,
    priceChange: 0,
    lastPrice: 100,
    sector,
    return63d,
    return21d,
});

describe('computeSectorRanks', () => {
    it('ranks sectors by median 63d return descending', () => {
        const stocks = [
            mk('A', 'Tech', 10),
            mk('B', 'Tech', 20),
            mk('C', 'Tech', 30),
            mk('D', 'Energy', 50),
            mk('E', 'Energy', 60),
            mk('F', 'Energy', 70),
            mk('G', 'Banks', -5),
            mk('H', 'Banks', 0),
            mk('I', 'Banks', 5),
        ];
        const r = computeSectorRanks(stocks);
        expect(r.get('Energy')!.rank).toBe(1);  // median 60
        expect(r.get('Tech')!.rank).toBe(2);    // median 20
        expect(r.get('Banks')!.rank).toBe(3);   // median 0
    });

    it(`excludes sectors with fewer than ${MIN_SECTOR_SIZE} stocks`, () => {
        const stocks = [
            mk('A', 'Tech', 50),
            mk('B', 'Tech', 60), // only 2 — below MIN_SECTOR_SIZE
            mk('C', 'Energy', 5),
            mk('D', 'Energy', 10),
            mk('E', 'Energy', 15),
        ];
        const r = computeSectorRanks(stocks);
        expect(r.has('Tech')).toBe(false);
        expect(r.get('Energy')!.rank).toBe(1);
    });

    it('ignores stocks with missing return63d', () => {
        const stocks = [
            mk('A', 'Tech', undefined),
            mk('B', 'Tech', 10),
            mk('C', 'Tech', 20),
            mk('D', 'Tech', 30),
        ];
        const r = computeSectorRanks(stocks);
        expect(r.get('Tech')!.count).toBe(3); // A skipped
    });

    it('handles ties — larger count wins tiebreak', () => {
        const stocks = [
            mk('A', 'Tech', 10),
            mk('B', 'Tech', 10),
            mk('C', 'Tech', 10),
            mk('D', 'Tech', 10),  // 4 stocks, median 10
            mk('E', 'Energy', 10),
            mk('F', 'Energy', 10),
            mk('G', 'Energy', 10),  // 3 stocks, median 10
        ];
        const r = computeSectorRanks(stocks);
        // Tie on median; Tech has more stocks, wins.
        expect(r.get('Tech')!.rank).toBe(1);
        expect(r.get('Energy')!.rank).toBe(2);
    });

    it('computes 21d median when available', () => {
        const stocks = [
            mk('A', 'Tech', 10, 5),
            mk('B', 'Tech', 20, 8),
            mk('C', 'Tech', 30, 11),
        ];
        const r = computeSectorRanks(stocks);
        expect(r.get('Tech')!.median21d).toBe(8);
    });

    it('returns null median21d when none of the stocks have return21d', () => {
        const stocks = [
            mk('A', 'Tech', 10),
            mk('B', 'Tech', 20),
            mk('C', 'Tech', 30),
        ];
        const r = computeSectorRanks(stocks);
        expect(r.get('Tech')!.median21d).toBeNull();
    });

    it('returns empty map when no sectors qualify', () => {
        const stocks = [mk('A', 'Tech', 10), mk('B', 'Banks', 5)];
        const r = computeSectorRanks(stocks);
        expect(r.size).toBe(0);
    });
});

describe('applySectorRanks (mutating)', () => {
    it('mutates sectorRank, sectorMedianReturn63d, sectorTotalCount on each stock', () => {
        const stocks = [
            mk('A', 'Tech', 10),
            mk('B', 'Tech', 20),
            mk('C', 'Tech', 30),
            mk('D', 'Energy', 50),
            mk('E', 'Energy', 60),
            mk('F', 'Energy', 70),
        ];
        applySectorRanks(stocks);
        expect(stocks[0]!.sectorRank).toBe(2); // Tech
        expect(stocks[3]!.sectorRank).toBe(1); // Energy
        expect(stocks[0]!.sectorTotalCount).toBe(3);
        expect(stocks[0]!.sectorMedianReturn63d).toBe(20);
    });

    it('leaves stocks without sector / return63d untouched', () => {
        const stocks = [
            mk('A', undefined, 50),
            mk('B', 'Tech', undefined),
            mk('C', 'Tech', 20),
            mk('D', 'Tech', 30),
            mk('E', 'Tech', 40),
        ];
        applySectorRanks(stocks);
        expect(stocks[0]!.sectorRank).toBeUndefined();
        expect(stocks[1]!.sectorRank).toBe(1); // Tech still has 3 valid stocks
        expect(stocks[1]!.sectorMedianReturn63d).toBe(30);
    });
});
