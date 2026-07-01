/**
 * Market Data service tests — mocked fetch
 */

jest.setTimeout(30000);

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

import { fetchAllStocks, fetchYahooChartAsOfDate, fetchAllStocksAsOfDate } from '../src/services/marketData.js';
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
        // First call for BRK.B returns 404 (first try)
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Second call for BRK.B returns 404 (retry 1)
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Third call for BRK.B returns 404 (retry 2)
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Fourth call for BRK.B returns 404 (retry 3)
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Fifth call for BRK.B returns 404 (retry 4)
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Sixth call for BRK-B (fallback) returns success
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(createYahooChartResponse('BRK-B')),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['BRK.B']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('BRK.B'); // The data returned is always mapped to the original ticker
        expect(failedTickers).toHaveLength(0);
        expect(mockFetch).toHaveBeenCalledTimes(6);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('BRK.B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(2, expect.stringContaining('BRK.B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(3, expect.stringContaining('BRK.B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(4, expect.stringContaining('BRK.B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(5, expect.stringContaining('BRK.B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(6, expect.stringContaining('BRK-B'), expect.any(Object));
    });

    it('falls back to CBOE when COBE fails (typo fallback)', async () => {
        process.env.TWELVE_DATA_API_KEY = 'test-key';
        // 1. Yahoo Chart COBE -> 404 (x5 with retry)
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 2. Twelve Data COBE -> 404 (x5 with retry)
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 3. Yahoo Chart CBOE (typo fallback, first try) -> success
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(createYahooChartResponse('CBOE')),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['COBE']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('COBE'); // Mapped back to original
        expect(failedTickers).toHaveLength(0);
        // Yahoo(COBE)x5, Twelve(COBE)x5, Yahoo(CBOE)x1 = 11
        expect(mockFetch).toHaveBeenCalledTimes(11);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('COBE'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(11, expect.stringContaining('CBOE'), expect.any(Object));

        delete process.env.TWELVE_DATA_API_KEY;
    });

    it('falls back to BA.L when BA..L fails (typo fallback)', async () => {
        // 1. Yahoo Chart BA..L -> 404 (x5 with retry)
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 2. Yahoo Chart BA--L (dot-to-dash fallback, x5 with retry) -> 404
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 3. Yahoo Chart BA.L (typo fallback, first try) -> success
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(createYahooChartResponse('BA.L')),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['BA..L']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('BA..L'); // Mapped back to original
        expect(failedTickers).toHaveLength(0);
        // Calls: Yahoo(BA..L)x5, Yahoo(BA--L)x5, Yahoo(BA.L)x1 = 11
        expect(mockFetch).toHaveBeenCalledTimes(11);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('BA..L'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(11, expect.stringContaining('BA.L'), expect.any(Object));
    });

    it('falls back to multiple options (BAS.MI then BAS.DE) when BASF.MI fails', async () => {
        // 1. Yahoo Chart BASF.MI -> 404 (x5 with retry)
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 2. Yahoo Chart BASF-MI (dot-to-dash fallback, x5 with retry) -> 404
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 3. Yahoo Chart BAS.MI (typo fallback 1, x5 with retry) -> 404
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 4. Yahoo Chart BAS-MI (dot-to-dash fallback for fallback 1, x5 with retry) -> 404
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 5. Yahoo Chart BAS.DE (typo fallback 2, first try) -> success
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(createYahooChartResponse('BAS.DE')),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['BASF.MI']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('BASF.MI'); // Mapped back to original
        expect(failedTickers).toHaveLength(0);
        // Each 404 is retried: BASF.MI (x5), BASF-MI (x5), BAS.MI (x5), BAS-MI (x5), BAS.DE (x1) = 21
        expect(mockFetch).toHaveBeenCalledTimes(21);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('BASF.MI'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(6, expect.stringContaining('BASF-MI'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(11, expect.stringContaining('BAS.MI'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(21, expect.stringContaining('BAS.DE'), expect.any(Object));
    });

    it('falls back from dot to dash for Twelve Data (e.g. BRK.B -> BRK-B)', async () => {
        process.env.TWELVE_DATA_API_KEY = 'test-key';

        // 1. Yahoo Chart BRK.B -> 404 (x5 with retry)
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 2. Yahoo Chart BRK-B (dot-to-dash fallback) -> 404 (x5 with retry)
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 3. Twelve Data BRK.B -> 404 (x5 with retry)
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 4. Twelve Data BRK-B (dot-to-dash fallback) -> success
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                status: 'ok',
                close: '100',
                volume: '1000',
                percent_change: '1',
            }),
        });
        // 5 & 6. Indicators (RSI, SMA)
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ status: 'ok', values: [] }),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['BRK.B']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('BRK.B'); // Mapped back to original
        expect(failedTickers).toHaveLength(0);
        // Each Yahoo/Twelve 404 is retried: Yahoo(BRK.B)x5, Yahoo(BRK-B)x5, Twelve(BRK.B)x5, Twelve(BRK-B)x1 = 16
        expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(16);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('BRK.B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(2, expect.stringContaining('BRK.B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(3, expect.stringContaining('BRK.B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(4, expect.stringContaining('BRK.B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(5, expect.stringContaining('BRK.B'), expect.any(Object));
        // Twelve Data call for BRK.B is the 11th fetch call in this sequence
        expect(mockFetch.mock.calls[10][0]).toContain('BRK.B');
        // Twelve Data fallback call for BRK-B is the 16th fetch call
        expect(mockFetch.mock.calls[15][0]).toContain('BRK-B');

        delete process.env.TWELVE_DATA_API_KEY;
    });

    it('allows Twelve Data fallback for recent asOfDate (within 3 days)', async () => {
        process.env.TWELVE_DATA_API_KEY = 'test-key';

        // Mock current time to be stable for test
        const originalDateNow = Date.now;
        const mockNow = new Date('2026-07-01T12:00:00Z').getTime();
        Date.now = jest.fn(() => mockNow);

        // Yesterday's date
        const recentDate = '2026-06-30';

        // 1. Yahoo fails x10 (original + dash fallback)
        for (let i = 0; i < 10; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

        // 2. Twelve Data succeeds
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                status: 'ok',
                close: '15.00',
                volume: '500000',
                percent_change: '2.5',
            }),
        });
        // Indicators
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ status: 'ok', values: [] }),
        });

        const { stocks } = await fetchAllStocksAsOfDate(['EMBR3.SA'], recentDate);

        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('EMBR3.SA');

        // Verify Twelve Data was called
        let twelveDataCalled = false;
        for (let i = 0; i < mockFetch.mock.calls.length; i++) {
            if (mockFetch.mock.calls[i][0].includes('twelvedata')) {
                twelveDataCalled = true;
                break;
            }
        }
        expect(twelveDataCalled).toBe(true);

        Date.now = originalDateNow;
        delete process.env.TWELVE_DATA_API_KEY;
    });

    it('logs enhanced warning with .T and .KS suffixes when fetchAllStocks fails', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 404 });
        const warnSpy = jest.spyOn(logger, 'warn');

        await fetchAllStocks(['FAIL']);

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('exchange suffixes (e.g. .L, .SA, .TA, .T, .KS)')
        );
        warnSpy.mockRestore();
    });

    it('logs enhanced warning with .T and .KS suffixes when fetchAllStocksAsOfDate fails', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 404 });
        const warnSpy = jest.spyOn(logger, 'warn');

        await fetchAllStocksAsOfDate(['FAIL'], '2026-06-30');

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('exchange suffixes (e.g. .L, .SA, .TA, .T, .KS)')
        );
        warnSpy.mockRestore();
    });
});

