#!/usr/bin/env npx tsx
/**
 * Advanced retrospective analysis — Forward Returns approach.
 *
 * Key insight: each signal is measured independently at fixed
 * trading-day intervals from its own signal date (+3td, +5td, +10td, +20td).
 * This avoids the calendar-week bias where late-week signals have fewer
 * days to develop before the summary is computed.
 *
 * Efficiency: ONE Yahoo API call per unique ticker (full 5y history cached).
 * All price lookups (priceThen, forward returns, priceNow) come from that cache.
 *
 * Run: npm run evaluate-retro-advanced
 * Env:
 *   USE_LOCAL_RESULTS=1  — use existing results/*.json
 *   START_DATE=YYYY-MM-DD, END_DATE=YYYY-MM-DD
 *   LOOKBACK_DAYS=30 (default)
 *   NO_LLM=1  — skip Groq
 *   GROQ_API_KEY (required for LLM analysis)
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pLimit from 'p-limit';
import type { StoredScanResult, NewlogicTag } from '../src/types/index.js';
import { fetchAndCacheWatchlist, getSectorForTicker } from '../src/config/index.js';

const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? '30', 10) || 30;
const RUN_LIMIT = Math.min(45, Math.ceil(LOOKBACK_DAYS * 1.5));
const START_DATE = process.env.START_DATE || null;
const END_DATE = process.env.END_DATE || null;
const NO_LLM = process.env.NO_LLM === '1' || process.env.NO_LLM === 'true';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Forward return windows in trading days
const FWD_WINDOWS = [3, 5, 10, 20] as const;
type FwdWindow = (typeof FWD_WINDOWS)[number];

type Source = 'topSignals-green' | 'topSignals-pullback' | 'topSignals-sma21';

interface RawSignal {
    ticker: string;
    date: string;
    storedPrice: number;
    rvol: number;
    tags: NewlogicTag[];
    source: Source;
    sector: string;
}

interface ForwardReturn {
    td: FwdWindow;
    targetDate: string;       // YYYY-MM-DD of the +Ntd date
    price: number | null;
    changePct: number | null; // relative to priceThen
}

interface EnrichedSignal extends RawSignal {
    priceThen: number;          // close on signal day
    priceNow: number | null;    // most recent close in history
    changePct: number | null;   // priceThen → priceNow
    days: number;               // calendar days since signal
    isFirstSignal: boolean;
    weekStart: string;
    fwd: ForwardReturn[];       // [+3td, +5td, +10td, +20td]
}

interface GroupStats {
    count: number;
    withPrice: number;
    avgChangePct: number;
    winRate: number;
    fwdAvg: Map<FwdWindow, number>;     // avg forward return per window
    fwdWin: Map<FwdWindow, number>;     // win rate per window
    top3: Array<{ ticker: string; date: string; changePct: number }>;
}

// ─── Date utilities ──────────────────────────────────────────────────────────

/** Add N trading days (skipping Sat/Sun) to a YYYY-MM-DD string */
function addTradingDays(dateStr: string, n: number): string {
    const d = new Date(dateStr + 'T12:00:00Z');
    let count = 0;
    while (count < n) {
        d.setUTCDate(d.getUTCDate() + 1);
        if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) count++;
    }
    return d.toISOString().slice(0, 10);
}

function weekStartForDate(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00Z');
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
    return monday.toISOString().slice(0, 10);
}

// ─── Yahoo price history (one call per ticker) ───────────────────────────────

