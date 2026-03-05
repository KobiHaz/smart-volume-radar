/**
 * Smart Volume Radar - Market Data Service
 * Uses direct HTTP requests to avoid library-specific rate limiting issues
 */

import { StockData } from '../types/index.js';

interface YahooChartResponse {
    chart: {
        result: Array<{
            meta: {
                regularMarketPrice?: number;
            };
            indicators: {
                quote: Array<{
                    volume: Array<number | null>;
                    close: Array<number | null>;
                }>;
            };
        }>;
    };
}

interface TwelveDataIndicatorResponse {
    status: string;
    values?: Array<{
        rsi?: string;
        sma?: string;
    }>;
}

interface TwelveDataQuoteResponse {
    status?: string;
    code?: number;
    message?: string;
    close?: string;
    volume?: string;
    average_volume?: string;
    percent_change?: string;
    fifty_two_week?: {
        high?: string;
    };
}
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { formatRVOL } from '../utils/formatters.js';
import pLimit from 'p-limit';
import { calculateSMA, calculateRSI, calculate52wHighAndConsolidation, isNearSMA } from '../utils/technicalAnalysis.js';

/**
 * Direct fetch from Yahoo Finance chart API
 * Uses 5y range for price history; 52w high and consolidation use last 252 days
 */
async function fetchFromYahooChart(ticker: string): Promise<StockData | null> {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5y`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            if (response.status === 429) {
                logger.warn(`⚠️ Yahoo Chart API rate limited for ${ticker}`);
            } else if (response.status === 404) {
                logger.warn(`❌ Ticker not found on Yahoo Chart: ${ticker}`);
            }
            return null;
        }

        const data = (await response.json()) as YahooChartResponse;
        const result = data.chart?.result?.[0];

        if (!result) {
            logger.warn(`No chart data for ${ticker}`);
            return null;
        }

        const meta = result.meta;
        const indicators = result.indicators?.quote?.[0];

        // Get volumes and closes (filter out nulls)
        const volumes = indicators?.volume?.filter((v: number | null): v is number => v !== null && v > 0) || [];
        const closes = indicators?.close?.filter((c: number | null): c is number => c !== null && c > 0) || [];

        const isIndex = ticker.startsWith('^');

        // Must have at least one price data point to be useful.
        // Returning null here marks ticker as "Failed to fetch" (e.g., truly empty response).
        if (closes.length < 1) return null;

        // Current volume is the last entry
        const currentVolume = volumes.length > 0 ? volumes[volumes.length - 1] : 0;

        // Average volume: 63-day SMA (industry standard ~3-month lookback for RVOL)
        const VOLUME_RVOL_LOOKBACK = 63;
        const historicalVolumes = volumes.length > 0 ? volumes.slice(0, -1) : [];
        const lookbackVolumes = historicalVolumes.slice(-VOLUME_RVOL_LOOKBACK);
        const avgVolume = lookbackVolumes.length > 0
            ? lookbackVolumes.reduce((a: number, b: number) => a + b, 0) / lookbackVolumes.length
            : 0;

        // Require 5+ volume days for a valid RVOL calculation (unless it's an index).
        // For stocks with insufficient volume history, we return them with rvol=0 to avoid "Failed to fetch" noise.
        const rvol = (isIndex || volumes.length >= 5) && avgVolume > 0 ? currentVolume / avgVolume : 0;

        // Calculate price change from close prices (requires at least 2 points for valid % change)
        const currentClose = closes[closes.length - 1];
        const previousClose = closes.length >= 2 ? closes[closes.length - 2] : 0;
        const priceChange = previousClose > 0 ? ((currentClose - previousClose) / previousClose) * 100 : 0;

        // Calculate Technical Indicators
        const sma21 = calculateSMA(closes, 21);
        const sma50 = calculateSMA(closes, 50);
        const sma200 = calculateSMA(closes, 200);
        const rsi = calculateRSI(closes, 14);

        const lastPrice = meta.regularMarketPrice || currentClose || 0;

        // 52-week high and consolidation (pre-breakout indicators)
        const athData = calculate52wHighAndConsolidation(closes);
        let ath: number | undefined;
        let pctFromAth: number | undefined;
        let monthsInConsolidation: number | undefined;
        let nearAth: boolean | undefined;
        let inConsolidationWindow: boolean | undefined;

        let nearAthClose: boolean | undefined;
        let inConsolidationClose: boolean | undefined;
        if (athData) {
            ath = athData.ath;
            pctFromAth = athData.pctFromAth;
            monthsInConsolidation = athData.monthsInConsolidation;
            const absPct = Math.abs(athData.pctFromAth);
            nearAth = absPct <= config.athThresholdPct;
            nearAthClose = absPct > config.athThresholdPct && absPct <= config.athCloseThresholdPct;
            inConsolidationWindow =
                athData.monthsInConsolidation >= config.consolidationMinMonths &&
                athData.monthsInConsolidation <= config.consolidationMaxMonths;
            inConsolidationClose = !inConsolidationWindow &&
                athData.monthsInConsolidation >= config.consolidationCloseMinMonths &&
                athData.monthsInConsolidation < config.consolidationMinMonths;
        }

        let finalSma21 = sma21;
        let finalRsi = rsi;

        if (config.useFetchedIndicators && process.env.TWELVE_DATA_API_KEY) {
            const fetched = await fetchIndicatorsFromTwelveData(ticker, process.env.TWELVE_DATA_API_KEY);
            if (fetched.rsi != null) finalRsi = fetched.rsi;
            if (fetched.sma21 != null) finalSma21 = fetched.sma21;
        }

        const nearSMA21 = finalSma21 ? isNearSMA(lastPrice, finalSma21, config.sma21TouchThresholdPct) : undefined;
        const nearSMA21Close = finalSma21 && !nearSMA21
            ? isNearSMA(lastPrice, finalSma21, config.sma21CloseThresholdPct)
            : undefined;

        return {
            ticker,
            currentVolume,
            avgVolume,
            rvol,
            priceChange,
            lastPrice,
            sma21: finalSma21,
            sma50,
            sma200,
            rsi: finalRsi,
            ath,
            athSource: '52w',
            pctFromAth,
            monthsInConsolidation,
            nearSMA21,
            nearAth,
            inConsolidationWindow,
            nearSMA21Close,
            nearAthClose,
            inConsolidationClose,
        };
    } catch (error) {
        logger.error(`❌ Chart fetch failed for ${ticker}:`, (error as Error).message);
        return null;
    }
}

/** Twelve Data API base */
const TWELVE_DATA_BASE = 'https://api.twelvedata.com';

/**
 * Fetch RSI and SMA21 from Twelve Data (pre-calculated, no local calculation)
 */
async function fetchIndicatorsFromTwelveData(
    ticker: string,
    apiKey: string
): Promise<{ rsi?: number; sma21?: number }> {
    const result: { rsi?: number; sma21?: number } = {};
    try {
        const encodedTicker = encodeURIComponent(ticker);
        const [rsiRes, smaRes] = await Promise.all([
            fetch(`${TWELVE_DATA_BASE}/rsi?symbol=${encodedTicker}&interval=1day&time_period=14&apikey=${apiKey}`),
            fetch(`${TWELVE_DATA_BASE}/sma?symbol=${encodedTicker}&interval=1day&time_period=21&series_type=close&apikey=${apiKey}`),
        ]);

        const rsiData = (await rsiRes.json()) as TwelveDataIndicatorResponse;
        if (rsiData.status === 'ok' && rsiData.values?.[0]?.rsi != null) {
            result.rsi = parseFloat(rsiData.values[0].rsi);
        }

        const smaData = (await smaRes.json()) as TwelveDataIndicatorResponse;
        if (smaData.status === 'ok' && smaData.values?.[0]?.sma != null) {
            result.sma21 = parseFloat(smaData.values[0].sma);
        }
    } catch {
        // Silently fall back to calculated values
    }
    return result;
}

/**
 * Fetch from Twelve Data API – fetches RSI, SMA21, 52w high when available
 */
async function fetchFromTwelveData(ticker: string): Promise<StockData | null> {
    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) return null;

    try {
        const url = `${TWELVE_DATA_BASE}/quote?symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}`;
        const response = await fetch(url);

        if (!response.ok) {
            if (response.status === 429) {
                logger.warn(`⚠️ Twelve Data API rate limited for ${ticker}`);
            } else if (response.status === 404) {
                logger.warn(`❌ Ticker not found on Twelve Data: ${ticker}`);
            }
            return null;
        }

        const data = (await response.json()) as TwelveDataQuoteResponse;

        if (data.status === 'error') {
            if (data.code === 429) {
                logger.warn(`⚠️ Twelve Data API rate limited for ${ticker}: ${data.message}`);
            } else if (data.code === 404) {
                logger.warn(`❌ Ticker not found on Twelve Data: ${ticker}: ${data.message}`);
            } else {
                logger.warn(`❌ Twelve Data error for ${ticker}: ${data.message}`);
            }
            return null;
        }

        if (!data.close) {
            return null;
        }

        const volume = parseFloat(data.volume || '0') || 0;
        const avgVolume = parseFloat(data.average_volume || data.volume || '1') || 1;
        const lastPrice = parseFloat(data.close || '0') || 0;
        const fiftyTwoWeek = data.fifty_two_week;
        const high52w = fiftyTwoWeek?.high != null ? parseFloat(fiftyTwoWeek.high) : undefined;

        let rsi: number | undefined;
        let sma21: number | undefined;
        const fetchedIndicators = await fetchIndicatorsFromTwelveData(ticker, apiKey);
        rsi = fetchedIndicators.rsi;
        sma21 = fetchedIndicators.sma21;

        const ath = high52w;
        const pctFromAth = ath != null && ath > 0 ? ((lastPrice - ath) / ath) * 100 : undefined;
        const absPct = pctFromAth != null ? Math.abs(pctFromAth) : Infinity;
        const nearAth = pctFromAth != null && absPct <= config.athThresholdPct;
        const nearAthClose = pctFromAth != null && absPct > config.athThresholdPct && absPct <= config.athCloseThresholdPct;

        const nearSMA21 = sma21 ? isNearSMA(lastPrice, sma21, config.sma21TouchThresholdPct) : undefined;
        const nearSMA21Close = sma21 && !nearSMA21 ? isNearSMA(lastPrice, sma21, config.sma21CloseThresholdPct) : undefined;

        return {
            ticker,
            currentVolume: volume,
            avgVolume,
            rvol: volume / avgVolume,
            priceChange: parseFloat(data.percent_change || '0') || 0,
            lastPrice,
            sma21,
            rsi,
            ath,
            athSource: '52w',
            pctFromAth,
            nearSMA21,
            nearAth,
            nearAthClose,
            nearSMA21Close,
        };
    } catch (error) {
        logger.error(`❌ Twelve Data fetch failed for ${ticker}:`, (error as Error).message);
        return null;
    }
}

export interface FetchAllStocksResult {
    stocks: StockData[];
    failedTickers: string[];
}

/**
 * Fetch all stocks with multiple fallback strategies
 */
export async function fetchAllStocks(tickers: string[]): Promise<FetchAllStocksResult> {
    logger.info(`🚀 Starting fetch for ${tickers.length} tickers using concurrency...`);

    // Limit concurrency to avoid aggressive rate limiting from Yahoo/Twelve Data
    const limit = pLimit(3);
    const results: StockData[] = [];
    const failedTickers: string[] = [];

    const tasks = tickers.map((ticker, index) => limit(async () => {
        logger.info(`[${index + 1}/${tickers.length}] Fetching ${ticker}...`);

        // Try Yahoo Chart API first
        let result = await fetchFromYahooChart(ticker);
        let successSource = 'Yahoo Chart';

        if (!result) {
            // Try Twelve Data as fallback
            result = await fetchFromTwelveData(ticker);
            successSource = 'Twelve Data';
        }

        if (result) {
            logger.info(`✅ ${ticker}: RVOL=${formatRVOL(result.rvol)} (${successSource})`);
            return { ticker, data: result };
        } else {
            logger.warn(`❌ ${ticker}: No data from any source`);
            return { ticker, data: null };
        }
    }));

    const fetchResults = await Promise.all(tasks);

    fetchResults.forEach((res) => {
        if (res.data) {
            results.push(res.data);
        } else {
            failedTickers.push(res.ticker);
        }
    });

    logger.info(`📊 Final: ${results.length}/${tickers.length} stocks fetched successfully`);
    if (failedTickers.length > 0) {
        logger.warn(`⚠️ Failed to fetch: ${failedTickers.join(', ')}`);
    }
    return { stocks: results, failedTickers };
}
