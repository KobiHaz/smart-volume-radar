/**
 * Market Data service tests — mocked fetch
 */

// Mock p-limit to avoid ESM import issues in Jest
jest.mock('p-limit', () => () => (fn: () => Promise<unknown>) => fn());

// Mock config (avoids Twelve Data fetch; uses defaults for Yahoo path)
jest.mock('../src/config/index.js', () => ({
    config: {
        useFetchedIndicators: false,
        twelveDataApiKey: '',
        forceScan: false,
        debug: false,
        athThresholdPct: 20,
        athCloseThresholdPct: 25,
        consolidationMinMonths: 6,
        consolidationMaxMonths: 36,
        consolidationCloseMinMonths: 4,
        sma21TouchThresholdPct: 3,
        sma21CloseThresholdPct: 5,
        formatPrecision: { price: 2, pct: 2, base: 2, rvol: 2, rsi: 0 },
    },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as typeof fetch;

import { fetchAllStocks } from '../src/services/marketData.js';
import logger from '../src/utils/logger.js';

function createYahooChartResponse(ticker: string): object {
    const volumes = Array(70).fill(1000000);
    const closes = Array(70).fill(100);
    closes[68] = 98;
    closes[69] = 102;
    return {
        chart: {
            result: [{
                meta: { regularMarketPrice: 102 },
                indicators: { quote: [{ volume: volumes, close: closes }] },
            }],
        },
    };
}

describe('fetchAllStocks', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it('returns stocks from Yahoo Chart when API succeeds', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(createYahooChartResponse('AAPL')),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['AAPL']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('AAPL');
        expect(stocks[0].rvol).toBeGreaterThan(0);
        expect(failedTickers).toHaveLength(0);
    });

    it('returns failedTickers and logs warning when all sources return no data', async () => {
        const emptyYahoo = { chart: { result: [] } };
        mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(emptyYahoo) });
        const warnSpy = jest.spyOn(logger, 'warn');

        const { stocks, failedTickers } = await fetchAllStocks(['BAD']);
        expect(stocks).toHaveLength(0);
        expect(failedTickers).toContain('BAD');
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('No data from any source (Yahoo or Twelve Data)')
        );
        warnSpy.mockRestore();
    });

    it('handles multiple tickers', async () => {
        const emptyYahoo = { chart: { result: [] } };
        mockFetch
            .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(createYahooChartResponse('AAPL')) })
            .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(emptyYahoo) });

        const { stocks, failedTickers } = await fetchAllStocks(['AAPL', 'FAIL']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('AAPL');
        expect(failedTickers).toContain('FAIL');
    });

    it('supports indices with no volume data (rvol=0)', async () => {
        const indexResponse = {
            chart: {
                result: [{
                    meta: { regularMarketPrice: 4000 },
                    indicators: { quote: [{ volume: [], close: [3900, 4000] }] },
                }],
            },
        };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(indexResponse),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['^TNX']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('^TNX');
        expect(stocks[0].rvol).toBe(0);
        expect(failedTickers).toHaveLength(0);
    });

    it('supports stocks with no volume data (rvol=0) instead of failing', async () => {
        const stockResponse = {
            chart: {
                result: [{
                    meta: { regularMarketPrice: 100 },
                    indicators: { quote: [{ volume: [], close: [98, 100] }] },
                }],
            },
        };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(stockResponse),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['COBE']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('COBE');
        expect(stocks[0].rvol).toBe(0);
        expect(failedTickers).toHaveLength(0);
    });

    it('supports stocks with only one day of price data (priceChange=0)', async () => {
        const stockResponse = {
            chart: {
                result: [{
                    meta: { regularMarketPrice: 100 },
                    indicators: { quote: [{ volume: [1000], close: [100] }] },
                }],
            },
        };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(stockResponse),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['NEW']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('NEW');
        expect(stocks[0].priceChange).toBe(0);
        expect(failedTickers).toHaveLength(0);
    });

    it('falls back from dot to dash for Yahoo tickers (e.g. BRK.B -> BRK-B)', async () => {
        // First call for BRK.B returns 404
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Second call for BRK-B (fallback) returns success
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(createYahooChartResponse('BRK-B')),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['BRK.B']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('BRK-B'); // The data returned is for the fallback ticker
        expect(failedTickers).toHaveLength(0);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('BRK.B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(2, expect.stringContaining('BRK-B'), expect.any(Object));
    });
});
