/**
 * Watchlist (Google Sheets CSV) tests
 * Tests parseWatchlistCsv and fetchAndCacheWatchlist with mocked fetch
 */

import { parseWatchlistCsv, fetchWatchlistCsv, fetchAndCacheWatchlist, loadWatchlist, getSectorForTicker } from '../src/config/index';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as typeof fetch;

describe('parseWatchlistCsv', () => {
    it('parses CSV with header row and two columns', () => {
        const csv = 'Symbol,Sector\nAAPL,Technology\nMETA,Technology\nXOM,Energy';
        const result = parseWatchlistCsv(csv);
        expect(result.tickers).toHaveLength(3);
        expect(result.tickers[0]).toEqual({ symbol: 'AAPL', sector: 'Technology' });
        expect(result.tickers[1]).toEqual({ symbol: 'META', sector: 'Technology' });
        expect(result.tickers[2]).toEqual({ symbol: 'XOM', sector: 'Energy' });
        expect(result.invalidSkipped).toHaveLength(0);
    });

    it('skips first row when it looks like header (symbol/sector)', () => {
        const csv = 'symbol,sector\nGOOGL,Technology';
        const result = parseWatchlistCsv(csv);
        expect(result.tickers).toHaveLength(1);
        expect(result.tickers[0]).toEqual({ symbol: 'GOOGL', sector: 'Technology' });
    });

    it('defaults sector to Other when column B is empty', () => {
        const csv = 'NVDA,\nAMD,Technology';
        const result = parseWatchlistCsv(csv);
        expect(result.tickers[0]).toEqual({ symbol: 'NVDA', sector: 'Other' });
        expect(result.tickers[1]).toEqual({ symbol: 'AMD', sector: 'Technology' });
    });

    it('skips empty symbol rows', () => {
        const csv = 'Symbol,Sector\nAAPL,Tech\n,\nMETA,Tech';
        const result = parseWatchlistCsv(csv);
        expect(result.tickers).toHaveLength(2);
        expect(result.tickers[0].symbol).toBe('AAPL');
        expect(result.tickers[1].symbol).toBe('META');
    });

    it('handles CSV without header (no skip)', () => {
        const csv = 'AAPL,Technology\nMETA,Technology';
        const result = parseWatchlistCsv(csv);
        expect(result.tickers).toHaveLength(2);
        expect(result.tickers[0]).toEqual({ symbol: 'AAPL', sector: 'Technology' });
    });

    it('trims whitespace from cells', () => {
        const csv = '  AAPL  ,  Technology  ';
        const result = parseWatchlistCsv(csv);
        expect(result.tickers[0]).toEqual({ symbol: 'AAPL', sector: 'Technology' });
    });

    it('throws on empty CSV', () => {
        expect(() => parseWatchlistCsv('')).toThrow('Watchlist sheet is empty');
    });

    it('throws when no valid ticker rows', () => {
        const csv = 'Symbol,Sector\n,\n,';
        expect(() => parseWatchlistCsv(csv)).toThrow('Watchlist sheet has no valid ticker rows');
    });

    it('skips invalid ticker format and returns them in invalidSkipped', () => {
        const csv = 'Symbol,Sector\nAAPL,Technology\n../../etc,Tech\nMETA,Tech';
        const result = parseWatchlistCsv(csv);
        expect(result.tickers).toHaveLength(2);
        expect(result.tickers[0].symbol).toBe('AAPL');
        expect(result.tickers[1].symbol).toBe('META');
        expect(result.invalidSkipped).toEqual(['../../etc']);
    });

    it('supports international and longer tickers (extended regex)', () => {
        const csv = 'Symbol,Sector\n000660.KS,Tech\n8035.T,Tech\nBA.L,Ind\nBRK-B,Fin\n^TNX,Yield\nTABANKS5.TA,Fin\nVERY-LONG-TICKER-NAME.SUFFIX,Other\nCOBE,Other\nBT.A.L,Ind\nLONGER-TICKER-NAME-UP-TO-30-CHARS.US,Tech';
        const result = parseWatchlistCsv(csv);
        expect(result.tickers).toHaveLength(10);
        expect(result.tickers[0].symbol).toBe('000660.KS');
        expect(result.tickers[1].symbol).toBe('8035.T');
        expect(result.tickers[2].symbol).toBe('BA.L');
        expect(result.tickers[3].symbol).toBe('BRK-B');
        expect(result.tickers[4].symbol).toBe('^TNX');
        expect(result.tickers[5].symbol).toBe('TABANKS5.TA');
        expect(result.tickers[6].symbol).toBe('VERY-LONG-TICKER-NAME.SUFFIX');
        expect(result.tickers[7].symbol).toBe('COBE');
        expect(result.tickers[8].symbol).toBe('BT.A.L');
        expect(result.tickers[9].symbol).toBe('LONGER-TICKER-NAME-UP-TO-30-CHARS.US');
        expect(result.invalidSkipped).toHaveLength(0);
    });
});

