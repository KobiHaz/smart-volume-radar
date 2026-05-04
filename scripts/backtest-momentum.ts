#!/usr/bin/env npx tsx
/**
 * Momentum Edition — backtest harness.
 *
 * Two modes:
 *   • date-sweep   — for each ticker, walk daily through a date range; print
 *                    a chronological table of (date, level, RVOL, %fromATH,
 *                    failed criteria). Answers: "when (if ever) does the
 *                    momentum alert fire on this stock?"
 *
 *   • walk-forward — for each trading day in the last N days, replay the
 *                    watchlist via fetchYahooChartAsOfDate, find Full
 *                    Setups, then look forward 10 / 20 trading days and
 *                    compute the % return. Hit-rate + median + max DD.
 *
 * Usage:
 *   npm run backtest-momentum -- --mode date-sweep --tickers INTC,AMKR,MXL --from 2024-06-01 --to 2024-10-01
 *   npm run backtest-momentum -- --mode walk-forward --days 90
 *
 * Env:
 *   BACKTEST_MODE=1   bypasses the data-freshness guard.
 *   GOOGLE_SHEET_ID   required for walk-forward (loads watchlist).
 */
import 'dotenv/config';
import { fetchYahooChartAsOfDate, fetchMarketRegime } from '../src/services/marketData.js';
import { evaluateMomentumSetup, describeFailure } from '../src/utils/setup.js';
import type { MomentumLevel, StockData } from '../src/types/index.js';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import pLimit from 'p-limit';

process.env.BACKTEST_MODE = '1';

interface CliArgs {
    mode: 'date-sweep' | 'walk-forward';
    tickers?: string[];
    from?: string;
    to?: string;
    days?: number;
    forward?: number[];
    everyNDays?: number;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { mode: 'date-sweep' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = argv[i + 1];
        if (a === '--mode' && (next === 'date-sweep' || next === 'walk-forward')) {
            args.mode = next;
            i++;
        } else if (a === '--tickers' && next) {
            args.tickers = next.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
            i++;
        } else if (a === '--from' && next) {
            args.from = next;
            i++;
        } else if (a === '--to' && next) {
            args.to = next;
            i++;
        } else if (a === '--days' && next) {
            args.days = parseInt(next, 10);
            i++;
        } else if (a === '--forward' && next) {
            args.forward = next.split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite);
            i++;
        } else if (a === '--every' && next) {
            args.everyNDays = parseInt(next, 10);
            i++;
        }
    }
    return args;
}

/** Inclusive list of weekday dates between from and to (Mon–Fri only). */
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

function levelEmoji(l: MomentumLevel): string {
    return l === 'full' ? '🎯' : l === 'recovery' ? '🦅' : l === 'close' ? '👀' : '· ';
}

