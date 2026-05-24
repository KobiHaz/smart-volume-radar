#!/usr/bin/env npx tsx
/**
 * Side-by-side comparison of Smart Radar vs Lean Radar over the same window.
 *
 * Inputs:
 *   - results/radar-reconstructed-{date}.json (Smart, from main)
 *   - /tmp/svr-stable/results/lean-reconstructed-{date}.json (Lean, from stable worktree)
 *
 * Computes forward 21d peak per (ticker, day) using Yahoo data (one fetch
 * per unique ticker, cached). Then pivots:
 *   - Smart-only firings (Smart actionable, Lean didn't fire on same day)
 *   - Lean-only firings (Lean breakout, Smart didn't fire)
 *   - Both (where they agreed)
 *   - Per-sector overlap + win rates
 *
 * Output: results/compare-radars-6mo-{date}.json + stdout summary.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(PROJECT_ROOT, 'results');
const LEAN_DIR = '/private/tmp/svr-stable/results';

const SMART_FILE = (() => {
    const files = fs.readdirSync(RESULTS_DIR)
        .filter((f) => /^radar-reconstructed-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort();
    return files[files.length - 1]!;
})();
const LEAN_FILE = (() => {
    const files = fs.readdirSync(LEAN_DIR)
        .filter((f) => /^lean-reconstructed-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort();
    return files[files.length - 1]!;
})();

console.log(`📂 Smart: ${SMART_FILE}`);
console.log(`📂 Lean:  ${LEAN_FILE}\n`);

interface SmartRec { action: string; championScore: number; sector: string; }
interface LeanRec { primary: string; sector: string; isStage2: boolean; }

const smart = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, SMART_FILE), 'utf8')) as {
    daysComputed: number;
    flaggedByDate: Record<string, Record<string, SmartRec>>;
};
const lean = JSON.parse(fs.readFileSync(path.join(LEAN_DIR, LEAN_FILE), 'utf8')) as {
    daysComputed: number;
    signalsByDate: Record<string, Record<string, LeanRec>>;
};

// Build per-(date, ticker) sets — only count "actionable" signals
// Smart actionable: BUY, WATCH, CAUTION_EXTENDED (the highest-confidence)
// Lean actionable: primary='breakout' or 'highVolume' (the "tradeable today" signals)
type EventKey = string; // `${date}|${ticker}`

const smartEvents = new Map<EventKey, SmartRec>();
const leanEvents = new Map<EventKey, LeanRec>();

for (const [date, recs] of Object.entries(smart.flaggedByDate)) {
    for (const [ticker, rec] of Object.entries(recs)) {
        if (rec.action === 'BUY' || rec.action === 'WATCH' || rec.action === 'CAUTION_EXTENDED') {
            smartEvents.set(`${date}|${ticker}`, rec);
        }
    }
}
for (const [date, recs] of Object.entries(lean.signalsByDate)) {
    for (const [ticker, rec] of Object.entries(recs)) {
        if (rec.primary === 'breakout' || rec.primary === 'highVolume') {
            leanEvents.set(`${date}|${ticker}`, rec);
        }
    }
}

// Union of all event keys + buckets
const allKeys = new Set([...smartEvents.keys(), ...leanEvents.keys()]);
const smartOnly: EventKey[] = [];
const leanOnly: EventKey[] = [];
const both: EventKey[] = [];
for (const k of allKeys) {
    const hasSmart = smartEvents.has(k);
    const hasLean = leanEvents.has(k);
    if (hasSmart && hasLean) both.push(k);
    else if (hasSmart) smartOnly.push(k);
    else leanOnly.push(k);
}

console.log(`📊 Signal volumes (actionable only):`);
console.log(`   Smart (BUY+WATCH+EXT):       ${smartEvents.size}`);
console.log(`   Lean  (breakout+highVolume): ${leanEvents.size}`);
console.log(`   Union (unique events):       ${allKeys.size}`);
console.log(`   Smart-only:                  ${smartOnly.length}`);
console.log(`   Lean-only:                   ${leanOnly.length}`);
console.log(`   Both (agreement):            ${both.length}`);
console.log(`   Smart-Lean Jaccard overlap:  ${(both.length / allKeys.size * 100).toFixed(1)}%`);

// ─── Fetch forward returns for each unique ticker ────────────────────
const uniqueTickers = new Set<string>();
for (const k of allKeys) uniqueTickers.add(k.split('|')[1]!);
console.log(`\n🔎 Fetching Yahoo for ${uniqueTickers.size} unique tickers...`);

const ohlcvCache = new Map<string, { timestamps: number[]; closes: number[] }>();
const limit = pLimit(8);
let fetched = 0;
await Promise.all([...uniqueTickers].map((t) => limit(async () => {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=2y`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return;
        const data = (await r.json()) as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> } };
        const res = data?.chart?.result?.[0];
        const ts = res?.timestamp ?? [];
        const closes = res?.indicators?.quote?.[0]?.close ?? [];
        const cleanTs: number[] = [];
        const cleanCl: number[] = [];
        for (let i = 0; i < ts.length; i++) {
            const c = closes[i];
            if (c != null && c > 0) { cleanTs.push(ts[i]!); cleanCl.push(c); }
        }
        if (cleanTs.length > 60) ohlcvCache.set(t, { timestamps: cleanTs, closes: cleanCl });
    } catch { /* skip */ }
    fetched++;
    if (fetched % 50 === 0) process.stderr.write(`   ${fetched}/${uniqueTickers.size}\n`);
})));
console.log(`   ✓ cached ${ohlcvCache.size}/${uniqueTickers.size}`);