// Valid-length fake Sheet ID (real IDs are ~44 chars; regex requires 20-60)
const VALID_SHEET_ID = '1A2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R9s0T';

describe('fetchWatchlistCsv', () => {
    it('returns response text on 200', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('Symbol,Sector\nAAPL,Tech') });
        const out = await fetchWatchlistCsv(VALID_SHEET_ID);
        expect(out).toBe('Symbol,Sector\nAAPL,Tech');
        expect(mockFetch).toHaveBeenCalledWith(
            `https://docs.google.com/spreadsheets/d/${VALID_SHEET_ID}/export?format=csv`,
            expect.any(Object)
        );
    });

    it('throws on invalid sheet ID format', async () => {
        await expect(fetchWatchlistCsv('short')).rejects.toThrow(/Invalid GOOGLE_SHEET_ID format/);
    });

    it('throws on non-2xx response', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });
        await expect(fetchWatchlistCsv(VALID_SHEET_ID)).rejects.toThrow(
            /Failed to fetch watchlist: 404/
        );
    });
});

describe('fetchAndCacheWatchlist', () => {
    const envKey = 'GOOGLE_SHEET_ID';

    beforeEach(() => {
        mockFetch.mockReset();
    });

    it('throws when GOOGLE_SHEET_ID is missing', async () => {
        const envBefore = process.env[envKey];
        process.env[envKey] = '   ';
        jest.resetModules();
        const mod = await import('../src/config/index.js');
        await expect(mod.fetchAndCacheWatchlist()).rejects.toThrow('GOOGLE_SHEET_ID is required');
        process.env[envKey] = envBefore;
        jest.resetModules();
    });

    it('fetches CSV and caches; loadWatchlist and getSectorForTicker use cache', async () => {
        const envBefore = process.env[envKey];
        process.env[envKey] = VALID_SHEET_ID;
        jest.resetModules();
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: () => Promise.resolve('Symbol,Sector\nAAPL,Technology\nMETA,Technology'),
        });
        const mod = await import('../src/config/index.js');
        await mod.fetchAndCacheWatchlist();
        expect(mod.loadWatchlist()).toEqual(['AAPL', 'META']);
        expect(mod.getSectorForTicker('AAPL')).toBe('Technology');
        expect(mod.getSectorForTicker('UNKNOWN')).toBe('Other');
        process.env[envKey] = envBefore;
        jest.resetModules();
    });

    it('getSectorForTicker returns sector (O(1) Map lookup)', async () => {
        const envBefore = process.env[envKey];
        process.env[envKey] = VALID_SHEET_ID;
        jest.resetModules();
        const csv =
            'Symbol,Sector\n' +
            Array.from({ length: 100 }, (_, i) => `T${i},Sector${i % 5}`).join('\n');
        mockFetch.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(csv) });
        const mod = await import('../src/config/index.js');
        await mod.fetchAndCacheWatchlist();
        expect(mod.getSectorForTicker('T50')).toBe('Sector0');
        expect(mod.getSectorForTicker('UNKNOWN')).toBe('Other');
        expect(mod.getSectorForTicker('t50')).toBe('Sector0'); // case insensitive
        process.env[envKey] = envBefore;
        jest.resetModules();
    });
});
