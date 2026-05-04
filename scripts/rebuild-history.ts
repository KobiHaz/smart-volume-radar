#!/usr/bin/env npx tsx
/**
 * Rebuild History — wipes legacy scan files + monitor-list, then runs the NEW
 * radar (Momentum Edition) on the last N trading days, saving:
 *   • results/scan-YYYY-MM-DD.json — full per-stock snapshot (new schema)
 *   • results/monitor-list.json    — rebuilt from scratch using day-by-day flow
 *
 * Optimization: fetches each ticker's 5y chart ONCE, then slices locally per date.
 * Same approach as backtest-watchlist.ts.
 *
 * Usage: npm run rebuild-history -- [--days 30] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   --days   number of trading days back from --to (default 30)
 *   --to     end date (default = last trading day)
 *   --from   alternative to --days; explicit start date
 *
 * Env: GOOGLE_SHEET_ID required.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';

import { fetchAndCacheWatchlist, loadWatchlist, getSectorForTicker } from '../src/config/index.js';
import { parseYahooChartResult } from '../src/services/marketData.js';
import { evaluateMomentumSetup } from '../src/utils/setup.js';
import { calculateSMA } from '../src/utils/technicalAnalysis.js';
import { getLastTradingDay } from '../src/utils/tradingDate.js';
import { buildScanResultDay, writeScanResultDay } from '../src/utils/scanResultWriter.js';
import { saveMonitorState } from '../src/utils/monitorStore.js';
import { updateMonitorState } from '../src/services/monitorTracker.js';
import type { MonitorState, StockData } from '../src/types/index.js';
import logger from '../src/utils/logger.js';

process.env.BACKTEST_MODE = '1'; // skip stale-data guard

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'results');

interface Args {
    days: number;
    from?: string;
    to: string;
}

function parseArgs(argv: string[]): Args {
    const out: Args = { days: 30, to: getLastTradingDay() };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--days' && argv[i + 1]) out.days = parseInt(argv[++i]!, 10);
        else if (argv[i] === '--from' && argv[i + 1]) out.from = argv[++i]!;
        else if (argv[i] === '--to' && argv[i + 1]) out.to = argv[++i]!;
    }
    return out;
}

interface RawChart {
    meta?: { regularMarketPrice?: number };
    timestamp?: number[];
    indicators?: {
        quote?: Array<{
            open?: (number | null)[];
            close?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            volume?: (number | null)[];
        }>;
    };
}

const COMMON_TYPO_FALLBACKS: Record<string, string> = { COBE: 'CBOE' };

async function fetchRawChart(ticker: string, retries = 1): Promise<RawChart | null> {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5y`;
        const res = await fetch(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
                Accept: 'application/json',
            },
        });
        if (!res.ok) {
            if (res.status === 404 && ticker.includes('.')) {
                return fetchRawChart(ticker.replace(/\./g, '-'), 0);
            }
            if (retries > 0) {
                await new Promise((r) => setTimeout(r, 400));
                return fetchRawChart(ticker, retries - 1);
            }
            return null;
        }
        const data = (await res.json()) as { chart?: { result?: RawChart[] } };
        return data?.chart?.result?.[0] ?? null;
    } catch {
        if (retries > 0) {
            await new Promise((r) => setTimeout(r, 400));
            return fetchRawChart(ticker, retries - 1);
        }
        return null;
    }
}

function sliceChart(raw: RawChart, asOfTimestamp: number): RawChart | null {
    const ts = raw.timestamp ?? [];
    let lastIdx = -1;
    for (let i = 0; i < ts.length; i++) {
        if (ts[i]! <= asOfTimestamp) lastIdx = i;
    }
    if (lastIdx < 0) return null;
    const sliceArr = <T>(arr: T[] | undefined): T[] => (arr ? arr.slice(0, lastIdx + 1) : []);
    const quote = raw.indicators?.quote?.[0];
    return {
        meta: { ...(raw.meta ?? {}), regularMarketPrice: undefined },
        timestamp: sliceArr(ts),
        indicators: {
            quote: [
                {
                    open: sliceArr(quote?.open),
                    close: sliceArr(quote?.close),
                    high: sliceArr(quote?.high),
                    low: sliceArr(quote?.low),
                    volume: sliceArr(quote?.volume),
                },
            ],
        },
    };
}

function tradingDays(from: string, to: string): string[] {
    const out: string[] = [];
    const cur = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T23:59:59Z');
    while (cur <= end) {
        const day = cur.getUTCDay();
        if (day >= 1 && day <= 5) out.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}

function dateToTs(date: string): number {
    return new Date(date + 'T23:59:59Z').getTime() / 1000;
}

function computeRegimeMap(spy: RawChart, dates: string[]): Map<string, 'bull' | 'bear'> {
    const out = new Map<string, 'bull' | 'bear'>();
    const ts = spy.timestamp ?? [];
    const rawCloses = spy.indicators?.quote?.[0]?.close ?? [];
    const closes: number[] = [];
    const validIndices: number[] = [];
    for (let i = 0; i < rawCloses.length; i++) {
        if (rawCloses[i] != null && rawCloses[i]! > 0) {
            closes.push(rawCloses[i]!);
            validIndices.push(i);
        }
    }
    for (const date of dates) {
        const cutoff = dateToTs(date);
        let lastValidIdx = -1;
        for (let j = 0; j < validIndices.length; j++) {
            if (ts[validIndices[j]!]! <= cutoff) lastValidIdx = j;
            else break;
        }
        if (lastValidIdx < 0) {
            out.set(date, 'bull');
            continue;
        }
        const closesUpTo = closes.slice(0, lastValidIdx + 1);
        if (closesUpTo.length < 200) {
            out.set(date, 'bull');
            continue;
        }
        const last = closesUpTo[closesUpTo.length - 1]!;
        const sma200 = calculateSMA(closesUpTo, 200);
        out.set(date, sma200 != null && last < sma200 ? 'bear' : 'bull');
    }
    return out;
}

function wipeLegacyResults(dir: string): { wiped: number; kept: string[] } {
    if (!fs.existsSync(dir)) return { wiped: 0, kept: [] };
    let wiped = 0;
    const kept: string[] = [];
    for (const name of fs.readdirSync(dir)) {
        if (
            name.startsWith('scan-') ||
            name.startsWith('scan-debug-') ||
            name === 'monitor-list.json'
        ) {
            fs.unlinkSync(path.join(dir, name));
            wiped++;
        } else {
            kept.push(name);
        }
    }
    return { wiped, kept };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!process.env.GOOGLE_SHEET_ID?.trim()) {
        process.stderr.write('GOOGLE_SHEET_ID required.\n');
        process.exit(2);
    }

    // Determine date range.
    let dates: string[];
    if (args.from) {
        dates = tradingDays(args.from, args.to);
    } else {
        // Walk back from --to to collect `args.days` trading days.
        const collected: string[] = [];
        const cur = new Date(args.to + 'T00:00:00Z');
        while (collected.length < args.days) {
            const day = cur.getUTCDay();
            if (day >= 1 && day <= 5) collected.push(cur.toISOString().slice(0, 10));
            cur.setUTCDate(cur.getUTCDate() - 1);
        }
        dates = collected.reverse();
    }

    process.stderr.write(`\n📋 Loading watchlist...\n`);
    await fetchAndCacheWatchlist();
    const tickers = loadWatchlist();
    process.stderr.write(`   ${tickers.length} tickers\n\n`);

    process.stderr.write(`🗑️  Wiping legacy results in ${RESULTS_DIR}...\n`);
    const { wiped, kept } = wipeLegacyResults(RESULTS_DIR);
    process.stderr.write(`   wiped ${wiped} files | kept ${kept.length} (${kept.slice(0, 3).join(', ')}${kept.length > 3 ? '...' : ''})\n\n`);

    process.stderr.write(`📅 Window: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} trading days)\n\n`);

    process.stderr.write(`🧭 Fetching SPY for regime computation...\n`);
    const spyRaw = await fetchRawChart('SPY');
    const regimeByDate = spyRaw
        ? computeRegimeMap(spyRaw, dates)
        : new Map(dates.map((d) => [d, 'bull' as const]));

    process.stderr.write(`📈 Fetching raw 5y charts for ${tickers.length} tickers (concurrency 5)...\n`);
    const limit = pLimit(5);
    const charts = new Map<string, RawChart>();
    const failedFetch: string[] = [];
    let done = 0;
    await Promise.all(
        tickers.map((t) =>
            limit(async () => {
                let raw = await fetchRawChart(t);
                if (!raw && COMMON_TYPO_FALLBACKS[t.toUpperCase()]) {
                    raw = await fetchRawChart(COMMON_TYPO_FALLBACKS[t.toUpperCase()]!);
                }
                if (raw) charts.set(t, raw);
                else failedFetch.push(t);
                done++;
                if (done % 50 === 0) process.stderr.write(`   ${done}/${tickers.length}\n`);
            })
        )
    );
    process.stderr.write(`   ✅ ${charts.size} fetched | ❌ ${failedFetch.length} failed\n\n`);

    // Initialize fresh monitor state.
    const monitorState: MonitorState = { lastUpdated: dates[0]!, entries: [] };

    process.stderr.write(`🔄 Running radar on ${dates.length} dates × ${charts.size} tickers...\n`);
    let totalAlerts = 0;
    for (const date of dates) {
        const dateStart = Date.now();
        const regime = regimeByDate.get(date) ?? 'bull';

        const stocksThisDay: StockData[] = [];
        const failedThisDay: string[] = [...failedFetch];
        for (const [ticker, raw] of charts) {
            const sliced = sliceChart(raw, dateToTs(date));
            if (!sliced) {
                failedThisDay.push(ticker);
                continue;
            }
            const stock = await parseYahooChartResult(
                sliced as Parameters<typeof parseYahooChartResult>[0],
                ticker,
                { skipTwelveData: true }
            );
            if (!stock) {
                failedThisDay.push(ticker);
                continue;
            }
            stock.marketRegime = regime;
            stock.momentum = evaluateMomentumSetup(stock, { regime });
            stock.sector = getSectorForTicker(stock.ticker);
            stocksThisDay.push(stock);
        }

        // Build + write scan day.
        const scanResult = buildScanResultDay({
            date,
            marketRegime: regime,
            watchlistTotal: tickers.length,
            fetchedSuccessfully: stocksThisDay.length,
            failedTickers: failedThisDay,
            stocks: stocksThisDay,
            scanTimeMs: Date.now() - dateStart,
        });
        writeScanResultDay(scanResult, RESULTS_DIR);

        // Update monitor state.
        const stocksByTicker = new Map<string, StockData>();
        for (const s of stocksThisDay) stocksByTicker.set(s.ticker.toUpperCase(), s);
        const summary = updateMonitorState(monitorState, stocksByTicker, date);

        const dayAlerts = scanResult.summary.full + scanResult.summary.recovery + scanResult.summary.watchlist;
        totalAlerts += dayAlerts;
        process.stderr.write(
            `   ${date}  regime=${regime}  ` +
            `🎯${scanResult.summary.full} 🦅${scanResult.summary.recovery} 👀${scanResult.summary.watchlist} ` +
            `→ monitor: +${summary.newEntries.length} new, ${summary.transitions.length} transitions, ${summary.activeCount} active\n`
        );
    }

    saveMonitorState(monitorState, RESULTS_DIR);

    process.stderr.write(`\n✅ Rebuild complete!\n`);
    process.stderr.write(`   Days: ${dates.length}\n`);
    process.stderr.write(`   Total alerts (Full+Recovery+WL): ${totalAlerts}\n`);
    process.stderr.write(`   Monitor entries: ${monitorState.entries.length} total\n`);
    const breakdown: Record<string, number> = {};
    for (const e of monitorState.entries) breakdown[e.status] = (breakdown[e.status] ?? 0) + 1;
    process.stderr.write(`   Status breakdown: ${JSON.stringify(breakdown)}\n`);
    process.stderr.write(`   Files written to ${RESULTS_DIR}/scan-*.json + monitor-list.json\n`);
    logger.info('rebuild-history finished');
}

main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
});
