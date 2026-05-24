#!/usr/bin/env npx tsx
/**
 * Build results/ticker-outcomes.json from the precision-analysis output.
 *
 * Consumed by src/utils/tickerStats.ts at scan time → drives:
 *   - TD-21 auto blacklist (recentWinRate < 10% AND alertsCounted ≥ 8)
 *   - TD-23 hot streak (recentWinRate ≥ 80% AND alertsCounted ≥ 10)
 *
 * Run this:
 *   - After every full reconstruct-radar + precision-analysis pass
 *   - Quarterly (refresh the trailing-30 window)
 *   - Manually when you want to refresh ticker classifications
 *
 * Output format (consumed by tickerStats.ts):
 *   { generatedAt, perTicker: { TICKER: { recentWinRate, recentAlertsCounted, blacklisted, hotStreak } } }
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(PROJECT_ROOT, 'results');

const BLACKLIST_RATE = 0.10;   // < 10% win rate → eligible for blacklist
const BLACKLIST_MIN_N = 8;
const BLACKLIST_MAX_MEDIAN_PEAK = 0.05;  // medPeak21d < +5% AND...
const BLACKLIST_MAX_MEDIAN_NOW = 0;      // medForwardNow ≤ 0% (only truly losing/flat tickers — slow grinders like TSM +1.7%, ASML +7% survive)
const HOT_STREAK_RATE = 0.80;  // ≥ 80% win rate → hot streak
const HOT_STREAK_MIN_N = 10;
const TRAILING_N = 30;         // only count last N alerts per ticker

interface FlagWithOutcome {
    date: string;
    ticker: string;
    isWin: boolean;
    outcome: string;
    peak21d: number | null;
    forwardNow: number | null;
}

function median(nums: number[]): number {
    const sorted = [...nums].sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
}

const files = fs.readdirSync(RESULTS_DIR)
    .filter((f) => /^precision-analysis-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
if (files.length === 0) {
    console.error('❌ No precision-analysis-*.json found. Run precision-analysis.ts first.');
    process.exit(1);
}
const latest = path.join(RESULTS_DIR, files[files.length - 1]!);
console.log(`📂 Source: ${path.basename(latest)}`);
const data = JSON.parse(fs.readFileSync(latest, 'utf8')) as { flags: FlagWithOutcome[] };

// Group by ticker, take most recent TRAILING_N alerts
const byTicker = new Map<string, FlagWithOutcome[]>();
for (const f of data.flags) {
    if (f.outcome === 'no_data') continue;
    const arr = byTicker.get(f.ticker) ?? [];
    arr.push(f);
    byTicker.set(f.ticker, arr);
}

const perTicker: Record<string, { recentWinRate: number; recentAlertsCounted: number; blacklisted: boolean; hotStreak: boolean }> = {};
let blacklistedCount = 0;
let hotStreakCount = 0;

for (const [ticker, arr] of byTicker) {
    arr.sort((a, b) => b.date.localeCompare(a.date)); // newest first
    const slice = arr.slice(0, TRAILING_N);
    const wins = slice.filter((x) => x.isWin).length;
    const rate = wins / slice.length;
    const medPeak = median(slice.map((x) => x.peak21d ?? 0));
    const medNow = median(slice.map((x) => x.forwardNow ?? 0));

    // Refined blacklist criteria (2026-05-23): low win-rate ALONE is not
    // enough — mega-caps and slow grinders (TSM/ASML/SUN/KO) have 0% win
    // by the +10% peak threshold but still gain money long-term (+7% now).
    // Require both: low single-event peaks AND no long-term drift.
    const blacklisted =
        rate < BLACKLIST_RATE &&
        slice.length >= BLACKLIST_MIN_N &&
        medPeak < BLACKLIST_MAX_MEDIAN_PEAK &&
        medNow <= BLACKLIST_MAX_MEDIAN_NOW;
    const hotStreak = rate >= HOT_STREAK_RATE && slice.length >= HOT_STREAK_MIN_N;
    if (blacklisted) blacklistedCount++;
    if (hotStreak) hotStreakCount++;
    perTicker[ticker] = {
        recentWinRate: rate,
        recentAlertsCounted: slice.length,
        blacklisted,
        hotStreak,
    };
}

const out = {
    generatedAt: new Date().toISOString(),
    config: {
        TRAILING_N, BLACKLIST_RATE, BLACKLIST_MIN_N,
        BLACKLIST_MAX_MEDIAN_PEAK, BLACKLIST_MAX_MEDIAN_NOW,
        HOT_STREAK_RATE, HOT_STREAK_MIN_N,
    },
    perTicker,
};
const outPath = path.join(RESULTS_DIR, 'ticker-outcomes.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`✓ Wrote ${outPath}`);
console.log(`   ${Object.keys(perTicker).length} tickers classified`);
console.log(`   ${blacklistedCount} blacklisted (TD-21)`);
console.log(`   ${hotStreakCount} hot streak (TD-23)`);

if (blacklistedCount > 0) {
    console.log('\nTop 15 blacklisted:');
    Object.entries(perTicker)
        .filter(([, v]) => v.blacklisted)
        .sort((a, b) => a[1].recentWinRate - b[1].recentWinRate)
        .slice(0, 15)
        .forEach(([t, v]) => console.log(`   ${t.padEnd(12)} ${v.recentAlertsCounted} alerts, ${(v.recentWinRate*100).toFixed(0)}% win`));
}
if (hotStreakCount > 0) {
    console.log('\nTop 10 hot streak:');
    Object.entries(perTicker)
        .filter(([, v]) => v.hotStreak)
        .sort((a, b) => b[1].recentWinRate - a[1].recentWinRate)
        .slice(0, 10)
        .forEach(([t, v]) => console.log(`   ${t.padEnd(12)} ${v.recentAlertsCounted} alerts, ${(v.recentWinRate*100).toFixed(0)}% win`));
}