function peak21d(ticker: string, date: string): number | null {
    const series = ohlcvCache.get(ticker);
    if (!series) return null;
    const t0 = new Date(date + 'T00:00:00Z').getTime() / 1000;
    let idx = -1;
    for (let i = 0; i < series.timestamps.length; i++) {
        if (series.timestamps[i]! >= t0) { idx = i; break; }
    }
    if (idx < 0) return null;
    const base = series.closes[idx]!;
    const end = Math.min(idx + 21, series.closes.length);
    const slice = series.closes.slice(idx, end);
    if (slice.length === 0) return null;
    return Math.max(...slice) / base - 1;
}

// ─── Compute win rates per bucket ────────────────────────────────────
function bucketStats(keys: EventKey[]): { n: number; wins: number; winRate: number; medPeak: number } {
    const peaks: number[] = [];
    let wins = 0;
    for (const k of keys) {
        const [date, ticker] = k.split('|');
        const p = peak21d(ticker!, date!);
        if (p == null) continue;
        peaks.push(p);
        if (p >= 0.10) wins++;
    }
    if (peaks.length === 0) return { n: 0, wins: 0, winRate: 0, medPeak: 0 };
    peaks.sort((a, b) => a - b);
    return {
        n: peaks.length,
        wins,
        winRate: wins / peaks.length,
        medPeak: peaks[Math.floor(peaks.length / 2)]!,
    };
}

const smartOnlyStats = bucketStats(smartOnly);
const leanOnlyStats = bucketStats(leanOnly);
const bothStats = bucketStats(both);
const smartAllStats = bucketStats([...smartEvents.keys()]);
const leanAllStats = bucketStats([...leanEvents.keys()]);

console.log(`\n📈 Win rates (peak21d ≥ +10%):`);
console.log(`   ${'Bucket'.padEnd(28)} ${'n'.padStart(5)} ${'wins'.padStart(5)} ${'WIN%'.padStart(5)} ${'medPeak'.padStart(8)}`);
console.log(`   ${'─'.repeat(70)}`);
function row(label: string, s: ReturnType<typeof bucketStats>): void {
    console.log(`   ${label.padEnd(28)} ${String(s.n).padStart(5)} ${String(s.wins).padStart(5)} ${(s.winRate*100).toFixed(0).padStart(4)}% ${(s.medPeak*100).toFixed(1).padStart(7)}%`);
}
row('Smart-only (Lean missed)', smartOnlyStats);
row('Lean-only (Smart missed)', leanOnlyStats);
row('Both (agreement)', bothStats);
row('Smart total', smartAllStats);
row('Lean total', leanAllStats);

// ─── Per-sector overlap ──────────────────────────────────────────────
const sectorStats = new Map<string, { smart: number; lean: number; both: number }>();
for (const k of allKeys) {
    const rec = smartEvents.get(k) ?? leanEvents.get(k)!;
    const sec = rec.sector;
    const cur = sectorStats.get(sec) ?? { smart: 0, lean: 0, both: 0 };
    if (smartEvents.has(k) && leanEvents.has(k)) cur.both++;
    else if (smartEvents.has(k)) cur.smart++;
    else cur.lean++;
    sectorStats.set(sec, cur);
}

console.log(`\n🏭 Per-sector overlap (top 12 by total events):`);
console.log(`   ${'Sector'.padEnd(28)} ${'Smart-only'.padStart(10)} ${'Lean-only'.padStart(10)} ${'Both'.padStart(6)} ${'Total'.padStart(6)}`);
[...sectorStats.entries()]
    .sort((a, b) => (b[1].smart + b[1].lean + b[1].both) - (a[1].smart + a[1].lean + a[1].both))
    .slice(0, 12)
    .forEach(([sec, s]) => {
        const tot = s.smart + s.lean + s.both;
        console.log(`   ${sec.padEnd(28)} ${String(s.smart).padStart(10)} ${String(s.lean).padStart(10)} ${String(s.both).padStart(6)} ${String(tot).padStart(6)}`);
    });

// ─── Write JSON output ───────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const out = {
    generatedAt: new Date().toISOString(),
    smartFile: SMART_FILE,
    leanFile: LEAN_FILE,
    daysComputed: smart.daysComputed,
    smartActionableCount: smartEvents.size,
    leanActionableCount: leanEvents.size,
    unionUnique: allKeys.size,
    smartOnlyCount: smartOnly.length,
    leanOnlyCount: leanOnly.length,
    bothCount: both.length,
    jaccardOverlap: both.length / allKeys.size,
    stats: {
        smartOnly: smartOnlyStats,
        leanOnly: leanOnlyStats,
        both: bothStats,
        smartAll: smartAllStats,
        leanAll: leanAllStats,
    },
    sectorOverlap: Object.fromEntries(sectorStats),
};
const outPath = path.join(RESULTS_DIR, `compare-radars-6mo-${today}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\n📁 Saved: ${outPath}`);