describe('fetchYahooChartAsOfDate', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it('falls back from dot to dash (e.g. EMBR3.SA -> EMBR3-SA)', async () => {
        // First call for EMBR3.SA returns 404 (first try)
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Second call for EMBR3.SA returns 404 (retry 1)
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Third call for EMBR3.SA returns 404 (retry 2)
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Fourth call for EMBR3.SA returns 404 (retry 3)
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Fifth call for EMBR3.SA returns 404 (retry 4)
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Sixth call for EMBR3-SA (fallback) returns success
        const response = createYahooChartResponse('EMBR3-SA') as any;
        // Add timestamps for fetchYahooChartAsOfDate (fixed date to match asOfDate)
        response.chart.result[0].timestamp = [Date.parse('2026-06-30T12:00:00Z') / 1000];
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(response),
        });

        const stock = await fetchYahooChartAsOfDate('EMBR3.SA', '2026-06-30');
        expect(stock).not.toBeNull();
        expect(stock?.ticker).toBe('EMBR3.SA'); // Mapped back to original
        expect(mockFetch).toHaveBeenCalledTimes(6);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('EMBR3.SA'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(2, expect.stringContaining('EMBR3.SA'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(3, expect.stringContaining('EMBR3.SA'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(4, expect.stringContaining('EMBR3.SA'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(5, expect.stringContaining('EMBR3.SA'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(6, expect.stringContaining('EMBR3-SA'), expect.any(Object));
    });

    it('falls back from dash to dot (e.g. BRK-B -> BRK.B)', async () => {
        // First call for BRK-B returns 404 (first try)
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // Sixth call for BRK.B (fallback) returns success
        const response = createYahooChartResponse('BRK.B') as any;
        response.chart.result[0].timestamp = [Date.parse('2026-06-30T12:00:00Z') / 1000];
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(response),
        });

        const stock = await fetchYahooChartAsOfDate('BRK-B', '2026-06-30');
        expect(stock).not.toBeNull();
        expect(stock?.ticker).toBe('BRK-B'); // Mapped back to original
        expect(mockFetch).toHaveBeenCalledTimes(6);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('BRK-B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(6, expect.stringContaining('BRK.B'), expect.any(Object));
    });

    it('retries on transient errors with backoff', async () => {
        // First call fails with 500
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
        });
        // Second call fails with 429
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 429,
        });
        // Third call fails with 503
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 503,
        });
        // Fourth call succeeds
        const response = createYahooChartResponse('AAPL') as any;
        // Add timestamps for fetchYahooChartAsOfDate (fixed date to match asOfDate)
        response.chart.result[0].timestamp = [Date.parse('2026-06-30T12:00:00Z') / 1000];
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(response),
        });

        const stock = await fetchYahooChartAsOfDate('AAPL', '2026-06-30');
        expect(stock).not.toBeNull();
        expect(mockFetch).toHaveBeenCalledTimes(4);
    });

});

