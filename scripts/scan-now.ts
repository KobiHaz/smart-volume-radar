#!/usr/bin/env npx tsx
/**
 * Scan-now — runs a one-shot Momentum Edition scan on the current watchlist.
 * Prints Full/Recovery/Watchlist hits to the terminal. NO Telegram, NO news, NO LLM.
 * Fastest way to see what the scanner would alert on right now.
 *
 * Usage:  BACKTEST_MODE=1 npx tsx scripts/scan-now.ts [--asof YYYY-MM-DD]
 *   --asof  Optional date to scan as of (defaults to last US trading day).
 *
 * Env: GOOGLE_SHEET_ID required.
 */
import 'dotenv/config';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import { fetchAllStocksAsOfDate, fetchMarketRegime } from '../src/services/marketData.js';
import { evaluateMomentumSetup } from '../src/utils/setup.js';
import { getLastTradingDay } from '../src/utils/tradingDate.js';
import type { MomentumLevel } from '../src/types/index.js';

process.env.BACKTEST_MODE = '1'; // skip stale-data guard so weekend scans work

function parseAsOf(argv: string[]): string {
    const i = argv.indexOf('--asof');
    if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
    return getLastTradingDay();
}

function levelEmoji(l: MomentumLevel): string {
    return l === 'full' ? '🎯' : l === 'recovery' ? '🦅' : l === 'close' ? '👀' : '· ';
}

function fmtPct(n: number | undefined): string {
    if (n == null || !Number.isFinite(n)) return '   —';
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
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
    process.stderr.write(`   ${tickers.length} tickers to scan\n\n`);

    process.stderr.write(`🧭 Fetching SPY regime as of ${asOf}...\n`);
    const regime = await fetchMarketRegime(asOf);
    process.stderr.write(`   Market regime: ${regime.toUpperCase()}\n\n`);

    process.stderr.write(`📊 Scanning ${tickers.length} stocks as of ${asOf}...\n`);
    const { stocks, failedTickers } = await fetchAllStocksAsOfDate(tickers, asOf);
    process.stderr.write(`   ✅ ${stocks.length} fetched | ❌ ${failedTickers.length} failed\n\n`);

    interface Hit {
        ticker: string;
        level: MomentumLevel;
        rvol: number;
        price: number;
        pctFromAth: number | undefined;
        distSma21Pct: number | undefined;
        priceChange: number;
        bypass: boolean;
        sector: string | undefined;
    }

    const hits: Hit[] = [];
    for (const s of stocks) {
        s.marketRegime = regime;
        const m = evaluateMomentumSetup(s, { regime });
        s.momentum = m;
        if (m.level === 'none') continue;
        hits.push({
            ticker: s.ticker,
            level: m.level,
            rvol: s.projectedRvol ?? s.rvol,
            price: s.lastPrice,
            pctFromAth: s.pctFromAth,
            distSma21Pct:
                s.sma21 != null && s.sma21 > 0
                    ? Math.abs(s.lastPrice - s.sma21) / s.sma21 * 100
                    : undefined,
            priceChange: s.priceChange,
            bypass: !!m.highConvictionBypass,
            sector: s.sector,
        });
    }

    // Sort: Full first, then Recovery, then Close. Within each, by RVOL desc.
    const order: Record<MomentumLevel, number> = { full: 0, recovery: 1, close: 2, none: 3 };
    hits.sort((a, b) => {
        const d = order[a.level] - order[b.level];
        return d !== 0 ? d : b.rvol - a.rvol;
    });

    const fulls = hits.filter((h) => h.level === 'full');
    const recoveries = hits.filter((h) => h.level === 'recovery');
    const closes = hits.filter((h) => h.level === 'close');

    process.stderr.write(`\n========== SCAN RESULTS (${asOf}) ==========\n`);
    process.stderr.write(`🎯 ${fulls.length} Full | 🦅 ${recoveries.length} Recovery | 👀 ${closes.length} Watchlist | total scanned: ${stocks.length}\n\n`);

    process.stderr.write('Lv  Ticker       RVOL   Price    ATH%    SMA21d  Day%   Bypass\n');
    process.stderr.write('────────────────────────────────────────────────────────────────\n');
    for (const h of hits) {
        const line =
            `${levelEmoji(h.level)}  ` +
            `${h.ticker.padEnd(12)} ` +
            `${h.rvol.toFixed(2).padStart(5)}  ` +
            `${h.price.toFixed(2).padStart(7)}  ` +
            `${fmtPct(h.pctFromAth).padStart(7)}  ` +
            `${(h.distSma21Pct != null ? h.distSma21Pct.toFixed(1) + '%' : '—').padStart(6)}  ` +
            `${fmtPct(h.priceChange).padStart(6)}  ` +
            `${h.bypass ? 'extended' : ''}`;
        process.stderr.write(line + '\n');
    }
    process.stderr.write('\n');
}

main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
});