/** Fetch full daily close history from Yahoo; returns Map<YYYY-MM-DD, close> */
async function fetchPriceHistory(ticker: string): Promise<Map<string, number>> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5y`;
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
            },
        });
        if (!res.ok) return new Map();
        const data = (await res.json()) as {
            chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
        };
        const result = data?.chart?.result?.[0];
        if (!result?.timestamp) return new Map();
        const closes = result.indicators?.quote?.[0]?.close ?? [];
        const map = new Map<string, number>();
        for (let i = 0; i < result.timestamp.length; i++) {
            const c = closes[i];
            if (c != null && c > 0) {
                // Yahoo timestamps are market close time in ET; converting to YYYY-MM-DD in ET
                const d = new Date(result.timestamp[i]! * 1000);
                const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
                map.set(etDate, c);
            }
        }
        return map;
    } catch {
        return new Map();
    }
}

/**
 * Look up price on targetDate or first available date within maxDays.
 * Handles holidays by searching forward.
 */
function lookupPrice(history: Map<string, number>, targetDate: string, maxDaysAhead = 4): number | null {
    for (let i = 0; i <= maxDaysAhead; i++) {
        const d = new Date(targetDate + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + i);
        const key = d.toISOString().slice(0, 10);
        const p = history.get(key);
        if (p != null) return p;
    }
    return null;
}

function latestPrice(history: Map<string, number>): number | null {
    if (history.size === 0) return null;
    const sorted = [...history.keys()].sort();
    return history.get(sorted[sorted.length - 1]!) ?? null;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function computeStats(signals: EnrichedSignal[]): GroupStats {
    const withPrice = signals.filter((s) => s.changePct != null);
    const avgChangePct = withPrice.length > 0
        ? withPrice.reduce((a, s) => a + (s.changePct ?? 0), 0) / withPrice.length
        : 0;
    const wins = withPrice.filter((s) => (s.changePct ?? 0) > 0).length;
    const winRate = withPrice.length > 0 ? (wins / withPrice.length) * 100 : 0;

    const fwdAvg = new Map<FwdWindow, number>();
    const fwdWin = new Map<FwdWindow, number>();
    for (const td of FWD_WINDOWS) {
        const fwdSignals = signals.map((s) => s.fwd.find((f) => f.td === td)?.changePct ?? null).filter((x): x is number => x != null);
        if (fwdSignals.length > 0) {
            fwdAvg.set(td, fwdSignals.reduce((a, b) => a + b, 0) / fwdSignals.length);
            fwdWin.set(td, (fwdSignals.filter((x) => x > 0).length / fwdSignals.length) * 100);
        }
    }

    const top3 = [...withPrice]
        .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
        .slice(0, 3)
        .map((s) => ({ ticker: s.ticker, date: s.date, changePct: s.changePct ?? 0 }));

    return { count: signals.length, withPrice: withPrice.length, avgChangePct, winRate, fwdAvg, fwdWin, top3 };
}

function pct(n: number): string {
    return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function fwdLine(stats: GroupStats): string {
    return FWD_WINDOWS.map((td) => {
        const avg = stats.fwdAvg.get(td);
        const win = stats.fwdWin.get(td);
        if (avg == null) return `+${td}td: N/A`;
        return `+${td}td: ${pct(avg)} (${win!.toFixed(0)}%w)`;
    }).join(' | ');
}

function statsLine(label: string, stats: GroupStats): string {
    if (stats.count === 0) return `${label}: אין נתונים`;
    const top = stats.top3.map((t) => `${t.ticker} ${pct(t.changePct)}`).join(', ');
    const fwd = fwdLine(stats);
    return [
        `${label}: ${stats.count} אות | עכשיו: ממוצע ${pct(stats.avgChangePct)} win ${stats.winRate.toFixed(0)}%`,
        `   Forward: ${fwd}`,
        top ? `   טופ: ${top}` : '',
    ].filter(Boolean).join('\n');
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateScanData(files: Array<{ path: string; date: string }>): string[] {
    const issues: string[] = [];
    const seenFingerprint = new Map<string, string>();
    for (const { path: filePath, date } of files) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredScanResult;
        if (data.date !== date) {
            issues.push(`⚠️ תאריך לא תואם: ${date} (קובץ) vs ${data.date} (תוכן)`);
        }
        if (data.signals.length === 0) {
            issues.push(`⚠️ קובץ ריק: ${date}`);
            continue;
        }
        const fp = data.signals.map((s) => `${s.ticker}:${s.rvol.toFixed(1)}`).sort().join('|');
        if (seenFingerprint.has(fp) && data.signals.length > 5) {
            issues.push(`⚠️ תוכן זהה ב-${date} ו-${seenFingerprint.get(fp)} — אות כפול, בדוק regenerate`);
        } else {
            seenFingerprint.set(fp, date);
        }
        const green = data.signals.filter((s) => s.source !== 'volumeWithoutPrice').length;
        if (green === 0) issues.push(`⚠️ אין green signals ב-${date}`);
    }
    return issues;
}

// ─── Artifact fetching ────────────────────────────────────────────────────────

function getRepoSlug(): { owner: string; repo: string } | null {
    try {
        const url = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
        const m = url.match(/(?:[:/])([^/]+)\/([^/.]+)(?:\.git)?$/);
        return m ? { owner: m[1], repo: m[2] } : null;
    } catch { return null; }
}

async function fetchArtifactsViaApi(resultsDir: string, runLimit: number): Promise<boolean> {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const slug = process.env.GITHUB_REPOSITORY?.split('/').length === 2
        ? { owner: process.env.GITHUB_REPOSITORY.split('/')[0]!, repo: process.env.GITHUB_REPOSITORY.split('/')[1]! }
        : getRepoSlug();
    if (!token || !slug) return false;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    try {
        const runsRes = await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/actions/workflows/daily-scan.yml/runs?per_page=${runLimit}&status=completed`, { headers });
        if (!runsRes.ok) return false;
        const { workflow_runs } = (await runsRes.json()) as { workflow_runs: Array<{ id: number; conclusion: string }> };
        for (const run of workflow_runs.filter((r) => r.conclusion === 'success').slice(0, runLimit)) {
            const artRes = await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/actions/runs/${run.id}/artifacts`, { headers });
            if (!artRes.ok) continue;
            const { artifacts } = (await artRes.json()) as { artifacts: Array<{ id: number; name: string }> };
            const a = artifacts.find((x) => /^scan-\d{4}-\d{2}-\d{2}$/.test(x.name));
            if (!a) continue;
            const zipRes = await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/actions/artifacts/${a.id}/zip`, { headers, redirect: 'follow' });
            if (!zipRes.ok) continue;
            const zipPath = path.join(resultsDir, `artifact-${run.id}.zip`);
            fs.writeFileSync(zipPath, Buffer.from(await zipRes.arrayBuffer()));
            try { execSync(`unzip -o -q "${zipPath}" -d "${resultsDir}"`, { stdio: 'pipe' }); }
            finally { fs.unlinkSync(zipPath); }
        }
        return findScanJsonFiles(resultsDir).length > 0;
    } catch { return false; }
}