describe('fetchAllStocksAsOfDate', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it('falls back to Twelve Data and typo fallbacks', async () => {
        process.env.TWELVE_DATA_API_KEY = 'test-key';
        const todayUtc = new Date().toISOString().slice(0, 10);

        // 1. Yahoo(EMBR3.SA)x5 -> 404
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 2. Yahoo(EMBR3-SA)x5 (fallback) -> 404
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 3. TwelveData(EMBR3.SA)x5 -> 404
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 4. TwelveData(EMBR3-SA)x5 (fallback) -> 404
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

        // 5. Typo fallback: ERJ
        // Yahoo(ERJ)x5 -> 404
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // TwelveData(ERJ) -> Success
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                status: 'ok',
                close: '15.00',
                volume: '500000',
                percent_change: '2.5',
            }),
        });
        // Indicators
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ status: 'ok', values: [] }),
        });

        const { stocks, failedTickers } = await fetchAllStocksAsOfDate(['EMBR3.SA'], todayUtc);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('EMBR3.SA'); // Mapped back to original
        expect(failedTickers).toHaveLength(0);

        delete process.env.TWELVE_DATA_API_KEY;
    });

    it('skips Twelve Data fallback for historical asOfDate', async () => {
        process.env.TWELVE_DATA_API_KEY = 'test-key';
        const historicalDate = '2020-01-01';

        // Yahoo fails x10 (original + dash fallback)
        for (let i = 0; i < 10; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // Typo fallback ERJ also fails on Yahoo x5
        for (let i = 0; i < 5; i++) mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

        // It should NOT call Twelve Data at all because it's a historical date
        const { stocks, failedTickers } = await fetchAllStocksAsOfDate(['EMBR3.SA'], historicalDate);

        expect(stocks).toHaveLength(0);
        expect(failedTickers).toContain('EMBR3.SA');
        // Total Yahoo calls: 10 (EMBR3.SA) + 5 (ERJ) = 15. No Twelve Data calls.
        expect(mockFetch).toHaveBeenCalledTimes(15);
        for (let i = 1; i <= 15; i++) {
            expect(mockFetch.mock.calls[i-1][0]).not.toContain('twelvedata');
        }

        delete process.env.TWELVE_DATA_API_KEY;
    });
});
