#!/usr/bin/env npx tsx
/**
 * Multi-event analysis — for tickers that were flagged multiple times in the
 * 63-td window, how did the repeated alerts perform?
 *
 * Five lenses:
 *   1. Top tickers by alert count (who squats Telegram)
 *   2. Per-ticker breakdown by action label (does BUY beat WATCH on the
 *      SAME ticker?)
 *   3. "Repeat penalty" — for each ticker, is alert #5 less valuable than
 *      alert #1? (decay of signal value as alerts pile up)
 *   4. Action-transition matrix — for consecutive flags X td apart, does
 *      "transition X → Y" predict outcome better than X alone?
 *   5. Stocks where ALL alerts won vs ALL alerts lost — clean winners /
 *      clean noise generators
 *
 * Input: results/precision-analysis-{date}.json
 * Output: stdout summary + results/multi-event-analysis-{date}.json
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(PROJECT_ROOT, 'results');

interface FlagWithOutcome {
    date: string;
    ticker: string;
    action: string;
    championScore: number;
    momentumLevel: string;
    rvol: number;
    barGain: number;
    sector: string;
    sectorMedianReturn63d: number | null;
    breakoutStage: string | null;
    pctFromAth: number | null;
    extensionPct: number | null;
    distributionDays: number;
    failedCriteria: string[];
    lastPrice: number;
    forward5d: number | null;
    forward10d: number | null;
    forward21d: number | null;
    peak21d: number | null;
    forwardNow: number | null;
    outcome: string;
    isWin: boolean;
}

// ─── Load ────────────────────────────────────────────────────────
const files = fs.readdirSync(RESULTS_DIR)
    .filter((f) => /^precision-analysis-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
if (files.length === 0) {
    console.error('❌ No precision-analysis-*.json found. Run precision-analysis.ts first.');
    process.exit(1);
}
const inPath = path.join(RESULTS_DIR, files[files.length - 1]!);
console.log(`📂 Loading: ${path.basename(inPath)}`);
const data = JSON.parse(fs.readFileSync(inPath, 'utf8')) as { flags: FlagWithOutcome[] };
const allFlags = data.flags.filter((f) => f.outcome !== 'no_data');
console.log(`   ${allFlags.length} flags with outcome data\n`);

// Group by ticker, sort chronologically
const byTicker = new Map<string, FlagWithOutcome[]>();
for (const f of allFlags) {
    const arr = byTicker.get(f.ticker) ?? [];
    arr.push(f);
    byTicker.set(f.ticker, arr);
}
for (const arr of byTicker.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Lens 1: Top tickers by alert count ──────────────────────────
console.log('═══ TOP 25 TICKERS BY ALERT COUNT ═══');
console.log(`${'Ticker'.padEnd(11)} ${'Sector'.padEnd(22)} ${'n'.padStart(4)} ${'WIN%'.padStart(5)} ${'medPeak'.padStart(8)} ${'medNow'.padStart(7)}  actions`);
const counted = [...byTicker.entries()].map(([t, arr]) => {
    const wins = arr.filter((x) => x.isWin).length;
    const peaks = arr.map((x) => x.peak21d!).sort((a, b) => a - b);
    const nows = arr.map((x) => x.forwardNow!).sort((a, b) => a - b);
    const actions = arr.reduce((acc, f) => { acc[f.action] = (acc[f.action] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    const actionsStr = Object.entries(actions).map(([k, v]) => `${k.replace('CAUTION_', 'C_')}=${v}`).join(' ');
    return {
        ticker: t,
        sector: arr[0]!.sector,
        n: arr.length,
        winRate: wins / arr.length,
        medPeak: peaks[Math.floor(peaks.length / 2)] ?? 0,
        medNow: nows[Math.floor(nows.length / 2)] ?? 0,
        actionsStr,
    };
}).sort((a, b) => b.n - a.n);

for (const r of counted.slice(0, 25)) {
    console.log(`${r.ticker.padEnd(11)} ${r.sector.slice(0, 20).padEnd(22)} ${String(r.n).padStart(4)} ${(r.winRate * 100).toFixed(0).padStart(4)}% ${(r.medPeak * 100).toFixed(1).padStart(7)}% ${(r.medNow * 100).toFixed(1).padStart(6)}%  ${r.actionsStr}`);
}

// ─── Lens 2: Same ticker — BUY vs WATCH vs other ─────────────────
console.log('\n═══ SAME TICKER — DOES ACTION LABEL MATTER? ═══');
console.log('(tickers with ≥3 BUY AND ≥3 of another label — proves the label discriminates)');
console.log(`${'Ticker'.padEnd(11)} ${'Sector'.padEnd(20)} BUY (n,win%,peak)  vs  OTHER (label,n,win%,peak)`);
const interesting: Array<{ ticker: string; sector: string; buyN: number; buyWin: number; buyPeak: number; otherLabel: string; otherN: number; otherWin: number; otherPeak: number }> = [];
for (const [ticker, arr] of byTicker) {
    const buys = arr.filter((f) => f.action === 'BUY');
    if (buys.length < 3) continue;
    const others: Record<string, FlagWithOutcome[]> = {};
    for (const f of arr) {
        if (f.action === 'BUY') continue;
        (others[f.action] ??= []).push(f);
    }
    for (const [label, list] of Object.entries(others)) {
        if (list.length < 3) continue;
        const buyWin = buys.filter((x) => x.isWin).length / buys.length;
        const otherWin = list.filter((x) => x.isWin).length / list.length;
        const buyPeak = [...buys].sort((a, b) => a.peak21d! - b.peak21d!)[Math.floor(buys.length / 2)]!.peak21d!;
        const otherPeak = [...list].sort((a, b) => a.peak21d! - b.peak21d!)[Math.floor(list.length / 2)]!.peak21d!;
        interesting.push({ ticker, sector: arr[0]!.sector, buyN: buys.length, buyWin, buyPeak, otherLabel: label, otherN: list.length, otherWin, otherPeak });
    }
}
interesting.sort((a, b) => (b.buyWin - b.otherWin) - (a.buyWin - a.otherWin));
for (const r of interesting.slice(0, 20)) {
    console.log(`${r.ticker.padEnd(11)} ${r.sector.slice(0, 18).padEnd(20)} BUY (${r.buyN}, ${(r.buyWin*100).toFixed(0)}%, ${(r.buyPeak*100).toFixed(1)}%)  vs  ${r.otherLabel} (${r.otherN}, ${(r.otherWin*100).toFixed(0)}%, ${(r.otherPeak*100).toFixed(1)}%)`);
}

// ─── Lens 3: Repeat penalty — does alert #5 perform like alert #1? ─
console.log('\n═══ REPEAT PENALTY — DOES THE Nth ALERT STILL WORK? ═══');
console.log('(for tickers flagged ≥3 times, compare 1st alert vs 2nd vs 3rd+)');

const ordPos: Record<string, { n: number; wins: number; peakSum: number; nowSum: number }> = {};
for (const arr of byTicker.values()) {
    if (arr.length < 3) continue;
    for (let i = 0; i < arr.length; i++) {
        const pos = i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : i < 5 ? '4th-5th' : i < 10 ? '6th-10th' : '11th+';
        const cur = ordPos[pos] ??= { n: 0, wins: 0, peakSum: 0, nowSum: 0 };
        cur.n++;
        if (arr[i]!.isWin) cur.wins++;
        cur.peakSum += arr[i]!.peak21d!;
        cur.nowSum += arr[i]!.forwardNow!;
    }
}
console.log(`${'Position'.padEnd(12)} ${'n'.padStart(5)} ${'WIN%'.padStart(5)} ${'avgPeak'.padStart(8)} ${'avgNow'.padStart(7)}`);
for (const p of ['1st', '2nd', '3rd', '4th-5th', '6th-10th', '11th+']) {
    const c = ordPos[p];
    if (!c) continue;
    console.log(`${p.padEnd(12)} ${String(c.n).padStart(5)} ${(c.wins/c.n*100).toFixed(0).padStart(4)}% ${(c.peakSum/c.n*100).toFixed(1).padStart(7)}% ${(c.nowSum/c.n*100).toFixed(1).padStart(6)}%`);
}

// ─── Lens 4: Action transition matrix ────────────────────────────
console.log('\n═══ ACTION TRANSITION MATRIX (consecutive flags ≤5 td apart) ═══');
console.log('When flag N has action X and flag N+1 (within 5 td) has action Y, what is Y\'s win rate?');
const transitions = new Map<string, { n: number; wins: number; peakSum: number }>();
for (const arr of byTicker.values()) {
    for (let i = 1; i < arr.length; i++) {
        const prev = arr[i - 1]!;
        const curr = arr[i]!;
        const daysApart = (new Date(curr.date).getTime() - new Date(prev.date).getTime()) / 86400000;
        if (daysApart > 7) continue; // only count "close" transitions
        const key = `${prev.action} → ${curr.action}`;
        const c = transitions.get(key) ?? { n: 0, wins: 0, peakSum: 0 };
        c.n++;
        if (curr.isWin) c.wins++;
        c.peakSum += curr.peak21d!;
        transitions.set(key, c);
    }
}
const transRows = [...transitions.entries()]
    .filter(([, c]) => c.n >= 5)
    .map(([k, c]) => ({ key: k, n: c.n, winRate: c.wins / c.n, avgPeak: c.peakSum / c.n }))
    .sort((a, b) => b.n - a.n);

console.log(`${'Transition'.padEnd(50)} ${'n'.padStart(5)} ${'WIN%'.padStart(5)} ${'avgPeak'.padStart(8)}`);
for (const r of transRows.slice(0, 25)) {
    console.log(`${r.key.padEnd(50)} ${String(r.n).padStart(5)} ${(r.winRate*100).toFixed(0).padStart(4)}% ${(r.avgPeak*100).toFixed(1).padStart(7)}%`);
}

// ─── Lens 5: Clean winners / clean losers (all alerts won / all lost) ─
console.log('\n═══ "CLEAN WINNERS" — tickers where 100% of ≥4 alerts won ═══');
const cleanWinners = counted.filter((t) => t.n >= 4 && t.winRate === 1.0);
for (const r of cleanWinners.slice(0, 20)) {
    console.log(`   ${r.ticker.padEnd(11)} ${r.sector.padEnd(20)} ${r.n} alerts, medPeak +${(r.medPeak*100).toFixed(1)}%, medNow +${(r.medNow*100).toFixed(1)}%  [${r.actionsStr}]`);
}
if (cleanWinners.length === 0) console.log('   (none)');

console.log('\n═══ "CLEAN LOSERS" — tickers where 0% of ≥4 alerts won ═══');
const cleanLosers = counted.filter((t) => t.n >= 4 && t.winRate === 0);
for (const r of cleanLosers.slice(0, 20)) {
    console.log(`   ${r.ticker.padEnd(11)} ${r.sector.padEnd(20)} ${r.n} alerts, medPeak ${(r.medPeak*100).toFixed(1)}%, medNow ${(r.medNow*100).toFixed(1)}%  [${r.actionsStr}]`);
}
if (cleanLosers.length === 0) console.log('   (none)');

// ─── Lens 6: Big winners — same ticker, same/different action, large gains ─
console.log('\n═══ TICKERS THAT POPPED 50%+ MULTIPLE TIMES (peak21d ≥ 50%, n ≥ 2) ═══');
const popsByTicker = new Map<string, FlagWithOutcome[]>();
for (const arr of byTicker.values()) {
    const bigPops = arr.filter((f) => f.peak21d! >= 0.5);
    if (bigPops.length >= 2) popsByTicker.set(bigPops[0]!.ticker, bigPops);
}
for (const [t, pops] of [...popsByTicker.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
    const sector = pops[0]!.sector;
    console.log(`   ${t.padEnd(11)} ${sector.padEnd(20)} ${pops.length} big pops:`);
    for (const p of pops) {
        console.log(`        ${p.date}  ${p.action.padEnd(22)} score=${p.championScore}  RVOL=${p.rvol.toFixed(2)}  peak=${(p.peak21d!*100).toFixed(1)}%  now=${(p.forwardNow!*100).toFixed(1)}%`);
    }
}

// ─── Write JSON ─────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const out = {
    generatedAt: new Date().toISOString(),
    totalFlags: allFlags.length,
    uniqueTickers: byTicker.size,
    topAlertCount: counted.slice(0, 50),
    repeatPenalty: ordPos,
    transitions: Object.fromEntries(transitions),
    cleanWinners,
    cleanLosers,
    multiPops: Object.fromEntries([...popsByTicker.entries()].map(([k, v]) => [k, v])),
};
const outPath = path.join(RESULTS_DIR, `multi-event-analysis-${today}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\n📁 Saved: ${outPath}`);
