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

    it('returns failedTickers when Yahoo returns no data', async () => {
        const emptyYahoo = { chart: { result: [] } };
        mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(emptyYahoo) });

        const { stocks, failedTickers } = await fetchAllStocks(['BAD']);
        expect(stocks).toHaveLength(0);
        expect(failedTickers).toContain('BAD');
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
});
