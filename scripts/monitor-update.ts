#!/usr/bin/env npx tsx
/**
 * Monitor Update — runs a fresh scan, updates the persistent monitor list,
 * and prints a follow-up summary (graduations / entry candidates / active monitors).
 *
 * Designed to run daily after the market close. State persists in
 * `results/monitor-list.json`.
 *
 * Usage:  npx tsx scripts/monitor-update.ts [--asof YYYY-MM-DD]
 *   --asof  Optional date (defaults to last US trading day).
 *
 * Env: GOOGLE_SHEET_ID required.
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAndCacheWatchlist, loadWatchlist, getSectorForTicker } from '../src/config/index.js';
import { fetchAllStocksAsOfDate, fetchMarketRegime } from '../src/services/marketData.js';
import { evaluateMomentumSetup } from '../src/utils/setup.js';
import { getLastTradingDay } from '../src/utils/tradingDate.js';
import { loadMonitorState, saveMonitorState } from '../src/utils/monitorStore.js';
import { updateMonitorState } from '../src/services/monitorTracker.js';
import type { MonitorEntry, MonitorStatus, StockData } from '../src/types/index.js';

process.env.BACKTEST_MODE = '1'; // skip stale guard so weekend re-runs work

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'results');

function parseAsOf(argv: string[]): string {
    const i = argv.indexOf('--asof');
    if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
    return getLastTradingDay();
}

function fmtPct(n: number | undefined | null): string {
    if (n == null || !Number.isFinite(n)) return '   —';
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
}

function returnPct(entry: MonitorEntry, currentPrice: number | undefined): number | null {
    if (!currentPrice || entry.firstAlertPrice <= 0) return null;
    return ((currentPrice - entry.firstAlertPrice) / entry.firstAlertPrice) * 100;
}

function statusEmoji(s: MonitorStatus): string {
    switch (s) {
        case 'monitoring':
            return '👀';
        case 'graduated':
            return '🎓🎯';
        case 'manual-entry':
            return '🟢';
        case 'sma21-pullback':
            return '📐';
        case 'expired':
            return '🗑️';
        case 'stopped':
            return '🛑';
    }
}

async function main(): Promise<void> {
    const asOf = parseAsOf(process.argv.slice(2));
    if (!process.env.GOOGLE_SHEET_ID?.trim()) {
        process.stderr.write('GOOGLE_SHEET_ID required.\n');
        process.exit(2);
    }

    process.stderr.write(`📋 Loading watchlist from Google Sheet...\n`);
    await fetchAndCacheWatchlist();
    const tickers = loadWatchlist();
    process.stderr.write(`   ${tickers.length} tickers\n\n`);

    process.stderr.write(`📁 Loading existing monitor list...\n`);
    const state = loadMonitorState(RESULTS_DIR);
    const beforeActive = state.entries.filter((e) => e.status === 'monitoring').length;
    process.stderr.write(`   ${state.entries.length} total entries | ${beforeActive} active monitors\n\n`);

    process.stderr.write(`🧭 Fetching SPY regime as of ${asOf}...\n`);
    const regime = await fetchMarketRegime(asOf);
    process.stderr.write(`   Market regime: ${regime.toUpperCase()}\n\n`);

    process.stderr.write(`📊 Scanning ${tickers.length} stocks as of ${asOf}...\n`);
    const { stocks, failedTickers } = await fetchAllStocksAsOfDate(tickers, asOf);
    process.stderr.write(`   ✅ ${stocks.length} fetched | ❌ ${failedTickers.length} failed\n\n`);

    const stocksByTicker = new Map<string, StockData>();
    for (const s of stocks) {
        s.marketRegime = regime;
        s.momentum = evaluateMomentumSetup(s, { regime });
        s.sector = getSectorForTicker(s.ticker);
        stocksByTicker.set(s.ticker.toUpperCase(), s);
    }

    process.stderr.write(`🔄 Updating monitor state...\n`);
    const summary = updateMonitorState(state, stocksByTicker, asOf);

    saveMonitorState(state, RESULTS_DIR);
    process.stderr.write(`   💾 Saved to ${path.join(RESULTS_DIR, 'monitor-list.json')}\n\n`);

    // ─── Telegram-style report ─────────────────────────────────────────
    process.stderr.write(`\n========== MONITOR UPDATE — ${asOf} ==========\n\n`);

    // 1. Graduations & manual entries (today's actionable signals)
    const actionable = summary.transitions.filter((t) =>
        ['graduated', 'manual-entry', 'sma21-pullback'].includes(t.newStatus ?? '')
    );
    if (actionable.length > 0) {
        process.stderr.write(`🚨 ACTIONABLE TODAY (${actionable.length})\n`);
        process.stderr.write(`────────────────────────────────────────────────────────\n`);
        for (const a of actionable) {
            const e = a.entry;
            const stock = stocksByTicker.get(e.ticker.toUpperCase());
            const ret = returnPct(e, stock?.lastPrice);
            const days = e.events[0]
                ? Math.max(0, Math.round((Date.parse(asOf) - Date.parse(e.firstAlertDate)) / 86400_000))
                : 0;
            process.stderr.write(
                `${statusEmoji(e.status)}  ${e.ticker.padEnd(12)}  ` +
                `${e.firstAlertLevel}→${e.status.padEnd(15)}  ` +
                `entry $${e.firstAlertPrice.toFixed(2)} → now $${(stock?.lastPrice ?? 0).toFixed(2)}  ` +
                `${fmtPct(ret).padStart(7)}  ${days}d\n` +
                `   ${a.reason ?? ''}\n`
            );
        }
        process.stderr.write(`\n`);
    }

    // 2. New monitors added today
    if (summary.newEntries.length > 0) {
        process.stderr.write(`🆕 NEW MONITORS (${summary.newEntries.length})\n`);
        process.stderr.write(`────────────────────────────────────────────────────────\n`);
        // Sort: Full first, then Recovery, then Watchlist
        const order: Record<string, number> = { full: 0, recovery: 1, close: 2 };
        const sorted = [...summary.newEntries].sort(
            (a, b) => order[a.firstAlertLevel] - order[b.firstAlertLevel]
        );
        for (const e of sorted) {
            const lvEmoji =
                e.firstAlertLevel === 'full' ? '🎯' : e.firstAlertLevel === 'recovery' ? '🦅' : '👀';
            process.stderr.write(
                `${lvEmoji}  ${e.ticker.padEnd(12)}  $${e.firstAlertPrice.toFixed(2).padStart(8)}  ` +
                `RVOL ${e.firstAlertRvol.toFixed(2)}  ${(e.sector ?? '').slice(0, 20)}\n`
            );
        }
        process.stderr.write(`\n`);
    }

    // 3. Expired today (just for awareness)
    const expired = summary.transitions.filter((t) => t.newStatus === 'expired');
    if (expired.length > 0) {
        process.stderr.write(`🗑️  EXPIRED TODAY (${expired.length}) — 30 days without resolution\n`);
        process.stderr.write(`────────────────────────────────────────────────────────\n`);
        for (const e of expired) {
            const stock = stocksByTicker.get(e.entry.ticker.toUpperCase());
            const ret = returnPct(e.entry, stock?.lastPrice);
            process.stderr.write(
                `${e.entry.ticker.padEnd(12)}  alerted ${e.entry.firstAlertDate}  ${fmtPct(ret).padStart(7)} since\n`
            );
        }
        process.stderr.write(`\n`);
    }

    // 4. Currently-active monitor summary
    const active = state.entries.filter((e) => e.status === 'monitoring');
    process.stderr.write(`👀 STILL MONITORING (${active.length})\n`);
    process.stderr.write(`────────────────────────────────────────────────────────\n`);
    if (active.length === 0) {
        process.stderr.write(`(none)\n`);
    } else {
        const sorted = [...active].sort(
            (a, b) => Date.parse(a.firstAlertDate) - Date.parse(b.firstAlertDate)
        );
        for (const e of sorted) {
            const stock = stocksByTicker.get(e.ticker.toUpperCase());
            const ret = returnPct(e, stock?.lastPrice);
            const days = Math.max(0, Math.round((Date.parse(asOf) - Date.parse(e.firstAlertDate)) / 86400_000));
            const lvEmoji = e.firstAlertLevel === 'full' ? '🎯' : e.firstAlertLevel === 'recovery' ? '🦅' : '👀';
            process.stderr.write(
                `${lvEmoji}  ${e.ticker.padEnd(12)}  ${e.firstAlertDate}  ${days.toString().padStart(2)}d  ` +
                `$${e.firstAlertPrice.toFixed(2).padStart(8)} → $${(stock?.lastPrice ?? 0).toFixed(2).padStart(8)}  ` +
                `${fmtPct(ret).padStart(7)}\n`
            );
        }
    }
    process.stderr.write(`\n`);

    // 5. Aggregate stats
    const total = state.entries.length;
    const graduated = state.entries.filter((e) => e.status === 'graduated').length;
    const manualEntry = state.entries.filter((e) => e.status === 'manual-entry').length;
    const pullback = state.entries.filter((e) => e.status === 'sma21-pullback').length;
    const expiredAll = state.entries.filter((e) => e.status === 'expired').length;
    process.stderr.write(`📊 LIFETIME TOTALS\n`);
    process.stderr.write(`────────────────────────────────────────────────────────\n`);
    process.stderr.write(`Total entries ever:   ${total}\n`);
    process.stderr.write(`Currently monitoring: ${active.length}\n`);
    process.stderr.write(`Graduated to Full:    ${graduated}\n`);
    process.stderr.write(`Manual-entry trigger: ${manualEntry}\n`);
    process.stderr.write(`SMA21 pullback:       ${pullback}\n`);
    process.stderr.write(`Expired:              ${expiredAll}\n\n`);
}

main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
});
