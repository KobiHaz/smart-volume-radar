#!/usr/bin/env npx tsx
/**
 * Check a ticker's RVOL, price change, and filter status for each day of the past week.
 * Run: npx tsx scripts/check-ticker-history.ts NBIS
 */
import 'dotenv/config';

const TICKER = process.argv[2] || 'NBIS';
const LOOKBACK = 63; // avg volume lookback (same as marketData)

async function fetchYahooChart(ticker: string): Promise<{ timestamps: number[]; closes: number[]; volumes: number[] } | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1mo`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[]; volume?: (number | null)[] }> } }> } };
    const result = data?.chart?.result?.[0];
    if (!result?.timestamp?.length) return null;
    const quote = result.indicators?.quote?.[0];
    const closes = (quote?.close ?? []).map((c) => (c != null && c > 0 ? c : 0));
    const volumes = (quote?.volume ?? []).map((v) => (v != null && v > 0 ? v : 0));
    return { timestamps: result.timestamp, closes, volumes };
}

function dateFromTs(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
    console.log(`\n📊 ${TICKER} — נתונים יומיים (שבוע אחורה)\n`);

    const data = await fetchYahooChart(TICKER);
    if (!data) {
        console.log('❌ לא הצלחתי למשוך נתונים מ-Yahoo');
        return;
    }

    const { timestamps, closes, volumes } = data;
    const dayRows: Array<{ date: string; close: number; volume: number }> = [];
    for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] > 0) {
            dayRows.push({
                date: dateFromTs(timestamps[i]),
                close: closes[i],
                volume: volumes[i] || 0,
            });
        }
    }

    const targetDates = ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'];
    const dayNames: Record<string, string> = {
        '2026-03-09': 'שני',
        '2026-03-10': 'שלישי',
        '2026-03-11': 'רביעי',
        '2026-03-12': 'חמישי',
        '2026-03-13': 'שישי',
    };

    console.log('| יום   | תאריך     | מחיר סגירה | נפח     | ממוצע 63 יום | RVOL | Δ% מחיר | Green? | Blue? |');
    console.log('|-------|------------|------------|---------|--------------|------|---------|--------|-------|');

    for (const target of targetDates) {
        const idx = dayRows.findIndex((r) => r.date === target);
        if (idx < 0) {
            console.log(`| ${dayNames[target]?.padEnd(5) || '?'} | ${target} | —         | —       | —            | —    | —       | —      | —     |`);
            continue;
        }

        const close = dayRows[idx].close;
        const volume = dayRows[idx].volume;
        const prevClose = idx >= 1 ? dayRows[idx - 1].close : close;
        const priceChange = prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0;

        const volHistory = dayRows
            .slice(Math.max(0, idx - LOOKBACK), idx)
            .map((r) => r.volume)
            .filter((v) => v > 0);
        const avgVol = volHistory.length > 0 ? volHistory.reduce((a, b) => a + b, 0) / volHistory.length : 0;
        const rvol = avgVol > 0 ? volume / avgVol : 0;

        const green = rvol >= 2 && Math.abs(priceChange) >= 2;
        const blue = '(דורש 3 תגיות)';

        console.log(
            `| ${(dayNames[target] ?? '?').padEnd(5)} | ${target} | ${close.toFixed(2).padStart(10)} | ${(volume / 1e6).toFixed(2).padStart(5)}M | ${(avgVol / 1e6).toFixed(2).padStart(12)}M | ${rvol.toFixed(2).padStart(4)} | ${(priceChange >= 0 ? '+' : '') + priceChange.toFixed(1).padStart(5)}% | ${green ? '✅' : '❌'}      | ${blue} |`
        );
    }

    console.log('\nGreen = RVOL≥2 AND |Δ%|≥2%  |  Blue = כל 3 התגיות\n');
}

main().catch(console.error);
