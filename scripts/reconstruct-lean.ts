#!/usr/bin/env npx tsx
/**
 * Reconstruct the LEAN Radar's per-day output for every (ticker, day) in a
 * window up to N trading days back. Uses production code (parseYahooChartResult
 * + Lean detectors) on as-of date slices of Yahoo data.
 *
 * Output: results/lean-reconstructed-{date}.json
 * Schema: {
 *   generatedAt, daysComputed, tickersComputed,
 *   signalsByDate: { 'YYYY-MM-DD': { ticker: SignalRecord, ... } }
 * }
 *
 * Records every (ticker, day) where ANY Lean signal fired:
 *   - consolidationBreakout (main actionable signal)
 *   - consolidationNearMiss
 *   - highVolume (RVOL ≥ 3)
 *   - healthyPullback (-25% to -15% from ATH)
 *
 * Usage:
 *   BACKTEST_MODE=1 npx tsx scripts/reconstruct-lean.ts [--days 126] [--limit-tickers 50]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import {
    fetchAndCacheWatchlist,
    loadWatchlist,
    getSectorForTicker,
} from '../src/config/index.js';
import { parseYahooChartResult } from '../src/services/marketData.js';
import {
    detectConsolidationBreakout,
    detectConsolidationNearMiss,
    qualifiesAsHighVolume,
    qualifiesAsVolumeNearMiss,
    qualifiesAsHealthyPullback,
    qualifiesAsPullbackNearMiss,
    passesLeaderGate,
    isStage2,
} from '../src/lean/signals.js';
import type { StockData } from '../src/types/index.js';

process.env.BACKTEST_MODE = '1';

type SignalKind = 'breakout' | 'highVolume' | 'pullback' | 'nearBreakout' | 'nearHighVol' | 'nearPullback';

/** BASE weights — must match src/lean/dashboardRows.ts. Used to order `signals` desc. */
const BASE: Record<SignalKind, number> = {
    breakout: 50, pullback: 40, highVolume: 35,
    nearBreakout: 25, nearHighVol: 15, nearPullback: 10,
};

