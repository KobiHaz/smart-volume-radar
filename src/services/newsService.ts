/**
 * Smart Volume Radar - News Service
 * Fetches financial news from Finnhub API
 */

import { NewsItem, FinnhubNewsResponse } from '../types/index.js';
import { config } from '../config/index.js';
import { sleep } from '../utils/errorHandler.js';
import logger from '../utils/logger.js';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const xmlParser = new XMLParser();

let _israeliNamesCache: Record<string, string> | null = null;

function getIsraeliNames(): Record<string, string> {
    if (_israeliNamesCache !== null) return _israeliNamesCache;
    const namesPath = path.join(__dirname, '..', 'config', 'israeliNames.json');
    _israeliNamesCache = JSON.parse(fs.readFileSync(namesPath, 'utf-8')) as Record<string, string>;
    return _israeliNamesCache;
}

/**
 * Format date for Finnhub API (YYYY-MM-DD)
 */
function formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
}

/**
 * Fetch news articles for a single stock
 * @param ticker - Stock ticker symbol
 * @returns Array of news items (max 3)
 */
export async function fetchNewsForStock(ticker: string): Promise<NewsItem[]> {
    const { finnhubApiKey } = config;

    if (!finnhubApiKey) {
        logger.warn(`Skipping news fetch for ${ticker}: No Finnhub API key`);
        return [];
    }

    if (ticker.endsWith('.TA')) {
        // TASE stocks are not supported by Finnhub free tier or return 403
        return [];
    }

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${formatDate(yesterday)}&to=${formatDate(now)}&token=${finnhubApiKey}`;

    try {
        const response = await fetch(url);

        if (!response.ok) {
            // Rate limit or other API error
            if (response.status === 429) {
                logger.warn(`Rate limited on Finnhub for ${ticker}, skipping news`);
            } else {
                logger.warn(`Finnhub API error for ${ticker}: ${response.status}`);
            }
            return [];
        }

        const data = (await response.json()) as FinnhubNewsResponse[];

        // Take top 3 most recent articles
        return data.slice(0, 3).map((item) => ({
            headline: item.headline,
            url: item.url,
            source: item.source,
            publishedAt: new Date(item.datetime * 1000),
        }));
    } catch (error) {
        logger.error(`Failed to fetch news for ${ticker}`, error);
        return [];
    }
}

/**
 * Fetch news from Google News RSS for Israeli stocks
 */
export async function fetchHebrewNews(ticker: string): Promise<NewsItem[]> {
    const israeliNames = getIsraeliNames();
    const name = israeliNames[ticker] || ticker.replace('.TA', '');
    const query = encodeURIComponent(`${name} מניה`);
    const url = `https://news.google.com/rss/search?q=${query}&hl=iw&gl=IL&ceid=IL:iw`;

    try {
        const response = await fetch(url);
        if (!response.ok) return [];

        const xmlData = await response.text();
        const jsonObj = xmlParser.parse(xmlData);
        const items = jsonObj?.rss?.channel?.item;

        if (!items) return [];

        // Normalize to array
        const newsItems = Array.isArray(items) ? items : [items];

        interface RssItem { title?: string; link?: string; source?: { '#text'?: string }; pubDate?: string }
        return newsItems.slice(0, 3)
            .filter((item: RssItem) => item.title && item.pubDate)
            .map((item: RssItem) => ({
                headline: item.title!,
                url: item.link ?? '',
                source: item.source?.['#text'] ?? 'Google News',
                publishedAt: new Date(item.pubDate!),
            }));
    } catch (error) {
        logger.error(`Failed to fetch Hebrew news for ${ticker}`, error);
        return [];
    }
}

/**
 * Enrich stocks with news data
 */
export async function enrichWithNews<T extends { ticker: string }>(
    stocks: T[]
): Promise<(T & { news: NewsItem[]; isVolumeWithoutPrice: boolean })[]> {
    logger.info(`Enriching ${stocks.length} stocks with news using concurrency...`);

    // Finnhub free tier is 60 calls/min. We use a concurrency of 2 
    // to speed up but still leave room for the newsDelayMs if needed.
    const limit = pLimit(2);
    const { newsDelayMs } = config;

    const tasks = stocks.map((stock) => limit(async () => {
        let news: NewsItem[] = [];

        try {
            if (stock.ticker.endsWith('.TA')) {
                news = await fetchHebrewNews(stock.ticker);
            } else {
                news = await fetchNewsForStock(stock.ticker);
            }
        } catch (error) {
            logger.error(`Error fetching news for ${stock.ticker}`, error);
        }

        // Add a small delay for Finnhub's minute-based rate limit if we have many stocks
        if (stocks.length > 30) {
            await sleep(newsDelayMs || 1000);
        }

        return {
            ...stock,
            news,
            isVolumeWithoutPrice: false, // Default, overwritten by caller
        };
    }));

    const results = await Promise.all(tasks);

    const totalNews = results.reduce((sum, s) => sum + s.news.length, 0);
    logger.info(`Fetched ${totalNews} news articles total`);

    return results;
}