function fetchArtifactsViaGh(resultsDir: string, runLimit: number): boolean {
    try {
        const runs = JSON.parse(execSync(`gh run list --workflow daily-scan.yml --limit ${runLimit} --json databaseId,conclusion`, { encoding: 'utf-8' })) as Array<{ databaseId: number; conclusion: string }>;
        for (const run of runs.filter((r) => r.conclusion === 'success').slice(0, runLimit)) {
            try { execSync(`gh run download ${run.databaseId} -D ${resultsDir}`, { stdio: 'pipe' }); }
            catch { /* skip */ }
        }
        return true;
    } catch { return false; }
}

function findScanJsonFiles(resultsDir: string): Array<{ path: string; date: string }> {
    const pairs: Array<{ path: string; date: string }> = [];
    const seen = new Set<string>();
    if (!fs.existsSync(resultsDir)) return pairs;
    for (const e of fs.readdirSync(resultsDir, { withFileTypes: true })) {
        if (e.isFile() && /^scan-\d{4}-\d{2}-\d{2}\.json$/.test(e.name)) {
            const date = e.name.replace(/^scan-/, '').replace(/\.json$/, '');
            if (!seen.has(date)) { seen.add(date); pairs.push({ path: path.join(resultsDir, e.name), date }); }
        }
    }
    return pairs.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

async function callGroq(prompt: string): Promise<string | null> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    try {
        const res = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: 'You are a quantitative trading analyst. Respond in Hebrew. Be concise and actionable. Focus on forward returns data.' },
                    { role: 'user', content: prompt },
                ],
                max_tokens: 2000,
                temperature: 0.3,
            }),
        });
        if (!res.ok) { process.stderr.write(`Groq: ${res.status}\n`); return null; }
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (e) { process.stderr.write(`Groq error: ${(e as Error).message}\n`); return null; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const resultsDir = path.join(process.cwd(), 'results');
    const useLocal = process.env.USE_LOCAL_RESULTS === '1' || process.env.USE_LOCAL_RESULTS === 'true';

    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

    if (!useLocal) {
        let ok = fetchArtifactsViaGh(resultsDir, RUN_LIMIT);
        if (!ok) ok = await fetchArtifactsViaApi(resultsDir, RUN_LIMIT);
        if (!ok) process.stderr.write('Using existing results/ (gh unavailable)\n');
    }

    // Load sectors
    let hasSectors = false;
    if (process.env.GOOGLE_SHEET_ID) {
        try { await fetchAndCacheWatchlist(); hasSectors = true; process.stderr.write('Sectors loaded.\n'); }
        catch { process.stderr.write('Could not load sectors.\n'); }
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
    const dateMin = START_DATE ? new Date(START_DATE) : cutoff;
    const dateMax = END_DATE ? new Date(END_DATE + 'T23:59:59') : null;
    const periodLabel = START_DATE && END_DATE ? `${START_DATE} עד ${END_DATE}` : `${LOOKBACK_DAYS} יום`;

    const allFiles = findScanJsonFiles(resultsDir);
    const inRangeFiles = allFiles.filter(({ date }) => {
        const d = new Date(date);
        return d >= dateMin && (dateMax == null || d <= dateMax);
    });

    // --- Validation ---
    const issues = validateScanData(inRangeFiles);

    // --- Load raw signals ---
    const rawSignals: RawSignal[] = [];
    const seenKey = new Set<string>();
    for (const { path: filePath, date } of inRangeFiles) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredScanResult;
        for (const s of data.signals) {
            if (s.source === 'volumeWithoutPrice') continue;
            const key = `${s.ticker}|${date}`;
            if (seenKey.has(key)) continue;
            seenKey.add(key);
            rawSignals.push({
                ticker: s.ticker,
                date,
                storedPrice: s.lastPrice,
                rvol: s.rvol,
                tags: s.tags ?? [],
                source: s.source as Source,
                sector: hasSectors ? getSectorForTicker(s.ticker) : 'Unknown',
            });
        }
    }

    if (rawSignals.length === 0) {
        process.stdout.write(`📊 Forward Returns Analysis — ${periodLabel}\n\nלא נמצאו אותות.\n`);
        return;
    }

    // --- Fetch price histories (ONE call per unique ticker) ---
    const uniqueTickers = [...new Set(rawSignals.map((s) => s.ticker))];
    process.stderr.write(`Fetching price history for ${uniqueTickers.length} unique tickers (1 call each)...\n`);
    const limit = pLimit(3);
    const historyCache = new Map<string, Map<string, number>>();
    await Promise.all(
        uniqueTickers.map((ticker) =>
            limit(async () => {
                const history = await fetchPriceHistory(ticker);
                historyCache.set(ticker, history);
            })
        )
    );
    process.stderr.write(`Done fetching histories.\n`);

    // --- Mark first vs. repeat ---
    const firstDateByTicker = new Map<string, string>();
    for (const s of [...rawSignals].sort((a, b) => a.date.localeCompare(b.date))) {
        if (!firstDateByTicker.has(s.ticker)) firstDateByTicker.set(s.ticker, s.date);
    }

    // --- Enrich signals ---
    const now = new Date();
    const enriched: EnrichedSignal[] = rawSignals.map((s) => {
        const history = historyCache.get(s.ticker) ?? new Map<string, number>();
        const priceThen = lookupPrice(history, s.date) ?? s.storedPrice;
        const priceNow = latestPrice(history);
        const changePct = priceNow != null && priceThen > 0 ? ((priceNow - priceThen) / priceThen) * 100 : null;
        const days = Math.floor((now.getTime() - new Date(s.date).getTime()) / (24 * 60 * 60 * 1000));

        const fwd: ForwardReturn[] = FWD_WINDOWS.map((td) => {
            const targetDate = addTradingDays(s.date, td);
            const price = lookupPrice(history, targetDate);
            // Only report if targetDate is in the past (price available)
            const changePctFwd = price != null && priceThen > 0 ? ((price - priceThen) / priceThen) * 100 : null;
            return { td, targetDate, price, changePct: changePctFwd };
        });

        return {
            ...s,
            priceThen,
            priceNow,
            changePct,
            days,
            isFirstSignal: firstDateByTicker.get(s.ticker) === s.date,
            weekStart: weekStartForDate(s.date),
            fwd,
        };
    });

    // --- Aggregate stats ---
    const overall = computeStats(enriched);
    const firstOnly = computeStats(enriched.filter((s) => s.isFirstSignal));
    const repeatOnly = computeStats(enriched.filter((s) => !s.isFirstSignal));

    const bySource = new Map([
        ['🟢 Green (RVOL+מחיר)', computeStats(enriched.filter((s) => s.source === 'topSignals-green'))],
        ['🟠 Pullback 15%', computeStats(enriched.filter((s) => s.source === 'topSignals-pullback'))],
        ['🔵 SMA21 Touch', computeStats(enriched.filter((s) => s.source === 'topSignals-sma21'))],
    ]);

    const tagNames: NewlogicTag[] = ['Pullback 15%', '1M Breakout', 'SMA21 Touch'];
    const byTag = new Map<string, GroupStats>();
    for (const tag of tagNames) byTag.set(tag, computeStats(enriched.filter((s) => s.tags.includes(tag))));
    byTag.set('ללא תגיות', computeStats(enriched.filter((s) => s.tags.length === 0)));

    const byCombination = new Map([
        ['Pullback+Breakout', computeStats(enriched.filter((s) => s.tags.includes('Pullback 15%') && s.tags.includes('1M Breakout')))],
        ['Pullback+SMA21',    computeStats(enriched.filter((s) => s.tags.includes('Pullback 15%') && s.tags.includes('SMA21 Touch')))],
        ['Breakout+SMA21',    computeStats(enriched.filter((s) => s.tags.includes('1M Breakout')  && s.tags.includes('SMA21 Touch')))],
        ['כל 3 תגיות',       computeStats(enriched.filter((s) => s.tags.length === 3))],
    ]);

    const rvolBuckets = [
        { label: '1.2–2x', min: 1.2, max: 2 },
        { label: '2–3x',   min: 2,   max: 3 },
        { label: '3–5x',   min: 3,   max: 5 },
        { label: '5–10x',  min: 5,   max: 10 },
        { label: '>10x',   min: 10,  max: Infinity },
    ];
    const byRvol = new Map<string, GroupStats>();
    for (const b of rvolBuckets) byRvol.set(b.label, computeStats(enriched.filter((s) => s.rvol >= b.min && s.rvol < b.max)));

    const weekKeys = [...new Set(enriched.map((s) => s.weekStart))].sort();
    const byWeek = new Map<string, GroupStats>();
    for (const ws of weekKeys) byWeek.set(ws, computeStats(enriched.filter((s) => s.weekStart === ws)));

    const bySector = new Map<string, GroupStats>();
    if (hasSectors) {
        for (const sec of [...new Set(enriched.map((s) => s.sector))]) {
            const stats = computeStats(enriched.filter((s) => s.sector === sec));
            if (stats.count >= 3) bySector.set(sec, stats);
        }
    }

    // Repeat signal analysis
    const repeatMap = new Map<string, EnrichedSignal[]>();
    for (const s of enriched.filter((s) => !s.isFirstSignal)) {
        const list = repeatMap.get(s.ticker) ?? [];
        list.push(s);
        repeatMap.set(s.ticker, list);
    }
    const top10Repeats = [...repeatMap.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10);

    // Signal strength composite score (based on +5td forward return, the key trading window)
    interface ScoreRow { label: string; score: number; fwd5avg: number; fwd5win: number; count: number }
    const scored: ScoreRow[] = [];
    const scoreIt = (label: string, stats: GroupStats) => {
        if (stats.withPrice < 5) return;
        const avg5 = stats.fwdAvg.get(5) ?? 0;
        const win5 = stats.fwdWin.get(5) ?? 0;
        scored.push({ label, score: win5 * 0.6 + Math.min(avg5 * 3, 30), fwd5avg: avg5, fwd5win: win5, count: stats.count });
    };
    for (const [l, s] of byRvol) scoreIt(`RVOL ${l}`, s);
    for (const [l, s] of byTag) scoreIt(l, s);
    for (const [l, s] of byCombination) scoreIt(l, s);
    if (hasSectors) for (const [l, s] of bySector) scoreIt(l, s);
    scoreIt('אות ראשון', firstOnly);
    scoreIt('אות חוזר', repeatOnly);
    scored.sort((a, b) => b.score - a.score);

    // ─── Output ─────────────────────────────────────────────────────────────

    const lines: string[] = [
        `📊 Forward Returns Analysis — ${periodLabel}`,
        '',
        `סה"כ: ${overall.count} אותות | מניות ייחודיות: ${uniqueTickers.length} | ימי סריקה: ${inRangeFiles.length}`,
        `עד היום: ממוצע ${pct(overall.avgChangePct)} | win rate ${overall.winRate.toFixed(0)}%`,
        `Forward: ${fwdLine(overall)}`,
        '',
    ];

    if (issues.length > 0) {
        lines.push('═══ ⚠️ בעיות איכות נתונים ═══', ...issues, '');
    }

    lines.push(
        '═══ ביצועים לפי סוג אות ═══',
        ...([...bySource.entries()].map(([l, s]) => statsLine(l, s))),
        '',
        '═══ ראשון vs. חוזר ═══',
        statsLine('⭐ אות ראשון', firstOnly),
        statsLine('🔄 אות חוזר', repeatOnly),
        '',
        '═══ ביצועים לפי תגית ═══',
        ...[...tagNames, 'ללא תגיות'].map((t) => statsLine(t, byTag.get(t)!)),
        '',
        '═══ שילובי תגיות ═══',
        ...['Pullback+Breakout', 'Pullback+SMA21', 'Breakout+SMA21', 'כל 3 תגיות'].map((k) => statsLine(k, byCombination.get(k)!)),
        '',
        '═══ ביצועים לפי RVOL ═══',
        ...rvolBuckets.map((b) => statsLine(`RVOL ${b.label}`, byRvol.get(b.label)!)),
        '',
    );

    if (bySector.size > 0) {
        const sortedSectors = [...bySector.entries()].sort((a, b) => (b[1].fwdAvg.get(5) ?? 0) - (a[1].fwdAvg.get(5) ?? 0));
        lines.push(
            '═══ ביצועים לפי סקטור (מסודר לפי +5td) ═══',
            ...sortedSectors.map(([sec, s]) => statsLine(sec, s)),
            '',
        );
    }

    // Weekly — for market context only
    lines.push(
        '═══ הקשר שוקי שבועי (context, לא מדד איכות) ═══',
        ...weekKeys.map((ws) => {
            const s = byWeek.get(ws)!;
            const fwd5avg = s.fwdAvg.get(5);
            const fwd5win = s.fwdWin.get(5);
            return `שבוע ${ws}: ${s.count} אות | +5td: ${fwd5avg != null ? pct(fwd5avg) + ` (${fwd5win?.toFixed(0)}%w)` : 'N/A'} | עד היום: ${pct(s.avgChangePct)}`;
        }),
        '',
        '═══ 🏆 דירוג חוזק האות (+5td win rate) ═══',
        ...scored.slice(0, 10).map((s, i) =>
            `${i + 1}. ${s.label}: score=${s.score.toFixed(0)} | +5td ממוצע ${pct(s.fwd5avg)} | +5td win ${s.fwd5win.toFixed(0)}% | ${s.count} אות`
        ),
        '',
        '═══ מניות עם אות חוזר (top 10) ═══',
        ...top10Repeats.map(([ticker, sigs]) => {
            const first = enriched.find((s) => s.ticker === ticker && s.isFirstSignal);
            const fwdRepeat = computeStats(sigs).fwdAvg.get(5) ?? null;
            const fwdFirst = first ? first.fwd.find((f) => f.td === 5)?.changePct ?? null : null;
            const direction = fwdFirst != null && fwdRepeat != null
                ? fwdRepeat > fwdFirst ? '↑ continuation' : '↓ fade'
                : '';
            return `${ticker}: ${sigs.length}x חוזר | ראשון +5td: ${fwdFirst != null ? pct(fwdFirst) : 'N/A'} | חוזר +5td: ${fwdRepeat != null ? pct(fwdRepeat) : 'N/A'} ${direction}`;
        }),
        '',
        '═══ טופ 30 — אות ראשון, מסודר לפי +5td ═══',
        'TICKER | תאריך | RVOL | תגיות | סקטור | +3td | +5td | +10td | +20td | עד-היום',
        ...[...enriched]
            .filter((s) => s.isFirstSignal)
            .sort((a, b) => (b.fwd.find((f) => f.td === 5)?.changePct ?? -999) - (a.fwd.find((f) => f.td === 5)?.changePct ?? -999))
            .slice(0, 30)
            .map((s) => {
                const f = (td: FwdWindow) => { const v = s.fwd.find((f) => f.td === td)?.changePct; return v != null ? pct(v) : 'N/A'; };
                return `${s.ticker} | ${s.date} | ${s.rvol.toFixed(1)}x | ${s.tags.join('+') || '—'} | ${s.sector} | ${f(3)} | ${f(5)} | ${f(10)} | ${f(20)} | ${s.changePct != null ? pct(s.changePct) : 'N/A'}`;
            }),
    );

    process.stdout.write(lines.join('\n') + '\n');

    // ─── Groq ─────────────────────────────────────────────────────────────────

    if (NO_LLM || !process.env.GROQ_API_KEY) {
        if (!NO_LLM) process.stderr.write('\n(GROQ_API_KEY not set — skip LLM)\n');
        return;
    }

    process.stderr.write('\n🤖 Groq analysis...\n');

    const top5Setups = scored.slice(0, 5).map((s) => `${s.label}: +5td avg ${pct(s.fwd5avg)}, win ${s.fwd5win.toFixed(0)}%`).join('\n');
    const worstSetup = scored[scored.length - 1];

    const prompt = `
You are analyzing stock volume signal quality using forward returns (measured at fixed trading days from signal, NOT calendar weeks).
Period: ${periodLabel} | Total: ${overall.count} signals

## Key Forward Returns
Overall: +3td ${pct(overall.fwdAvg.get(3) ?? 0)} (${(overall.fwdWin.get(3) ?? 0).toFixed(0)}%w), +5td ${pct(overall.fwdAvg.get(5) ?? 0)} (${(overall.fwdWin.get(5) ?? 0).toFixed(0)}%w), +10td ${pct(overall.fwdAvg.get(10) ?? 0)}, +20td ${pct(overall.fwdAvg.get(20) ?? 0)}

First signal: +5td avg ${pct(firstOnly.fwdAvg.get(5) ?? 0)}, win ${(firstOnly.fwdWin.get(5) ?? 0).toFixed(0)}%
Repeat signal: +5td avg ${pct(repeatOnly.fwdAvg.get(5) ?? 0)}, win ${(repeatOnly.fwdWin.get(5) ?? 0).toFixed(0)}%

By Tag (+5td):
${[...tagNames, 'ללא תגיות'].map((t) => {
    const s = byTag.get(t)!;
    return `- ${t}: avg ${pct(s.fwdAvg.get(5) ?? 0)}, win ${(s.fwdWin.get(5) ?? 0).toFixed(0)}%`;
}).join('\n')}

By RVOL (+5td):
${rvolBuckets.map((b) => {
    const s = byRvol.get(b.label)!;
    return `- RVOL ${b.label}: avg ${pct(s.fwdAvg.get(5) ?? 0)}, win ${(s.fwdWin.get(5) ?? 0).toFixed(0)}% (${s.count} signals)`;
}).join('\n')}

Top setups by +5td score:
${top5Setups}

Weakest: ${worstSetup?.label ?? 'N/A'} — score ${worstSetup?.score.toFixed(0) ?? 'N/A'}

Questions:
1. What's the optimal entry setup for a +5td trade? (specify RVOL range + tag combination + first/repeat)
2. Which signal condition should be removed from the scanner (lowest quality)?
3. Write a concrete trading rule: "Enter when [condition], target exit at +Ntd, expected win rate X%"
4. Is +5td (1 week) the right exit window, or does a different window show better results?
5. For repeat signals: are they confirmation or noise? When is a repeat signal worth acting on?

Respond in Hebrew, concise and actionable.
`.trim();

    const narrative = await callGroq(prompt);
    if (narrative) {
        process.stdout.write('\n═══ 🤖 Groq — חוקי מסחר ═══\n\n');
        process.stdout.write(narrative + '\n');
    }
}

main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
});
