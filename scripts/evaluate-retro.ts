#!/usr/bin/env npx tsx
/**
 * Retroactive evaluation: replay scan logic on historical data for last 30 days,
 * then evaluate each signal's performance to end of that trading week.
 * Does NOT require stored artifacts — uses fetchYahooChartAsOfDate + calculateRVOL.
 *
 * Run: npm run evaluate-retro
 * Env: GOOGLE_SHEET_ID (watchlist). LOOKBACK_DAYS=30 (default).
 *      QUIET=1 — less logging.
 */
import 'dotenv/config';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import { fetchYahooChartAsOfDate } from '../src/services/marketData.js';
import { calculateRVOL } from '../src/services/rvolCalculator.js';
import { config } from '../src/config/index.js';
import pLimit from 'p-limit';

const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? '30', 10) || 30;
const limit = pLimit(3);
const QUIET = process.env.QUIET === '1' || process.env.QUIET === 'true';

interface Signal {
    ticker: string;
    date: string;
    priceThen: number;
    weekStart: string;
    fridayDate: string;
}

interface OutputRow extends Signal {
    priceAtEOW: number | null;
    changePct: number | null;
}

/** Trading days (Mon–Fri) in range [from, to], inclusive */
function getTradingDays(from: Date, to: Date): string[] {
    const out: string[] = [];
    const cur = new Date(from);
    cur.setHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    while (cur <= end) {
        const day = cur.getUTCDay();
        if (day >= 1 && day <= 5) {
            out.push(cur.toISOString().slice(0, 10));
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}

/** Friday (YYYY-MM-DD) of the week containing dateStr */
function fridayOfWeek(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00Z');
    const day = d.getUTCDay();
    const daysToFri = (5 - day + 7) % 7;
    d.setUTCDate(d.getUTCDate() + daysToFri);
    return d.toISOString().slice(0, 10);
}

/** ISO week start (Monday) for dateStr */
function weekStartForDate(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00Z');
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
    return monday.toISOString().slice(0, 10);
}

async function getTickers(): Promise<string[]> {
    if (!process.env.GOOGLE_SHEET_ID?.trim()) {
        process.stderr.write('⚠️ GOOGLE_SHEET_ID not set — cannot load watchlist\n');
        process.exit(2);
    }
    await fetchAndCacheWatchlist();
    return loadWatchlist();
}

async function main(): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);

    const tradingDays = getTradingDays(cutoff, now);
    if (!QUIET) {
        process.stderr.write(
            `\n📊 Replay רטרואקטיבי: ${tradingDays.length} ימי מסחר (${tradingDays[0]}–${tradingDays[tradingDays.length - 1]})\n\n`
        );
    }

    const tickers = await getTickers();
    if (!QUIET) process.stderr.write(`📋 Watchlist: ${tickers.length} tickers\n\n`);

    const signals: Signal[] = [];
    const fetchEOW = new Map<string, number>(); // (ticker|fridayDate) -> price

    for (let i = 0; i < tradingDays.length; i++) {
        const date = tradingDays[i]!;
        if (!QUIET && (i % 5 === 0 || i === tradingDays.length - 1)) {
            process.stderr.write(`  Replay ${i + 1}/${tradingDays.length}: ${date}\n`);
        }

        const results = await Promise.all(
            tickers.map((t) => limit(() => fetchYahooChartAsOfDate(t, date)))
        );
        const stocks = results.filter((s): s is NonNullable<typeof s> => s != null);

        const { topSignals } = calculateRVOL(stocks, {
            minRVOL: config.minRVOL,
            topN: config.topN,
            priceChangeThreshold: config.priceChangeThreshold,
        });

        const friday = fridayOfWeek(date);
        const weekStart = weekStartForDate(date);

        for (const s of topSignals) {
            signals.push({
                ticker: s.ticker,
                date,
                priceThen: s.lastPrice,
                weekStart,
                fridayDate: friday,
            });
        }

        await new Promise((r) => setTimeout(r, 200));
    }

    const uniqueEOW = new Map<string, { ticker: string; friday: string }>();
    for (const sig of signals) {
        const key = `${sig.ticker}|${sig.fridayDate}`;
        if (!uniqueEOW.has(key)) uniqueEOW.set(key, { ticker: sig.ticker, friday: sig.fridayDate });
    }

    if (!QUIET) process.stderr.write(`\n📥 Fetching ${uniqueEOW.size} end-of-week prices...\n`);

    const fetchWithRetry = async (t: string, d: string, maxRetries = 3): Promise<number | null> => {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const stock = await limit(() => fetchYahooChartAsOfDate(t, d));
                return stock?.lastPrice ?? null;
            } catch {
                if (attempt < maxRetries - 1) {
                    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
                }
            }
        }
        return null;
    };

    for (const { ticker, friday } of uniqueEOW.values()) {
        const price = await fetchWithRetry(ticker, friday);
        if (price != null) {
            fetchEOW.set(`${ticker}|${friday}`, price);
        }
        await new Promise((r) => setTimeout(r, 150));
    }

    const rows: OutputRow[] = signals.map((s) => {
        const priceAtEOW = fetchEOW.get(`${s.ticker}|${s.fridayDate}`) ?? null;
        const changePct =
            priceAtEOW != null ? ((priceAtEOW - s.priceThen) / s.priceThen) * 100 : null;
        return { ...s, priceAtEOW, changePct };
    });

    const validChanges = rows.filter((r) => r.changePct != null);
    const avgChange =
        validChanges.length > 0
            ? validChanges.reduce((a, r) => a + (r.changePct ?? 0), 0) / validChanges.length
            : 0;

    const byWeek = new Map<string, OutputRow[]>();
    for (const r of rows) {
        const list = byWeek.get(r.weekStart) ?? [];
        list.push(r);
        byWeek.set(r.weekStart, list);
    }

    const lines: string[] = [
        `📊 רטרוספקטיבה Replay (${LOOKBACK_DAYS} יום)`,
        '',
        `סה"כ: ${rows.length} אותות | ממוצע Δ% (עד סוף השבוע): ${avgChange.toFixed(1)}%`,
        '',
        '--- סיכום לפי שבוע ---',
        '',
    ];

    const weekStarts = [...byWeek.keys()].sort();
    for (const ws of weekStarts) {
        const w = byWeek.get(ws)!;
        const withPrice = w.filter((r) => r.changePct != null);
        const wins = withPrice.filter((r) => (r.changePct ?? 0) > 0).length;
        const avg = withPrice.length > 0
            ? withPrice.reduce((a, r) => a + (r.changePct ?? 0), 0) / withPrice.length
            : 0;
        const winRate = withPrice.length > 0 ? ((wins / withPrice.length) * 100).toFixed(0) : 'N/A';
        lines.push(`שבוע ${ws}: ${w.length} אותות | ממוצע ${avg.toFixed(1)}% | win rate ${winRate}%`);

        const top3 = [...w]
            .filter((r) => r.changePct != null)
            .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
            .slice(0, 3);
        for (const r of top3) {
            lines.push(
                `  • ${r.ticker} (${r.date}): ${(r.changePct ?? 0) >= 0 ? '+' : ''}${(r.changePct ?? 0).toFixed(1)}%`
            );
        }
        lines.push('');
    }

    const SHOW_ROWS = 20;
    lines.push(`--- טופ ${SHOW_ROWS} לפי Δ% ---`);
    lines.push('TICKER | תאריך | מחיר אז | מחיר סוף שבוע | Δ%');
    const sorted = [...rows].sort((a, b) => (b.changePct ?? -999) - (a.changePct ?? -999));
    for (const r of sorted.slice(0, SHOW_ROWS)) {
        const eow = r.priceAtEOW != null ? r.priceAtEOW.toFixed(2) : 'N/A';
        const ch =
            r.changePct != null
                ? `${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(1)}%`
                : 'N/A';
        lines.push(`${r.ticker} | ${r.date} | ${r.priceThen.toFixed(2)} | ${eow} | ${ch}`);
    }
    if (rows.length > SHOW_ROWS) {
        lines.push(`... ועוד ${rows.length - SHOW_ROWS} אותות`);
    }

    process.stdout.write(lines.join('\n') + '\n');
}

main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
});
