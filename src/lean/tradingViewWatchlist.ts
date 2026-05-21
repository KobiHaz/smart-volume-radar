/**
 * Smart Volume Radar — Lean Radar TradingView watchlist writer.
 *
 * Emits a daily watchlist file with every ticker that's "approaching breakout"
 * — i.e. real Consolidation Breakouts + near-Consolidation (Silent Watchlist
 * pivot candidates). Pullback / volume-only signals are excluded; this watchlist
 * is specifically for the breakout track.
 *
 * Two formats:
 *   1. `tv-watchlist-{date}.txt`   — one symbol per line, EXCHANGE:TICKER format
 *                                    (TradingView import format)
 *   2. `tv-watchlist-{date}.csv`   — comma-separated, single line, paste-ready
 *                                    (TradingView paste-add format)
 *   3. `tv-watchlist-latest.txt`   — copy of the most recent .txt, no date stamp
 *                                    (stable filename for browser automation
 *                                    to fetch without needing today's date)
 *
 * Exchange prefixes (TradingView convention):
 *   .TA  → TASE:        (Tel Aviv Stock Exchange)
 *   .DE  → XETR:        (Deutsche Börse Xetra)
 *   .PA  → EURONEXT:    (Euronext Paris)
 *   .AS  → EURONEXT:    (Euronext Amsterdam)
 *   .SW  → SIX:         (Swiss Exchange)
 *   .L   → LSE:         (London Stock Exchange)
 *   .MI  → MIL:         (Borsa Italiana)
 *   .VI  → VIE:         (Vienna Stock Exchange)
 *   .TW  → TWSE:        (Taiwan)
 *   .KS  → KRX:         (Korea)
 *   .SA  → BMFBOVESPA:  (Brazil)
 *   .MC  → BMV:         (Spain — but actually BME) — falls back to no prefix
 *   plain (no dot)      → (no prefix — TradingView resolves NASDAQ/NYSE automatically)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LeanScanResult } from './format.js';

const EXCHANGE_PREFIX: Record<string, string> = {
    '.TA': 'TASE',
    '.DE': 'XETR',
    '.PA': 'EURONEXT',
    '.AS': 'EURONEXT',
    '.SW': 'SIX',
    '.L': 'LSE',
    '.MI': 'MIL',
    '.VI': 'VIE',
    '.TW': 'TWSE',
    '.KS': 'KRX',
    '.SA': 'BMFBOVESPA',
    '.MC': 'BME',
};

/** Map a SVR ticker (e.g. "NICE.TA", "RHM.DE", "NVDA") to TradingView format
 *  (e.g. "TASE:NICE", "XETR:RHM", "NVDA"). */
export function toTradingViewSymbol(svrTicker: string): string {
    for (const [suffix, prefix] of Object.entries(EXCHANGE_PREFIX)) {
        if (svrTicker.endsWith(suffix)) {
            const base = svrTicker.slice(0, -suffix.length);
            return `${prefix}:${base}`;
        }
    }
    // US stocks — no prefix needed, TradingView resolves automatically.
    return svrTicker;
}

interface WatchlistEntry {
    svrTicker: string;
    tvSymbol: string;
    kind: 'breakout' | 'nearBreakout' | 'graduated';
    detail: string;
}

export function buildBreakoutWatchlist(result: LeanScanResult): WatchlistEntry[] {
    const seen = new Set<string>();
    const entries: WatchlistEntry[] = [];

    // 1. Graduated (highest priority — yesterday's near, today's real)
    for (const g of result.graduated ?? []) {
        if (g.primary !== 'breakout') continue; // only breakout-flavored grads
        if (seen.has(g.stock.ticker)) continue;
        entries.push({
            svrTicker: g.stock.ticker,
            tvSymbol: toTradingViewSymbol(g.stock.ticker),
            kind: 'graduated',
            detail: g.primaryDetail,
        });
        seen.add(g.stock.ticker);
    }

    // 2. Real Consolidation Breakouts
    for (const r of result.consolidationBreakouts) {
        if (seen.has(r.stock.ticker)) continue;
        entries.push({
            svrTicker: r.stock.ticker,
            tvSymbol: toTradingViewSymbol(r.stock.ticker),
            kind: 'breakout',
            detail: `${r.signal.window} base ${r.signal.baseRangePct.toFixed(1)}%, pivot $${r.signal.windowHigh.toFixed(2)}`,
        });
        seen.add(r.stock.ticker);
    }

    // 3. Near-pivot (Silent Watchlist — candidates approaching breakout)
    for (const r of result.nearConsolidation) {
        if (seen.has(r.stock.ticker)) continue;
        entries.push({
            svrTicker: r.stock.ticker,
            tvSymbol: toTradingViewSymbol(r.stock.ticker),
            kind: 'nearBreakout',
            detail: `${r.signal.window} base, ${r.signal.distanceToPivotPct.toFixed(2)}% below pivot $${r.signal.windowHigh.toFixed(2)}`,
        });
        seen.add(r.stock.ticker);
    }

    return entries;
}

export function writeTradingViewWatchlist(
    scanDate: string,
    result: LeanScanResult,
    resultsDir: string
): { txtPath: string; csvPath: string; latestPath: string; count: number } {
    const entries = buildBreakoutWatchlist(result);
    const dateStamp = scanDate;

    // .txt — one symbol per line, with comment headers (TradingView import format).
    const txtLines: string[] = [];
    txtLines.push(`###Lean Radar Breakout Track — ${dateStamp}`);
    txtLines.push(`###Generated: ${new Date().toISOString()}`);
    txtLines.push(`###Total: ${entries.length} symbols (graduated + breakout + near-pivot)`);
    txtLines.push('');

    const byKind = (k: WatchlistEntry['kind']) => entries.filter((e) => e.kind === k);
    const grads = byKind('graduated');
    const breaks = byKind('breakout');
    const nears = byKind('nearBreakout');

    if (grads.length > 0) {
        txtLines.push(`###🎓 Graduated (${grads.length}) — was on watchlist yesterday, broke out today`);
        for (const e of grads) txtLines.push(`${e.tvSymbol}`);
        txtLines.push('');
    }
    if (breaks.length > 0) {
        txtLines.push(`###📈 Real Breakouts (${breaks.length}) — close > pivot today`);
        for (const e of breaks) txtLines.push(`${e.tvSymbol}`);
        txtLines.push('');
    }
    if (nears.length > 0) {
        txtLines.push(`###👁️ Near Pivot (${nears.length}) — within 2% of base high`);
        for (const e of nears) txtLines.push(`${e.tvSymbol}`);
        txtLines.push('');
    }
    if (entries.length === 0) {
        txtLines.push('###(no breakout candidates today)');
    }

    const txtPath = path.join(resultsDir, `tv-watchlist-${dateStamp}.txt`);
    const latestPath = path.join(resultsDir, 'tv-watchlist-latest.txt');
    const txtContent = txtLines.join('\n') + '\n';
    fs.writeFileSync(txtPath, txtContent);
    fs.writeFileSync(latestPath, txtContent);

    // .csv — comma-separated single line, paste-ready into TradingView's "Add symbols" dialog.
    const csvPath = path.join(resultsDir, `tv-watchlist-${dateStamp}.csv`);
    const csvLine = entries.map((e) => e.tvSymbol).join(',');
    fs.writeFileSync(csvPath, csvLine + '\n');

    return { txtPath, csvPath, latestPath, count: entries.length };
}
