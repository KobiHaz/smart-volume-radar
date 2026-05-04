#!/usr/bin/env npx tsx
/**
 * Watchlist Backtest — for each ticker in the Google Sheet, find when in 2026 the
 * scanner would have fired (Full / Recovery / Watchlist) and compute % return from
 * the alert date to today's last close.
 *
 * Optimization: fetch each ticker's 5y Yahoo chart ONCE, then slice locally for each
 * trading day in the window. No per-date HTTP per ticker.
 *
 * Usage:  BACKTEST_MODE=1 npm run backtest-watchlist [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 * Env: GOOGLE_SHEET_ID required.
 */
import 'dotenv/config';
import { fetchAndCacheWatchlist, loadWatchlist, config as appConfig } from '../src/config/index.js';
import { parseYahooChartResult } from '../src/services/marketData.js';
import { evaluateMomentumSetup } from '../src/utils/setup.js';
import { calculateSMA } from '../src/utils/technicalAnalysis.js';
import type { MomentumLevel } from '../src/types/index.js';
import pLimit from 'p-limit';

process.env.BACKTEST_MODE = '1';

interface Args {
    from: string;
    to: string;
    minRvol?: number;
}

function parseArgs(argv: string[]): Args {
    const out: Args = {
        from: '2026-01-01',
        to: new Date().toISOString().slice(0, 10),
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--from' && argv[i + 1]) out.from = argv[++i]!;
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
                const fb = ticker.replace(/\./g, '-');
                return fetchRawChart(fb, 0);
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

/** Pre-compute per-date SPY regime from a single SPY fetch. */
function precomputeRegime(spy: RawChart, dates: string[]): Map<string, 'bull' | 'bear'> {
    const out = new Map<string, 'bull' | 'bear'>();
    const closes: number[] = [];
    const ts = spy.timestamp ?? [];
    const rawCloses = spy.indicators?.quote?.[0]?.close ?? [];
    for (let i = 0; i < rawCloses.length; i++) {
        const c = rawCloses[i];
        if (c != null && c > 0) closes.push(c);
    }
    // Build index from ts to closes index (volume-filtered) is non-trivial;
    // simpler: use raw timestamps mapping with skip of nulls.
    const validIndices: number[] = [];
    for (let i = 0; i < rawCloses.length; i++) {
        if (rawCloses[i] != null && rawCloses[i]! > 0) validIndices.push(i);
    }
    for (const date of dates) {
        const cutoff = dateToTs(date);
        let lastValidIdx = -1;
        for (let j = 0; j < validIndices.length; j++) {
            const tsi = ts[validIndices[j]!];
            if (tsi != null && tsi <= cutoff) lastValidIdx = j;
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

interface AlertRecord {
    date: string;
    price: number;
    rvol: number;
    /** Lowest close seen AFTER the alert date (used to compute max drawdown). */
    minPriceAfter?: number;
    /** Date of that low. */
    minPriceDate?: string;
    /** SMA21-stop exit: first date AFTER alert where close fell below SMA21. */
    sma21StopExitPrice?: number;
    sma21StopExitDate?: string;
}

interface TickerResult {
    ticker: string;
    todayPrice: number | null;
    firstFull?: AlertRecord;
    firstRecovery?: AlertRecord;
    firstClose?: AlertRecord;
    fullCount: number;
    recoveryCount: number;
    closeCount: number;
    /** Per-date snapshots used for trade simulation (re-entry strategies). */
    snapshots: Array<{
        date: string;
        close: number;
        sma21: number | undefined;
        level: MomentumLevel;
        rvol: number;
    }>;
}

interface Trade {
    entryDate: string;
    entryPrice: number;
    exitDate: string;
    exitPrice: number;
    exitReason: 'stop' | 'sma21-break' | 'window-end';
    returnPct: number;
}

interface SimResult {
    trades: Trade[];
    compoundReturn: number; // % return on initial capital after all trades
    wins: number;
    losses: number;
    avgTrade: number;
    biggestWin: number;
    biggestLoss: number;
}

/**
 * Trailing-stop tier rules.
 * As the trade gains, the stop ratchets UP (never down).
 *   • Initial: stop = entry × (1 - initialPct/100)
 *   • Once high-water-mark return ≥ +25%: stop = max(stop, entry) — breakeven
 *   • Once HWM return ≥ +50%: stop = max(stop, hwm × 0.80) — give back 20% of high
 *   • Once HWM return ≥ +100%: stop = max(stop, hwm × 0.75) — give back 25% of high
 */
function trailingStopFor(entry: number, hwm: number, initialPct: number): number {
    const initialStop = entry * (1 - initialPct / 100);
    const hwmRet = ((hwm - entry) / entry) * 100;
    let stop = initialStop;
    if (hwmRet >= 25) stop = Math.max(stop, entry); // breakeven
    if (hwmRet >= 50) stop = Math.max(stop, hwm * 0.80); // 20% trail
    if (hwmRet >= 100) stop = Math.max(stop, hwm * 0.75); // 25% trail
    return stop;
}

/**
 * Simulate trades on one ticker with re-entry on next alert.
 * Entry: any date where snapshot.level is 'full' or 'close' (and we're flat).
 * Exit:  hard %-stop OR trailing stop OR close-below-SMA21 OR end-of-window.
 * Returns compounded return across all trades.
 */
function simulateTrades(
    snapshots: TickerResult['snapshots'],
    opts: {
        stopPct?: number;
        sma21Stop?: boolean;
        trailing?: boolean;
        entryLevels: MomentumLevel[];
    }
): SimResult {
    const trades: Trade[] = [];
    let position: { entryDate: string; entryPrice: number; hwm: number } | null = null;

    for (const s of snapshots) {
        if (position) {
            // Update high-water mark for trailing stops.
            if (s.close > position.hwm) position.hwm = s.close;

            // Determine effective stop price.
            let stopPrice = -Infinity;
            if (opts.trailing && opts.stopPct != null) {
                stopPrice = trailingStopFor(position.entryPrice, position.hwm, opts.stopPct);
            } else if (opts.stopPct != null) {
                stopPrice = position.entryPrice * (1 - opts.stopPct / 100);
            }

            // Hard / trailing stop check.
            if (s.close <= stopPrice && stopPrice > -Infinity) {
                trades.push({
                    entryDate: position.entryDate,
                    entryPrice: position.entryPrice,
                    exitDate: s.date,
                    exitPrice: stopPrice,
                    exitReason: 'stop',
                    returnPct: ((stopPrice - position.entryPrice) / position.entryPrice) * 100,
                });
                position = null;
                continue;
            }
            // SMA21 break (only if same day isn't entry day).
            if (opts.sma21Stop && s.date !== position.entryDate && s.sma21 != null && s.sma21 > 0 && s.close < s.sma21) {
                trades.push({
                    entryDate: position.entryDate,
                    entryPrice: position.entryPrice,
                    exitDate: s.date,
                    exitPrice: s.close,
                    exitReason: 'sma21-break',
                    returnPct: ((s.close - position.entryPrice) / position.entryPrice) * 100,
                });
                position = null;
                continue;
            }
            // Otherwise stay in.
            continue;
        }
        // Flat: enter on a fresh alert at the qualifying level.
        if (opts.entryLevels.includes(s.level)) {
            position = { entryDate: s.date, entryPrice: s.close, hwm: s.close };
        }
    }

    // Close any open position at end of window.
    if (position && snapshots.length > 0) {
        const last = snapshots[snapshots.length - 1]!;
        trades.push({
            entryDate: position.entryDate,
            entryPrice: position.entryPrice,
            exitDate: last.date,
            exitPrice: last.close,
            exitReason: 'window-end',
            returnPct: ((last.close - position.entryPrice) / position.entryPrice) * 100,
        });
    }

    // Compound: equity multiplier = product of (1 + r/100).
    let mult = 1;
    for (const t of trades) mult *= 1 + t.returnPct / 100;
    const compoundReturn = (mult - 1) * 100;
    const wins = trades.filter((t) => t.returnPct > 0).length;
    const losses = trades.filter((t) => t.returnPct <= 0).length;
    const avgTrade = trades.length > 0 ? trades.reduce((a, b) => a + b.returnPct, 0) / trades.length : 0;
    const returns = trades.map((t) => t.returnPct);
    const biggestWin = returns.length > 0 ? Math.max(...returns) : 0;
    const biggestLoss = returns.length > 0 ? Math.min(...returns) : 0;

    return { trades, compoundReturn, wins, losses, avgTrade, biggestWin, biggestLoss };
}

/** Stop-loss simulation: if min%chg ≤ -threshold, exit at -threshold. Else hold to today. */
function stoppedReturn(alert: AlertRecord, todayPrice: number | null, stopPct: number): number | null {
    if (todayPrice == null || alert.minPriceAfter == null) return pctChange(alert.price, todayPrice);
    const ddPct = ((alert.minPriceAfter - alert.price) / alert.price) * 100;
    if (ddPct <= -stopPct) return -stopPct;
    return pctChange(alert.price, todayPrice);
}

function maxDrawdownPct(alert: AlertRecord): number | null {
    if (alert.minPriceAfter == null) return null;
    return ((alert.minPriceAfter - alert.price) / alert.price) * 100;
}

/** SMA21-stop simulation: exit when post-alert close < SMA21. Else hold to today. */
function sma21StopReturn(alert: AlertRecord, todayPrice: number | null): number | null {
    if (alert.sma21StopExitPrice != null) {
        return ((alert.sma21StopExitPrice - alert.price) / alert.price) * 100;
    }
    return pctChange(alert.price, todayPrice);
}

function pctChange(from: number, to: number | null): number | null {
    if (to == null || from <= 0) return null;
    return ((to - from) / from) * 100;
}

function fmtPct(n: number | null): string {
    if (n == null || !Number.isFinite(n)) return '   —';
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
}

function aggregate(rs: TickerResult[], pick: (r: TickerResult) => number | null): {
    n: number;
    avg: number;
    med: number;
    pos: number;
    neg: number;
    min: number;
    max: number;
} {
    const vals = rs.map(pick).filter((v): v is number => v != null && Number.isFinite(v));
    if (vals.length === 0) return { n: 0, avg: 0, med: 0, pos: 0, neg: 0, min: 0, max: 0 };
    const sorted = [...vals].sort((a, b) => a - b);
    return {
        n: vals.length,
        avg: vals.reduce((a, b) => a + b, 0) / vals.length,
        med: sorted[Math.floor(sorted.length / 2)]!,
        pos: vals.filter((v) => v > 0).length,
        neg: vals.filter((v) => v < 0).length,
        min: sorted[0]!,
        max: sorted[sorted.length - 1]!,
    };
}

interface PortfolioPosition {
    ticker: string;
    entryDate: string;
    entryPrice: number;
    shares: number;
    hwm: number;
    level: MomentumLevel;
}

interface PortfolioTrade extends Trade {
    ticker: string;
    level: MomentumLevel;
}

interface PortfolioResult {
    name: string;
    finalEquity: number;
    totalReturnPct: number;
    maxDrawdownPct: number;
    numTrades: number;
    wins: number;
    losses: number;
    sharpe: number;
    avgPositionsHeld: number;
    equityCurve: Array<{ date: string; value: number }>;
    trades: PortfolioTrade[];
}

/**
 * Portfolio-level backtest:
 *   • Start with $initialCapital
 *   • Up to $maxPositions concurrent
 *   • Equal sizing: each new entry = currentEquity / maxPositions
 *   • Rank alerts by level (Full > Recovery > Watchlist) then RVOL desc
 *   • Stop: hard 15% (or trailing if trailing=true)
 *   • Re-entry: only on next alert AND only if not already holding ticker
 */
function simulatePortfolio(
    results: TickerResult[],
    dates: string[],
    opts: {
        name: string;
        initialCapital: number;
        maxPositions: number;
        stopPct: number;
        trailing: boolean;
        entryLevels: MomentumLevel[];
        /** If true: when slots full AND a 'full' alert fires, kick out the lowest-priority position
         *  (Watchlist with worst current PnL) to make room for the Full. */
        replaceLowerPriority?: boolean;
    }
): PortfolioResult {
    const snapByTicker = new Map<string, Map<string, TickerResult['snapshots'][0]>>();
    for (const r of results) {
        const m = new Map<string, TickerResult['snapshots'][0]>();
        for (const s of r.snapshots) m.set(s.date, s);
        snapByTicker.set(r.ticker, m);
    }

    const positions: PortfolioPosition[] = [];
    let cash = opts.initialCapital;
    const trades: PortfolioTrade[] = [];
    const equityCurve: Array<{ date: string; value: number }> = [];
    let positionsHeldSum = 0;
    const levelOrder: Record<MomentumLevel, number> = { full: 0, recovery: 1, close: 2, none: 3 };

    for (const date of dates) {
        // 1. Mark-to-market + check stops on existing positions.
        for (let i = positions.length - 1; i >= 0; i--) {
            const p = positions[i]!;
            const snap = snapByTicker.get(p.ticker)?.get(date);
            if (!snap) continue;
            if (snap.close > p.hwm) p.hwm = snap.close;
            const stopPrice = opts.trailing
                ? trailingStopFor(p.entryPrice, p.hwm, opts.stopPct)
                : p.entryPrice * (1 - opts.stopPct / 100);
            if (snap.close <= stopPrice) {
                const exitPrice = stopPrice;
                cash += p.shares * exitPrice;
                trades.push({
                    ticker: p.ticker,
                    level: p.level,
                    entryDate: p.entryDate,
                    entryPrice: p.entryPrice,
                    exitDate: date,
                    exitPrice,
                    exitReason: 'stop',
                    returnPct: ((exitPrice - p.entryPrice) / p.entryPrice) * 100,
                });
                positions.splice(i, 1);
            }
        }

        // 2. Collect alerts firing today (skip already-held tickers).
        const heldTickers = new Set(positions.map((p) => p.ticker));
        const alertsToday: Array<{ ticker: string; snap: TickerResult['snapshots'][0] }> = [];
        for (const r of results) {
            if (heldTickers.has(r.ticker)) continue;
            const snap = snapByTicker.get(r.ticker)?.get(date);
            if (!snap) continue;
            if (!opts.entryLevels.includes(snap.level)) continue;
            alertsToday.push({ ticker: r.ticker, snap });
        }
        alertsToday.sort((a, b) => {
            const d = levelOrder[a.snap.level] - levelOrder[b.snap.level];
            return d !== 0 ? d : b.snap.rvol - a.snap.rvol;
        });

        // 3. Compute current equity for sizing.
        const equity = cash + positions.reduce((sum, p) => {
            const snap = snapByTicker.get(p.ticker)?.get(date);
            return sum + p.shares * (snap?.close ?? p.entryPrice);
        }, 0);
        const positionSize = equity / opts.maxPositions;

        // 4. Open new positions (if room + cash + alerts available).
        let i = 0;
        while (positions.length < opts.maxPositions && i < alertsToday.length) {
            const alert = alertsToday[i]!;
            i++;
            if (cash < positionSize) break;
            const shares = positionSize / alert.snap.close;
            cash -= positionSize;
            positions.push({
                ticker: alert.ticker,
                entryDate: date,
                entryPrice: alert.snap.close,
                shares,
                hwm: alert.snap.close,
                level: alert.snap.level,
            });
        }

        // 5. Replacement logic: if slots are full AND a Full/Recovery alert is queued,
        //    kick out the lowest-priority position to make room.
        if (opts.replaceLowerPriority) {
            while (positions.length >= opts.maxPositions && i < alertsToday.length) {
                const alert = alertsToday[i]!;
                if (alert.snap.level !== 'full' && alert.snap.level !== 'recovery') break;
                // Find the worst-priority position: highest level number (Watchlist=2 > Recovery=1 > Full=0).
                // Tiebreak: worst current PnL.
                let worstIdx = -1;
                let worstScore = -Infinity;
                for (let j = 0; j < positions.length; j++) {
                    const p = positions[j]!;
                    const snap = snapByTicker.get(p.ticker)?.get(date);
                    const pnl = snap ? ((snap.close - p.entryPrice) / p.entryPrice) * 100 : 0;
                    // Score: higher = worse (we want to kick this one out).
                    const score = levelOrder[p.level] * 1000 - pnl;
                    if (score > worstScore && levelOrder[p.level] >= levelOrder[alert.snap.level]) {
                        worstScore = score;
                        worstIdx = j;
                    }
                }
                if (worstIdx < 0) break;
                // Kick out the worst position.
                const kicked = positions[worstIdx]!;
                const snap = snapByTicker.get(kicked.ticker)?.get(date);
                const exitPrice = snap?.close ?? kicked.entryPrice;
                cash += kicked.shares * exitPrice;
                trades.push({
                    ticker: kicked.ticker,
                    level: kicked.level,
                    entryDate: kicked.entryDate,
                    entryPrice: kicked.entryPrice,
                    exitDate: date,
                    exitPrice,
                    exitReason: 'window-end', // re-purpose as "rotated out"
                    returnPct: ((exitPrice - kicked.entryPrice) / kicked.entryPrice) * 100,
                });
                positions.splice(worstIdx, 1);
                // Now enter the new alert.
                if (cash >= positionSize) {
                    const shares = positionSize / alert.snap.close;
                    cash -= positionSize;
                    positions.push({
                        ticker: alert.ticker,
                        entryDate: date,
                        entryPrice: alert.snap.close,
                        shares,
                        hwm: alert.snap.close,
                        level: alert.snap.level,
                    });
                }
                i++;
            }
        }

        positionsHeldSum += positions.length;
        equityCurve.push({ date, value: equity });
    }

    // Liquidate remaining positions at last close for final equity.
    const lastDate = dates[dates.length - 1]!;
    for (const p of positions) {
        const snap = snapByTicker.get(p.ticker)?.get(lastDate);
        const exitPrice = snap?.close ?? p.entryPrice;
        cash += p.shares * exitPrice;
        trades.push({
            ticker: p.ticker,
            level: p.level,
            entryDate: p.entryDate,
            entryPrice: p.entryPrice,
            exitDate: lastDate,
            exitPrice,
            exitReason: 'window-end',
            returnPct: ((exitPrice - p.entryPrice) / p.entryPrice) * 100,
        });
    }
    const finalEquity = cash;

    // Max drawdown of the equity curve.
    let peak = opts.initialCapital;
    let maxDD = 0;
    const dailyReturns: number[] = [];
    for (let j = 0; j < equityCurve.length; j++) {
        const v = equityCurve[j]!.value;
        if (v > peak) peak = v;
        const dd = ((v - peak) / peak) * 100;
        if (dd < maxDD) maxDD = dd;
        if (j > 0) {
            const prev = equityCurve[j - 1]!.value;
            dailyReturns.push((v - prev) / prev);
        }
    }
    // Annualized Sharpe (252 trading days). Risk-free = 0 for simplicity.
    const meanR = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
    const variance =
        dailyReturns.length > 1
            ? dailyReturns.reduce((a, b) => a + (b - meanR) ** 2, 0) / (dailyReturns.length - 1)
            : 0;
    const stdR = Math.sqrt(variance);
    const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(252) : 0;

    return {
        name: opts.name,
        finalEquity,
        totalReturnPct: ((finalEquity - opts.initialCapital) / opts.initialCapital) * 100,
        maxDrawdownPct: maxDD,
        numTrades: trades.length,
        wins: trades.filter((t) => t.returnPct > 0).length,
        losses: trades.filter((t) => t.returnPct <= 0).length,
        sharpe,
        avgPositionsHeld: positionsHeldSum / dates.length,
        equityCurve,
        trades,
    };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!process.env.GOOGLE_SHEET_ID?.trim()) {
        process.stderr.write('GOOGLE_SHEET_ID required.\n');
        process.exit(2);
    }

    process.stderr.write(`📋 Loading watchlist...\n`);
    await fetchAndCacheWatchlist();
    const tickers = loadWatchlist();
    process.stderr.write(`   ${tickers.length} tickers\n\n`);

    const dates = tradingDays(args.from, args.to);
    process.stderr.write(`📅 Window: ${args.from} → ${args.to} (${dates.length} trading days)\n\n`);

    process.stderr.write(`🧭 Pre-computing SPY regime per date...\n`);
    const spyRaw = await fetchRawChart('SPY');
    if (!spyRaw) {
        process.stderr.write('SPY fetch failed — using bull for all dates.\n');
    }
    const regimeByDate = spyRaw
        ? precomputeRegime(spyRaw, dates)
        : new Map(dates.map((d) => [d, 'bull' as const]));

    process.stderr.write(`📈 Fetching raw 5y charts for ${tickers.length} tickers (concurrency 5)...\n`);
    const limit = pLimit(5);
    let fetched = 0;
    let failed = 0;
    const charts = new Map<string, RawChart>();
    await Promise.all(
        tickers.map((t) =>
            limit(async () => {
                let raw = await fetchRawChart(t);
                if (!raw && COMMON_TYPO_FALLBACKS[t.toUpperCase()]) {
                    raw = await fetchRawChart(COMMON_TYPO_FALLBACKS[t.toUpperCase()]!);
                }
                if (raw) {
                    charts.set(t, raw);
                    fetched++;
                } else {
                    failed++;
                }
                if ((fetched + failed) % 50 === 0) {
                    process.stderr.write(`   ${fetched + failed}/${tickers.length} done\n`);
                }
            })
        )
    );
    process.stderr.write(`   ✅ ${fetched} fetched | ❌ ${failed} failed\n\n`);

    process.stderr.write(`🔄 Evaluating ${dates.length} dates × ${charts.size} tickers...\n`);
    const results: TickerResult[] = [];
    let alertsCount = 0;
    // Default 0 = no filter (matches production default).
    const minLiquidity = parseInt(process.env.MIN_AVG_DAILY_VOLUME ?? '0', 10);

    for (const [ticker, raw] of charts) {
        const r: TickerResult = {
            ticker,
            todayPrice: null,
            fullCount: 0,
            recoveryCount: 0,
            closeCount: 0,
            snapshots: [],
        };

        for (const date of dates) {
            const sliced = sliceChart(raw, dateToTs(date));
            if (!sliced) continue;

            const stock = await parseYahooChartResult(sliced as Parameters<typeof parseYahooChartResult>[0], ticker, {
                skipTwelveData: true,
            });
            if (!stock) continue;
            if (stock.avgVolume > 0 && stock.avgVolume < minLiquidity) continue;

            const regime = regimeByDate.get(date) ?? 'bull';
            stock.marketRegime = regime;
            const m = evaluateMomentumSetup(stock, { regime });

            r.todayPrice = stock.lastPrice; // last iteration overwrites with the most recent price
            r.snapshots.push({
                date,
                close: stock.lastPrice,
                sma21: stock.sma21,
                level: m.level,
                rvol: stock.projectedRvol ?? stock.rvol,
            });

            // Track min-price-after for already-fired alerts (for stop-loss simulation).
            const updateMin = (alert: AlertRecord | undefined): void => {
                if (!alert) return;
                if (alert.minPriceAfter == null || stock.lastPrice < alert.minPriceAfter) {
                    alert.minPriceAfter = stock.lastPrice;
                    alert.minPriceDate = date;
                }
                // SMA21-stop: first day after alert where close drops below SMA21.
                // Don't trigger on the alert day itself (alert.date === date).
                if (
                    alert.sma21StopExitPrice == null &&
                    alert.date !== date &&
                    stock.sma21 != null &&
                    stock.sma21 > 0 &&
                    stock.lastPrice < stock.sma21
                ) {
                    alert.sma21StopExitPrice = stock.lastPrice;
                    alert.sma21StopExitDate = date;
                }
            };
            updateMin(r.firstFull);
            updateMin(r.firstRecovery);
            updateMin(r.firstClose);

            if (m.level === 'full') {
                r.fullCount++;
                if (!r.firstFull) {
                    r.firstFull = {
                        date,
                        price: stock.lastPrice,
                        rvol: stock.projectedRvol ?? stock.rvol,
                        minPriceAfter: stock.lastPrice,
                        minPriceDate: date,
                    };
                    alertsCount++;
                }
            } else if (m.level === 'recovery') {
                r.recoveryCount++;
                if (!r.firstRecovery) {
                    r.firstRecovery = {
                        date,
                        price: stock.lastPrice,
                        rvol: stock.projectedRvol ?? stock.rvol,
                        minPriceAfter: stock.lastPrice,
                        minPriceDate: date,
                    };
                    alertsCount++;
                }
            } else if (m.level === 'close') {
                r.closeCount++;
                if (!r.firstClose) {
                    r.firstClose = {
                        date,
                        price: stock.lastPrice,
                        rvol: stock.projectedRvol ?? stock.rvol,
                        minPriceAfter: stock.lastPrice,
                        minPriceDate: date,
                    };
                    alertsCount++;
                }
            }
        }

        results.push(r);
    }

    process.stderr.write(`\n========== WATCHLIST BACKTEST 2026 ==========\n`);
    process.stderr.write(`Window: ${args.from} → ${args.to} (${dates.length} trading days)\n`);
    process.stderr.write(`Watchlist: ${tickers.length} tickers (${charts.size} with data)\n`);
    process.stderr.write(`Total alerts (first per level per ticker): ${alertsCount}\n\n`);

    // Aggregates
    const fullStats = aggregate(results, (r) => (r.firstFull ? pctChange(r.firstFull.price, r.todayPrice) : null));
    const recoveryStats = aggregate(results, (r) =>
        r.firstRecovery ? pctChange(r.firstRecovery.price, r.todayPrice) : null
    );
    const closeStats = aggregate(results, (r) => (r.firstClose ? pctChange(r.firstClose.price, r.todayPrice) : null));

    process.stderr.write(`Aggregate returns from FIRST alert to today's close:\n`);
    process.stderr.write(`Tier        N    AvgRet    MedRet    Hit%   Min       Max\n`);
    const fmtRow = (label: string, s: typeof fullStats) =>
        `${label.padEnd(12)} ${s.n.toString().padStart(3)}  ` +
        `${fmtPct(s.avg).padStart(7)}   ${fmtPct(s.med).padStart(7)}   ` +
        `${(s.n > 0 ? ((s.pos / s.n) * 100).toFixed(0) : '0').padStart(4)}%  ` +
        `${fmtPct(s.min).padStart(8)}  ${fmtPct(s.max).padStart(8)}\n`;
    process.stderr.write(fmtRow('🎯 Full', fullStats));
    process.stderr.write(fmtRow('🦅 Recovery', recoveryStats));
    process.stderr.write(fmtRow('👀 Watchlist', closeStats));

    // Per-ticker tables
    const printTable = (label: string, key: 'firstFull' | 'firstRecovery' | 'firstClose') => {
        const filtered = results.filter((r) => r[key]);
        if (filtered.length === 0) {
            process.stderr.write(`\n${label}: none\n`);
            return;
        }
        const sorted = [...filtered].sort((a, b) => {
            const ra = pctChange(a[key]!.price, a.todayPrice) ?? -Infinity;
            const rb = pctChange(b[key]!.price, b.todayPrice) ?? -Infinity;
            return rb - ra;
        });
        process.stderr.write(`\n${label} — first alert per ticker, sorted by return desc:\n`);
        process.stderr.write(`Ticker        Date         RVOL  Price@Alert  PriceNow   %Change\n`);
        for (const r of sorted) {
            const rec = r[key]!;
            const ret = pctChange(rec.price, r.todayPrice);
            process.stderr.write(
                `${r.ticker.padEnd(13)} ${rec.date}   ${rec.rvol.toFixed(2).padStart(4)}  ` +
                `${rec.price.toFixed(2).padStart(10)}  ${(r.todayPrice?.toFixed(2) ?? '—').padStart(8)}  ` +
                `${fmtPct(ret).padStart(8)}\n`
            );
        }
    };

    printTable('🎯 FULL', 'firstFull');
    printTable('🦅 RECOVERY', 'firstRecovery');
    printTable('👀 WATCHLIST', 'firstClose');

    // ─── Stop-loss strategy comparison ────────────────────────────────────
    const compare = (rs: TickerResult[], key: 'firstFull' | 'firstRecovery' | 'firstClose', label: string) => {
        const rows = rs
            .filter((r) => r[key])
            .map((r) => {
                const a = r[key]!;
                return {
                    ticker: r.ticker,
                    actual: pctChange(a.price, r.todayPrice),
                    stop8: stoppedReturn(a, r.todayPrice, 8),
                    stop15: stoppedReturn(a, r.todayPrice, 15),
                    sma21: sma21StopReturn(a, r.todayPrice),
                    dd: maxDrawdownPct(a),
                    ddDate: a.minPriceDate,
                    sma21ExitDate: a.sma21StopExitDate,
                };
            })
            .filter((x) => x.actual != null);
        if (rows.length === 0) return;

        const stats = (key2: 'actual' | 'stop8' | 'stop15' | 'sma21') => {
            const vals = rows.map((r) => r[key2]).filter((v): v is number => v != null && Number.isFinite(v));
            if (vals.length === 0) return { avg: 0, hit: 0, n: 0 };
            const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
            const hit = (vals.filter((v) => v > 0).length / vals.length) * 100;
            return { avg, hit, n: vals.length };
        };

        const noStop = stats('actual');
        const s8 = stats('stop8');
        const s15 = stats('stop15');
        const sma21 = stats('sma21');

        const stopped8 = rows.filter((r) => r.stop8 === -8).length;
        const stopped15 = rows.filter((r) => r.stop15 === -15).length;
        const stoppedSma = rows.filter((r) => r.sma21ExitDate != null).length;

        process.stderr.write(`\n========== STOP STRATEGY COMPARISON — ${label} (N=${rows.length}) ==========\n`);
        process.stderr.write(`Strategy            AvgRet    Hit%   Triggered   Δ vs no-stop\n`);
        process.stderr.write(`No stop (hold)      ${fmtPct(noStop.avg).padStart(7)}   ${noStop.hit.toFixed(0).padStart(3)}%   ${'—'.padStart(9)}   ${'—'.padStart(7)}\n`);
        process.stderr.write(
            `8% hard stop        ${fmtPct(s8.avg).padStart(7)}   ${s8.hit.toFixed(0).padStart(3)}%   ${stopped8.toString().padStart(3)} (${((stopped8 / rows.length) * 100).toFixed(0)}%)   ${fmtPct(s8.avg - noStop.avg).padStart(7)}\n`
        );
        process.stderr.write(
            `15% hard stop       ${fmtPct(s15.avg).padStart(7)}   ${s15.hit.toFixed(0).padStart(3)}%   ${stopped15.toString().padStart(3)} (${((stopped15 / rows.length) * 100).toFixed(0)}%)   ${fmtPct(s15.avg - noStop.avg).padStart(7)}\n`
        );
        process.stderr.write(
            `Close < SMA21       ${fmtPct(sma21.avg).padStart(7)}   ${sma21.hit.toFixed(0).padStart(3)}%   ${stoppedSma.toString().padStart(3)} (${((stoppedSma / rows.length) * 100).toFixed(0)}%)   ${fmtPct(sma21.avg - noStop.avg).padStart(7)}\n`
        );

        // Big winners that each strategy would have killed
        const biggestWinners = [...rows]
            .filter((r) => (r.actual ?? 0) > 50)
            .sort((a, b) => (b.actual ?? 0) - (a.actual ?? 0))
            .slice(0, 12);
        if (biggestWinners.length > 0) {
            process.stderr.write(`\nBig winners (>+50%) — what each stop would have done:\n`);
            process.stderr.write(`Ticker        Actual    8% gives  15% gives  SMA21 gives  SMA21 exit date\n`);
            for (const r of biggestWinners) {
                process.stderr.write(
                    `${r.ticker.padEnd(13)} ${fmtPct(r.actual).padStart(7)}   ` +
                    `${fmtPct(r.stop8).padStart(7)}   ${fmtPct(r.stop15).padStart(7)}    ` +
                    `${fmtPct(r.sma21).padStart(7)}     ${r.sma21ExitDate ?? 'still in'}\n`
                );
            }
        }

        // Big losers that each strategy would have saved
        const biggestLosers = [...rows]
            .filter((r) => (r.actual ?? 0) < -15)
            .sort((a, b) => (a.actual ?? 0) - (b.actual ?? 0))
            .slice(0, 8);
        if (biggestLosers.length > 0) {
            process.stderr.write(`\nBig losers (<-15%) — what each stop would have done:\n`);
            process.stderr.write(`Ticker        Actual    8% gives  15% gives  SMA21 gives  SMA21 exit date\n`);
            for (const r of biggestLosers) {
                process.stderr.write(
                    `${r.ticker.padEnd(13)} ${fmtPct(r.actual).padStart(7)}   ` +
                    `${fmtPct(r.stop8).padStart(7)}   ${fmtPct(r.stop15).padStart(7)}    ` +
                    `${fmtPct(r.sma21).padStart(7)}     ${r.sma21ExitDate ?? 'still in'}\n`
                );
            }
        }
    };

    compare(results, 'firstFull', '🎯 FULL');
    compare(results, 'firstClose', '👀 WATCHLIST');

    // ─── Re-entry simulation: stop-out → wait → re-enter on next alert ─────
    process.stderr.write(`\n\n========== RE-ENTRY SIMULATION (compounded across all trades) ==========\n`);
    process.stderr.write(
        `Per ticker: open trade on Full/Watchlist alert; exit on stop; re-enter on NEXT alert; compound.\n` +
        `Compares to "buy & hold from first alert" baseline.\n\n`
    );

    type Strategy = { name: string; opts: Parameters<typeof simulateTrades>[1] };
    const strategies: Strategy[] = [
        { name: 'Buy & Hold (no stop)', opts: { entryLevels: ['full', 'close', 'recovery'] } },
        { name: '15% Stop + Re-Enter', opts: { stopPct: 15, entryLevels: ['full', 'close', 'recovery'] } },
        { name: '8% Stop + Re-Enter', opts: { stopPct: 8, entryLevels: ['full', 'close', 'recovery'] } },
        { name: '15% Trailing Stop + Re-Enter', opts: { stopPct: 15, trailing: true, entryLevels: ['full', 'close', 'recovery'] } },
        { name: '8% Trailing Stop + Re-Enter', opts: { stopPct: 8, trailing: true, entryLevels: ['full', 'close', 'recovery'] } },
        { name: 'SMA21 Stop + Re-Enter', opts: { sma21Stop: true, entryLevels: ['full', 'close', 'recovery'] } },
    ];

    const stratResults = strategies.map((s) => ({
        name: s.name,
        sims: results.map((r) => ({ ticker: r.ticker, sim: simulateTrades(r.snapshots, s.opts) })),
    }));

    process.stderr.write(`Strategy                         AvgCompoundRet   MedRet   Hit%   AvgTrades/ticker  Tickers w/ trade\n`);
    for (const sr of stratResults) {
        const withTrades = sr.sims.filter((s) => s.sim.trades.length > 0);
        if (withTrades.length === 0) {
            process.stderr.write(`${sr.name.padEnd(33)} —\n`);
            continue;
        }
        const compounds = withTrades.map((s) => s.sim.compoundReturn);
        const sortedC = [...compounds].sort((a, b) => a - b);
        const avg = compounds.reduce((a, b) => a + b, 0) / compounds.length;
        const med = sortedC[Math.floor(sortedC.length / 2)]!;
        const hit = (compounds.filter((c) => c > 0).length / compounds.length) * 100;
        const avgTrades =
            withTrades.reduce((a, s) => a + s.sim.trades.length, 0) / withTrades.length;

        process.stderr.write(
            `${sr.name.padEnd(33)} ${fmtPct(avg).padStart(13)}   ${fmtPct(med).padStart(7)}  ${hit.toFixed(0).padStart(3)}%   ${avgTrades.toFixed(1).padStart(8)}        ${withTrades.length.toString().padStart(4)}\n`
        );
    }

    // Highlight key examples — what re-entry achieved on the BIGGEST winners
    process.stderr.write(`\nKey examples — biggest winners under "15% Stop + Re-Enter":\n`);
    const reEntry15 = stratResults.find((s) => s.name === '15% Stop + Re-Enter')!;
    const buyHold = stratResults.find((s) => s.name === 'Buy & Hold (no stop)')!;
    const merged = reEntry15.sims.map((s) => {
        const bh = buyHold.sims.find((x) => x.ticker === s.ticker)!;
        return {
            ticker: s.ticker,
            buyHold: bh.sim.compoundReturn,
            reEntry: s.sim.compoundReturn,
            trades: s.sim.trades.length,
            wins: s.sim.wins,
            biggestTrade: s.sim.biggestWin,
        };
    });
    const top = [...merged]
        .filter((x) => x.trades > 0 && x.buyHold > 30)
        .sort((a, b) => b.reEntry - a.reEntry)
        .slice(0, 15);
    process.stderr.write(`Ticker        BuyHold     15%+Re   Δ        #Trades  Wins  BiggestTrade\n`);
    for (const r of top) {
        process.stderr.write(
            `${r.ticker.padEnd(13)} ${fmtPct(r.buyHold).padStart(7)}   ${fmtPct(r.reEntry).padStart(7)}  ` +
            `${fmtPct(r.reEntry - r.buyHold).padStart(7)}  ${r.trades.toString().padStart(4)}    ${r.wins.toString().padStart(3)}    ${fmtPct(r.biggestTrade).padStart(7)}\n`
        );
    }

    // ─── Portfolio simulator: $100k, max 8 positions, equal sizing ─────
    process.stderr.write(`\n\n========== PORTFOLIO SIMULATION ($100k, max-8 positions, equal sizing) ==========\n`);
    process.stderr.write(`Real-world test: limited capital, can only take a few alerts at a time.\n`);
    process.stderr.write(`Ranking when alerts compete: Full > Recovery > Watchlist, then RVOL desc.\n\n`);

    const ALL_LEVELS: MomentumLevel[] = ['full', 'close', 'recovery'];
    const FULL_ONLY: MomentumLevel[] = ['full'];
    const FULL_AND_RECOVERY: MomentumLevel[] = ['full', 'recovery'];

    const portfolioConfigs: Array<{
        name: string;
        maxPositions: number;
        stopPct: number;
        trailing: boolean;
        entryLevels: MomentumLevel[];
        replaceLowerPriority?: boolean;
    }> = [
        // Original: All levels, max 8/12
        { name: 'AllLevels Trailing15%, max-8', maxPositions: 8, stopPct: 15, trailing: true, entryLevels: ALL_LEVELS },
        { name: 'AllLevels Trailing15%, max-12',maxPositions: 12,stopPct: 15, trailing: true, entryLevels: ALL_LEVELS },
        // Full-only entry (skip Watchlist)
        { name: 'FullOnly Trailing15%, max-5',  maxPositions: 5, stopPct: 15, trailing: true, entryLevels: FULL_ONLY },
        { name: 'FullOnly Trailing15%, max-8',  maxPositions: 8, stopPct: 15, trailing: true, entryLevels: FULL_ONLY },
        { name: 'FullOnly Trailing15%, max-12', maxPositions: 12,stopPct: 15, trailing: true, entryLevels: FULL_ONLY },
        // Full + Recovery (skip Watchlist)
        { name: 'Full+Rec Trailing15%, max-8',  maxPositions: 8, stopPct: 15, trailing: true, entryLevels: FULL_AND_RECOVERY },
        // All levels but Full can REPLACE a lower-priority position
        { name: 'AllLevels+Replace, max-8',     maxPositions: 8, stopPct: 15, trailing: true, entryLevels: ALL_LEVELS, replaceLowerPriority: true },
        { name: 'AllLevels+Replace, max-12',    maxPositions: 12,stopPct: 15, trailing: true, entryLevels: ALL_LEVELS, replaceLowerPriority: true },
    ];

    const portfolioResults: PortfolioResult[] = portfolioConfigs.map((c) =>
        simulatePortfolio(results, dates, {
            name: c.name,
            initialCapital: 100_000,
            maxPositions: c.maxPositions,
            stopPct: c.stopPct,
            trailing: c.trailing,
            entryLevels: c.entryLevels,
            replaceLowerPriority: c.replaceLowerPriority,
        })
    );

    process.stderr.write(`Strategy                            FinalEquity    TotalRet  MaxDD    Sharpe   Trades  Hit%   AvgHeld\n`);
    for (const p of portfolioResults) {
        const hit = p.numTrades > 0 ? (p.wins / p.numTrades) * 100 : 0;
        process.stderr.write(
            `${p.name.padEnd(35)} $${p.finalEquity.toFixed(0).padStart(9)}   ` +
            `${fmtPct(p.totalReturnPct).padStart(7)}  ` +
            `${fmtPct(p.maxDrawdownPct).padStart(7)}  ` +
            `${p.sharpe.toFixed(2).padStart(5)}    ` +
            `${p.numTrades.toString().padStart(4)}    ` +
            `${hit.toFixed(0).padStart(3)}%   ` +
            `${p.avgPositionsHeld.toFixed(1).padStart(4)}\n`
        );
    }

    // Equity curve milestones for the recommended strategy
    const recommended = portfolioResults.find((p) => p.name === 'AllLevels Trailing15%, max-8');
    if (recommended) {
        process.stderr.write(`\nEquity curve milestones (${recommended.name}):\n`);
        const milestones = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0].map((p) =>
            Math.min(recommended.equityCurve.length - 1, Math.floor(p * (recommended.equityCurve.length - 1)))
        );
        for (const idx of milestones) {
            const e = recommended.equityCurve[idx]!;
            const ret = ((e.value - 100_000) / 100_000) * 100;
            process.stderr.write(`  ${e.date}  $${e.value.toFixed(0).padStart(8)}  ${fmtPct(ret).padStart(7)}\n`);
        }
    }

    // Print full trade ledger for the two key strategies
    const printLedger = (p: PortfolioResult | undefined) => {
        if (!p) return;
        process.stderr.write(`\n────── TRADE LEDGER: ${p.name} ──────\n`);
        process.stderr.write(`#   Lv  Ticker        Entry        EntryPx    Exit         ExitPx     Reason       %\n`);
        const sorted = [...p.trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
        let n = 0;
        for (const t of sorted) {
            n++;
            const lv = t.level === 'full' ? '🎯' : t.level === 'recovery' ? '🦅' : '👀';
            const reason = t.exitReason === 'stop' ? 'stop' : t.exitReason === 'sma21-break' ? 'sma21' : 'still-in';
            process.stderr.write(
                `${n.toString().padStart(2)}  ${lv}  ${t.ticker.padEnd(12)}  ` +
                `${t.entryDate}   ${t.entryPrice.toFixed(2).padStart(8)}  ` +
                `${t.exitDate}   ${t.exitPrice.toFixed(2).padStart(8)}  ${reason.padEnd(10)}  ${fmtPct(t.returnPct).padStart(7)}\n`
            );
        }
    };

    printLedger(portfolioResults.find((p) => p.name === 'FullOnly Trailing15%, max-8'));
    printLedger(portfolioResults.find((p) => p.name === 'AllLevels+Replace, max-8'));

    // Also show the biggest losers — did re-entry rescue them?
    process.stderr.write(`\nKey examples — biggest "buy & hold" losers under "15% Stop + Re-Enter":\n`);
    const bottom = [...merged]
        .filter((x) => x.trades > 0 && x.buyHold < -20)
        .sort((a, b) => a.buyHold - b.buyHold)
        .slice(0, 12);
    process.stderr.write(`Ticker        BuyHold     15%+Re   Δ        #Trades  Wins  BiggestTrade\n`);
    for (const r of bottom) {
        process.stderr.write(
            `${r.ticker.padEnd(13)} ${fmtPct(r.buyHold).padStart(7)}   ${fmtPct(r.reEntry).padStart(7)}  ` +
            `${fmtPct(r.reEntry - r.buyHold).padStart(7)}  ${r.trades.toString().padStart(4)}    ${r.wins.toString().padStart(3)}    ${fmtPct(r.biggestTrade).padStart(7)}\n`
        );
    }
}

main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
});