function fmtPct(n: number | undefined, digits = 1): string {
    if (n == null || !Number.isFinite(n)) return '   —';
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(digits)}%`;
}

async function runDateSweep(args: CliArgs): Promise<void> {
    const tickers = args.tickers ?? ['INTC', 'AMKR', 'MXL'];
    const from = args.from ?? '2024-06-01';
    const to = args.to ?? new Date().toISOString().slice(0, 10);
    const everyN = args.everyNDays ?? 1;
    const dates = tradingDays(from, to).filter((_, i) => i % everyN === 0);

    process.stderr.write(
        `\n📅 Date-sweep: ${tickers.length} ticker(s) × ${dates.length} day(s) (${from} → ${to}, every ${everyN}d)\n` +
        `Bypassing freshness guard (BACKTEST_MODE=1).\n\n`
    );

    const limit = pLimit(3);
    for (const ticker of tickers) {
        process.stderr.write(`\n=== ${ticker} ===\n`);
        process.stderr.write('Date        Lv RVOL  Price   ATH%   Stage2 SMA21d AthD  Failures\n');
        process.stderr.write('───────────────────────────────────────────────────────────────────\n');

        let firstFull: string | null = null;
        let firstRecovery: string | null = null;
        let firstClose: string | null = null;
        let fullCount = 0;
        let recoveryCount = 0;
        let closeCount = 0;

        // Per-date regime fetch (1 SPY call per unique date, cached) — keep it sequential per ticker
        // but parallel across tickers via the outer loop; here we still parallelize the ticker fetch.
        const regimeCache = new Map<string, 'bull' | 'bear'>();

        const tasks = dates.map((date) =>
            limit(async () => {
                const stock = await fetchYahooChartAsOfDate(ticker, date);
                if (!stock) return { date, line: `${date}  —  no data` };
                let regime = regimeCache.get(date);
                if (!regime) {
                    regime = await fetchMarketRegime(date);
                    regimeCache.set(date, regime);
                }
                stock.marketRegime = regime;
                const m = evaluateMomentumSetup(stock, { regime });

                const distSma21 = stock.sma21
                    ? Math.abs(stock.lastPrice - stock.sma21) / stock.sma21 * 100
                    : undefined;
                const failuresLabel = m.failures.length > 0 ? m.failures.join(',') : '—';
                const line =
                    `${date}  ${levelEmoji(m.level)}  ` +
                    `${(stock.projectedRvol ?? stock.rvol).toFixed(2).padStart(5)}  ` +
                    `${stock.lastPrice.toFixed(2).padStart(7)}  ` +
                    `${fmtPct(stock.pctFromAth, 1).padStart(6)}  ` +
                    `${(m.criteria.stage2 ? '✓' : '✗').padStart(6)}  ` +
                    `${(distSma21 != null ? distSma21.toFixed(1) + '%' : '—').padStart(6)}  ` +
                    `${(stock.daysSinceAth ?? '—').toString().padStart(4)}  ` +
                    failuresLabel;
                return { date, level: m.level, line };
            })
        );

        const rows = await Promise.all(tasks);
        for (const r of rows) {
            process.stderr.write(r.line + '\n');
            if ('level' in r) {
                if (r.level === 'full') {
                    fullCount++;
                    if (!firstFull) firstFull = r.date;
                } else if (r.level === 'recovery') {
                    recoveryCount++;
                    if (!firstRecovery) firstRecovery = r.date;
                } else if (r.level === 'close') {
                    closeCount++;
                    if (!firstClose) firstClose = r.date;
                }
            }
        }

        process.stderr.write(
            `\nSummary ${ticker}: 🎯 ${fullCount} full | 🦅 ${recoveryCount} recovery | 👀 ${closeCount} close | ` +
            `first full: ${firstFull ?? '—'} | first recovery: ${firstRecovery ?? '—'} | first close: ${firstClose ?? '—'}\n`
        );
    }
}

async function fetchForwardReturn(
    ticker: string,
    fromDate: string,
    fwdDays: number,
    priceThen: number
): Promise<number | null> {
    // Fetch as-of-date fwdDays trading days later. Approx: add fwdDays * 1.42 calendar days.
    const fwd = new Date(fromDate + 'T00:00:00Z');
    fwd.setUTCDate(fwd.getUTCDate() + Math.ceil(fwdDays * 1.42));
    const fwdDate = fwd.toISOString().slice(0, 10);
    const stock = await fetchYahooChartAsOfDate(ticker, fwdDate);
    if (!stock) return null;
    return ((stock.lastPrice - priceThen) / priceThen) * 100;
}

async function runWalkForward(args: CliArgs): Promise<void> {
    if (!process.env.GOOGLE_SHEET_ID?.trim()) {
        process.stderr.write('GOOGLE_SHEET_ID required for walk-forward.\n');
        process.exit(2);
    }
    await fetchAndCacheWatchlist();
    const watchlist = loadWatchlist();
    const days = args.days ?? 90;
    const forward = args.forward ?? [10, 20];
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - days);
    const dates = tradingDays(start.toISOString().slice(0, 10), today.toISOString().slice(0, 10));

    process.stderr.write(
        `\n🔄 Walk-forward: watchlist=${watchlist.length} | days=${dates.length} | forward=${forward.join(',')}\n` +
        `BACKTEST_MODE=1 (freshness guard off)\n\n`
    );

    const limit = pLimit(3);
    interface Hit {
        date: string;
        ticker: string;
        priceThen: number;
        regime: 'bull' | 'bear';
        fwdReturns: Map<number, number | null>;
    }
    const hits: Hit[] = [];

    for (const date of dates) {
        const regime = await fetchMarketRegime(date);
        process.stderr.write(`  ${date}  regime=${regime}  `);
        const stocks = (
            await Promise.all(
                watchlist.map((t) => limit(() => fetchYahooChartAsOfDate(t, date)))
            )
        ).filter((s): s is StockData => s != null);

        const fullsToday: Hit[] = [];
        for (const s of stocks) {
            s.marketRegime = regime;
            const m = evaluateMomentumSetup(s, { regime });
            if (m.level === 'full') {
                fullsToday.push({
                    date,
                    ticker: s.ticker,
                    priceThen: s.lastPrice,
                    regime,
                    fwdReturns: new Map(),
                });
            }
        }
        process.stderr.write(`fulls=${fullsToday.length}\n`);
        hits.push(...fullsToday);
    }

    // Now resolve forward returns for every hit (skip ones too close to today).
    process.stderr.write(`\nResolving forward returns for ${hits.length} hits...\n`);
    const today_s = today.toISOString().slice(0, 10);
    for (const h of hits) {
        for (const fwd of forward) {
            const fwdCutoff = new Date(h.date + 'T00:00:00Z');
            fwdCutoff.setUTCDate(fwdCutoff.getUTCDate() + Math.ceil(fwd * 1.42));
            if (fwdCutoff.toISOString().slice(0, 10) > today_s) {
                h.fwdReturns.set(fwd, null);
                continue;
            }
            const ret = await fetchForwardReturn(h.ticker, h.date, fwd, h.priceThen);
            h.fwdReturns.set(fwd, ret);
        }
    }

    // Aggregate.
    const summary: Array<{ fwd: number; n: number; hitRate: number; median: number; mean: number; min: number; max: number }> = [];
    for (const fwd of forward) {
        const rets = hits
            .map((h) => h.fwdReturns.get(fwd))
            .filter((r): r is number => r != null && Number.isFinite(r));
        if (rets.length === 0) {
            summary.push({ fwd, n: 0, hitRate: 0, median: 0, mean: 0, min: 0, max: 0 });
            continue;
        }
        const sorted = [...rets].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)]!;
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const hitRate = (rets.filter((r) => r > 0).length / rets.length) * 100;
        summary.push({
            fwd,
            n: rets.length,
            hitRate,
            median,
            mean,
            min: sorted[0]!,
            max: sorted[sorted.length - 1]!,
        });
    }

    process.stderr.write(`\n========== WALK-FORWARD RESULTS ==========\n`);
    process.stderr.write(`Window: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} days)\n`);
    process.stderr.write(`Watchlist: ${watchlist.length} tickers\n`);
    process.stderr.write(`Total Full Momentum hits: ${hits.length}\n\n`);
    process.stderr.write(`Fwd  N    Hit%   Median%   Mean%    Min%     Max%\n`);
    for (const s of summary) {
        process.stderr.write(
            `${s.fwd.toString().padStart(3)}d  ${s.n.toString().padStart(4)}  ` +
            `${s.hitRate.toFixed(1).padStart(5)}%  ` +
            `${fmtPct(s.median, 1).padStart(7)}  ` +
            `${fmtPct(s.mean, 1).padStart(7)}  ` +
            `${fmtPct(s.min, 1).padStart(7)}  ` +
            `${fmtPct(s.max, 1).padStart(7)}\n`
        );
    }

    // Decision gate.
    const main = summary.find((s) => s.fwd === 10) ?? summary[0];
    if (main && main.n > 0) {
        const verdict =
            main.hitRate >= 55 ? '✅ SHIP'
            : main.hitRate >= 50 ? '⚠️ SHIP w/ tuning flag'
            : '🛑 STOP — revisit thresholds';
        process.stderr.write(`\nVerdict (${main.fwd}d hit-rate): ${verdict}\n`);
    }

    // Print the hits themselves (CSV-ish, for follow-up analysis).
    process.stderr.write(`\n--- Per-hit detail ---\n`);
    process.stderr.write(`date,ticker,priceThen,regime,${forward.map((f) => `r${f}d`).join(',')}\n`);
    for (const h of hits) {
        process.stderr.write(
            `${h.date},${h.ticker},${h.priceThen.toFixed(2)},${h.regime},` +
            forward.map((f) => {
                const r = h.fwdReturns.get(f);
                return r == null ? '' : r.toFixed(2);
            }).join(',') + '\n'
        );
    }

    // Describe a sample failure pattern from a known winner if no fulls fired.
    if (hits.length === 0) {
        process.stderr.write(`\nℹ️ No Full Setups in this window. Try: --mode date-sweep --tickers <known winner> to inspect criteria-by-criteria why.\n`);
        void describeFailure; // keep import alive
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.mode === 'walk-forward') {
        await runWalkForward(args);
    } else {
        await runDateSweep(args);
    }
}

main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
});