interface SignalRecord {
    sector: string;
    rvol: number;
    barGain: number;
    pctFromAth: number | null;
    lastPrice: number;
    isStage2: boolean;
    /** ALL matched signals for this (ticker, day), ordered by BASE desc. signals[0] = primary. */
    signals: SignalKind[];
    breakoutWindow: string | null;
    breakoutPivot: number | null;
    /** For nearBreakout (and breakout=0): % below the pivot. null for non-consolidation signals. */
    distanceToPivotPct: number | null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(PROJECT_ROOT, 'results');

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const DAYS = parseInt(arg('days', '126'), 10);
const LIMIT_TICKERS = parseInt(arg('limit-tickers', '0'), 10);

console.log(`═══ Lean Radar Reconstruction (last ${DAYS} td) ═══`);

type YahooChartResult = {
    meta?: { regularMarketPrice?: number; chartPreviousClose?: number };
    timestamp?: number[];
    indicators?: { quote?: Array<{ open?: (number | null)[]; close?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; volume?: (number | null)[] }> };
};

async function fetchYahoo2y(ticker: string): Promise<YahooChartResult | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2y`;
    try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
        if (!r.ok) return null;
        const data = (await r.json()) as { chart?: { result?: unknown[] } };
        const result = data?.chart?.result?.[0] as YahooChartResult | undefined;
        return result?.timestamp?.length ? result : null;
    } catch { return null; }
}

function sliceAsOf(result: YahooChartResult, asOfDate: string): YahooChartResult | null {
    const cutoff = new Date(asOfDate + 'T23:59:59Z').getTime() / 1000;
    const ts = result.timestamp ?? [];
    let lastIdx = -1;
    for (let i = ts.length - 1; i >= 0; i--) {
        if (ts[i]! <= cutoff) { lastIdx = i; break; }
    }
    if (lastIdx < 100) return null;
    const q = result.indicators?.quote?.[0] ?? {};
    return {
        meta: { ...result.meta, regularMarketPrice: undefined },
        timestamp: ts.slice(0, lastIdx + 1),
        indicators: {
            quote: [{
                open: q.open?.slice(0, lastIdx + 1),
                close: q.close?.slice(0, lastIdx + 1),
                high: q.high?.slice(0, lastIdx + 1),
                low: q.low?.slice(0, lastIdx + 1),
                volume: q.volume?.slice(0, lastIdx + 1),
            }],
        },
    };
}

function tsToDate(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

async function main() {
    console.log('📋 Loading watchlist...');
    await fetchAndCacheWatchlist();
    let tickers = loadWatchlist();
    if (LIMIT_TICKERS > 0) tickers = tickers.slice(0, LIMIT_TICKERS);
    console.log(`   ${tickers.length} tickers\n`);

    if (!tickers.includes('SPY')) tickers = ['SPY', ...tickers];

    console.log('🔎 Fetching Yahoo 2y (concurrency 8)...');
    const cache = new Map<string, YahooChartResult>();
    const limit = pLimit(8);
    let fetched = 0;
    let failed = 0;
    await Promise.all(tickers.map((t) => limit(async () => {
        const r = await fetchYahoo2y(t);
        fetched++;
        if (r) cache.set(t, r); else failed++;
        if (fetched % 50 === 0) process.stderr.write(`   ${fetched}/${tickers.length} fetched\n`);
    })));
    console.log(`   ✓ ${cache.size}/${tickers.length} cached (${failed} failed)\n`);

    const spy = cache.get('SPY');
    if (!spy) throw new Error('Could not fetch SPY for trading-day calendar');
    const allDates = (spy.timestamp ?? []).map(tsToDate);
    const asOfDates = allDates.slice(-DAYS);
    console.log(`📅 Window: ${asOfDates[0]} → ${asOfDates[asOfDates.length - 1]} (${asOfDates.length} td)\n`);

    console.log('⚙️  Computing per-day Lean signals...');
    const signalsByDate: Record<string, Record<string, SignalRecord>> = {};
    const summary: Record<string, number> = { breakout: 0, highVolume: 0, pullback: 0, nearBreakout: 0, nearHighVol: 0, nearPullback: 0 };

    for (let di = 0; di < asOfDates.length; di++) {
        const asOf = asOfDates[di]!;
        const dayRecords: Record<string, SignalRecord> = {};

        await Promise.all(tickers.map((t) => limit(async () => {
            if (t === 'SPY') return;
            const yr = cache.get(t);
            if (!yr) return;
            const sliced = sliceAsOf(yr, asOf);
            if (!sliced) return;
            const stock = await parseYahooChartResult(sliced as never, t, { skipTwelveData: true });
            if (!stock) return;
            stock.sector = getSectorForTicker(t) ?? undefined;

            // Extract aligned OHLCV arrays for the Lean detectors
            const q = sliced.indicators?.quote?.[0];
            const closes = (q?.close ?? []).filter((c): c is number => c != null && c > 0);
            const highs = (q?.high ?? []).filter((h): h is number => h != null && h > 0);
            const lows = (q?.low ?? []).filter((l): l is number => l != null && l > 0);
            if (closes.length < 60) return; // need at least 60 bars for 1M+3M windows

            // Run all Lean detectors
            const stage2 = isStage2(stock);
            const breakout = detectConsolidationBreakout(stock, closes, highs, lows);
            const nearBreakout = breakout ? null : detectConsolidationNearMiss(stock, closes, highs, lows);
            const highVol = qualifiesAsHighVolume(stock);
            const nearHighVol = highVol ? null : qualifiesAsVolumeNearMiss(stock);
            const rawPb = qualifiesAsHealthyPullback(stock);
            const pullback = rawPb && passesLeaderGate(stock, closes) ? rawPb : null;
            const nearPullback = pullback ? null : qualifiesAsPullbackNearMiss(stock);

            // Collect ALL matched signals for this (ticker, day).
            const matched: SignalKind[] = [];
            let breakoutWindow: string | null = null;
            let breakoutPivot: number | null = null;
            let distanceToPivotPct: number | null = null;
            if (breakout) {
                matched.push('breakout');
                breakoutWindow = breakout.window;
                breakoutPivot = breakout.windowHigh;
                distanceToPivotPct = 0;
            } else if (nearBreakout) {
                matched.push('nearBreakout');
                breakoutWindow = nearBreakout.window;
                breakoutPivot = nearBreakout.windowHigh;
                distanceToPivotPct = nearBreakout.distanceToPivotPct;
            }
            if (highVol) matched.push('highVolume');
            else if (nearHighVol) matched.push('nearHighVol');
            if (pullback) matched.push('pullback');
            else if (nearPullback) matched.push('nearPullback');

            if (matched.length) {
                const signals = [...matched].sort((a, b) => BASE[b] - BASE[a]);
                const primary = signals[0]!;
                summary[primary] = (summary[primary] ?? 0) + 1;
                dayRecords[t.toUpperCase()] = {
                    sector: stock.sector ?? 'Unknown',
                    rvol: stock.rvol ?? 0, // raw RVOL — matches what the radar classifies & displays (projectedRvol over-inflates in backtest)
                    barGain: stock.priceChange ?? 0,
                    pctFromAth: stock.pctFromAth ?? null,
                    lastPrice: stock.lastPrice,
                    isStage2: stage2,
                    signals,
                    breakoutWindow,
                    breakoutPivot,
                    distanceToPivotPct,
                };
            }
        })));

        signalsByDate[asOf] = dayRecords;
        if ((di + 1) % 10 === 0 || di === asOfDates.length - 1) {
            process.stderr.write(`   ${di + 1}/${asOfDates.length}  ${asOf}  signals=${Object.keys(dayRecords).length}\n`);
        }
    }

    const today = new Date().toISOString().slice(0, 10);
    const out = {
        generatedAt: new Date().toISOString(),
        daysComputed: asOfDates.length,
        tickersFetched: cache.size - 1,
        windowStart: asOfDates[0],
        windowEnd: asOfDates[asOfDates.length - 1],
        signalsByDate,
        summary,
    };
    const outPath = path.join(RESULTS_DIR, `lean-reconstructed-${today}.json`);
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`\n📁 Saved: ${outPath}`);

    // Also emit per-day flat dashboard rows for the D1 seed.
    const { rowsFromReconstructed } = await import('../src/lean/dashboardRows.js');
    const allRows = rowsFromReconstructed(out as never);
    const byDate = new Map<string, unknown[]>();
    for (const row of allRows) {
        const arr = byDate.get(row.scanDate) ?? [];
        arr.push(row);
        byDate.set(row.scanDate, arr);
    }
    for (const [d, rows] of byDate) {
        fs.writeFileSync(path.join(RESULTS_DIR, `dashboard-${d}.json`), JSON.stringify(rows));
    }
    console.log(`📊 Emitted ${byDate.size} dashboard-{date}.json files for seed`);
    console.log(`\n📊 Signal totals across ${asOfDates.length} days × ${cache.size - 1} stocks:`);
    for (const [k, v] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
        console.log(`   ${k.padEnd(18)} ${v}`);
    }
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
