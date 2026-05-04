#!/usr/bin/env npx tsx
/**
 * Retrospective: evaluate full setup (🎯) signals from last 30 days.
 * Groups by trading week (Mon–Sun) and produces weekly summaries.
 * Run: npm run evaluate-setups-30d
 * Env: GITHUB_TOKEN (or GH_TOKEN), FINNHUB_API_KEY.
 *      USE_LOCAL_RESULTS=1 — use existing results/*.json
 *      LOOKBACK_DAYS=30 — override (default 30)
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pLimit from 'p-limit';
import type { StoredScanResult } from '../src/types/index.js';
import { fetchAllStocks, fetchYahooChartAsOfDate } from '../src/services/marketData.js';

const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? '30', 10) || 30;
const RUN_LIMIT = Math.min(45, Math.ceil(LOOKBACK_DAYS * 1.5)); // enough runs for 30 calendar days
// Optional: restrict to date range (e.g. START_DATE=2026-02-01 END_DATE=2026-02-29 for February only)
const START_DATE = process.env.START_DATE || null;
const END_DATE = process.env.END_DATE || null;

interface FullSignal {
    ticker: string;
    date: string;
    priceThen: number;
}

interface OutputRow {
    ticker: string;
    date: string;
    weekStart: string;
    priceThen: number;
    priceNow: number | null;
    changePct: number | null;
    days: number;
}

/** ISO week start (Monday) for date YYYY-MM-DD */
function weekStartForDate(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00Z');
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
    return monday.toISOString().slice(0, 10);
}

function findScanJsonFiles(resultsDir: string): Array<{ path: string; date: string }> {
    const pairs: Array<{ path: string; date: string }> = [];
    const seen = new Set<string>();

    function add(date: string, filePath: string): void {
        if (seen.has(date)) return;
        seen.add(date);
        pairs.push({ path: filePath, date });
    }

    const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
    for (const e of entries) {
        if (e.isFile() && /^scan-\d{4}-\d{2}-\d{2}\.json$/.test(e.name)) {
            const date = e.name.replace(/^scan-/, '').replace(/\.json$/, '');
            add(date, path.join(resultsDir, e.name));
        }
        if (e.isDirectory() && /^scan-\d{4}-\d{2}-\d{2}$/.test(e.name)) {
            const date = e.name.replace(/^scan-/, '');
            const nested = path.join(resultsDir, e.name, `scan-${date}.json`);
            if (fs.existsSync(nested)) {
                add(date, nested);
            }
        }
    }
    return pairs.sort((a, b) => a.date.localeCompare(b.date));
}

function getReportPeriodLabel(): string {
    if (START_DATE && END_DATE) return `${START_DATE} עד ${END_DATE}`;
    return `${LOOKBACK_DAYS} יום`;
}

function formatReport(data: {
    rows: OutputRow[];
    avgChange: number;
    total: number;
    byWeek: Map<string, { rows: OutputRow[]; avg: number; winRate: number }>;
}): string {
    const periodLabel = getReportPeriodLabel();
    if (data.total === 0) {
        return `📊 רטרוספקטיבה ${periodLabel}\n\nלא נמצאו Setup מלא (🎯) בתקופה זו.`;
    }

    const lines: string[] = [
        `📊 רטרוספקטיבה ${periodLabel}`,
        '',
        `סה"כ: ${data.total} אותות | ממוצע Δ%: ${data.avgChange.toFixed(1)}%`,
        '',
        '--- סיכום לפי שבוע ---',
        '',
    ];

    const weekStarts = [...data.byWeek.keys()].sort();
    for (const ws of weekStarts) {
        const w = data.byWeek.get(ws)!;
        const wins = w.rows.filter((r) => r.changePct != null && r.changePct > 0).length;
        const totalWithPrice = w.rows.filter((r) => r.changePct != null).length;
        const winRate = totalWithPrice > 0 ? ((wins / totalWithPrice) * 100).toFixed(0) : 'N/A';
        lines.push(
            `שבוע ${ws}: ${w.rows.length} אותות | ממוצע ${w.avg.toFixed(1)}% | win rate ${winRate}%`
        );
        const top3 = [...w.rows]
            .filter((r) => r.changePct != null)
            .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
            .slice(0, 3);
        if (top3.length > 0) {
            lines.push(
                ...top3.map(
                    (r) =>
                        `  • ${r.ticker} (${r.date}): ${(r.changePct ?? 0) >= 0 ? '+' : ''}${(r.changePct ?? 0).toFixed(1)}%`
                )
            );
        }
        lines.push('');
    }

    const SHOW_ROWS = 25;
    lines.push(`--- כל האותות (לפי תאריך, ${data.rows.length > SHOW_ROWS ? `טופ ${SHOW_ROWS} לפי Δ%` : 'הכל'}) ---`);
    lines.push('TICKER | תאריך | מחיר אז | מחיר עכשיו | Δ% | ימים');
    const sortedForDisplay = [...data.rows].sort((a, b) => (b.changePct ?? -999) - (a.changePct ?? -999));
    for (const r of sortedForDisplay.slice(0, SHOW_ROWS)) {
        const now = r.priceNow != null ? r.priceNow.toFixed(2) : 'N/A';
        const ch =
            r.changePct != null
                ? `${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(1)}%`
                : 'N/A';
        lines.push(`${r.ticker} | ${r.date} | ${r.priceThen.toFixed(2)} | ${now} | ${ch} | ${r.days}`);
    }
    if (data.rows.length > SHOW_ROWS) {
        lines.push(`... ועוד ${data.rows.length - SHOW_ROWS} אותות`);
    }

    return lines.join('\n');
}

function ensureResultsDir(resultsDir: string): void {
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
}

function getRepoSlug(): { owner: string; repo: string } | null {
    try {
        const url = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
        const m = url.match(/(?:[:/])([^/]+)\/([^/.]+)(?:\.git)?$/);
        return m ? { owner: m[1], repo: m[2] } : null;
    } catch {
        return null;
    }
}

async function fetchArtifactsViaApi(resultsDir: string): Promise<boolean> {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const slug =
        process.env.GITHUB_REPOSITORY?.split('/').length === 2
            ? {
                  owner: process.env.GITHUB_REPOSITORY.split('/')[0],
                  repo: process.env.GITHUB_REPOSITORY.split('/')[1],
              }
            : getRepoSlug();
    if (!token || !slug) return false;

    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };

    try {
        const runsRes = await fetch(
            `https://api.github.com/repos/${slug.owner}/${slug.repo}/actions/workflows/daily-scan.yml/runs?per_page=${RUN_LIMIT}&status=completed`,
            { headers }
        );
        if (!runsRes.ok) return false;
        const runsData = (await runsRes.json()) as {
            workflow_runs: Array<{ id: number; conclusion: string }>;
        };
        const successful = runsData.workflow_runs
            .filter((r) => r.conclusion === 'success')
            .slice(0, RUN_LIMIT);

        for (const run of successful) {
            const artifactsRes = await fetch(
                `https://api.github.com/repos/${slug.owner}/${slug.repo}/actions/runs/${run.id}/artifacts`,
                { headers }
            );
            if (!artifactsRes.ok) continue;
            const artifactsData = (await artifactsRes.json()) as {
                artifacts: Array<{ id: number; name: string }>;
            };
            const scanArtifact = artifactsData.artifacts.find((a) =>
                /^scan-\d{4}-\d{2}-\d{2}$/.test(a.name)
            );
            if (!scanArtifact) continue;

            const zipRes = await fetch(
                `https://api.github.com/repos/${slug.owner}/${slug.repo}/actions/artifacts/${scanArtifact.id}/zip`,
                { headers, redirect: 'follow' }
            );
            if (!zipRes.ok) continue;
            const buf = Buffer.from(await zipRes.arrayBuffer());
            const zipPath = path.join(resultsDir, `artifact-${run.id}.zip`);
            fs.writeFileSync(zipPath, buf);
            try {
                execSync(`unzip -o -q "${zipPath}" -d "${resultsDir}"`, { stdio: 'pipe' });
            } finally {
                fs.unlinkSync(zipPath);
            }
        }
        return findScanJsonFiles(resultsDir).length > 0;
    } catch {
        return false;
    }
}

function fetchArtifactsViaGh(resultsDir: string): boolean {
    try {
        const runsJson = execSync(
            `gh run list --workflow daily-scan.yml --limit ${RUN_LIMIT} --json databaseId,conclusion,createdAt`,
            { encoding: 'utf-8' }
        );
        const runs = JSON.parse(runsJson) as Array<{
            databaseId: number;
            conclusion: string;
            createdAt: string;
        }>;
        const successful = runs.filter((r) => r.conclusion === 'success').slice(0, RUN_LIMIT);
        for (const run of successful) {
            try {
                execSync(`gh run download ${run.databaseId} -D ${resultsDir}`, { stdio: 'pipe' });
            } catch {
                /* skip missing artifact */
            }
        }
        return true;
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    const resultsDir = path.join(process.cwd(), 'results');
    const useLocal =
        process.env.USE_LOCAL_RESULTS === '1' || process.env.USE_LOCAL_RESULTS === 'true';

    ensureResultsDir(resultsDir);

    if (!useLocal) {
        let ok = fetchArtifactsViaGh(resultsDir);
        if (!ok) {
            ok = await fetchArtifactsViaApi(resultsDir);
        }
        if (!ok) {
            const existing = findScanJsonFiles(resultsDir);
            if (existing.length > 0) {
                process.stderr.write(
                    `gh unavailable and API fallback failed — using existing results/*.json (USE_LOCAL_RESULTS=1 to suppress)\n`
                );
            } else {
                const today = new Date().toISOString().slice(0, 10);
                const demoPath = path.join(resultsDir, `scan-${today}.json`);
                fs.writeFileSync(
                    demoPath,
                    JSON.stringify({ date: today, signals: [] } satisfies StoredScanResult, null, 2)
                );
                process.stderr.write(
                    `gh and API unavailable, no local artifacts — using empty demo. Set GITHUB_TOKEN or USE_LOCAL_RESULTS=1 with real results/ for full data.\n`
                );
            }
        }
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
    const dateMin = START_DATE ? new Date(START_DATE) : cutoff;
    const dateMax = END_DATE ? new Date(END_DATE + 'T23:59:59') : null;

    const fullSignals: FullSignal[] = [];
    const jsonFiles = findScanJsonFiles(resultsDir);
    const seen = new Set<string>();

    for (const { path: filePath, date } of jsonFiles) {
        const d = new Date(date);
        if (d < dateMin) continue;
        if (dateMax != null && d > dateMax) continue;
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredScanResult;
        for (const s of data.signals) {
            if (s.source === 'volumeWithoutPrice') continue;
            const key = `${s.ticker}|${date}`;
            if (seen.has(key)) continue;
            seen.add(key);
            fullSignals.push({ ticker: s.ticker, date, priceThen: s.lastPrice });
        }
    }

    if (fullSignals.length === 0) {
        const formatted = formatReport({
            rows: [],
            avgChange: 0,
            total: 0,
            byWeek: new Map(),
        });
        process.stdout.write(formatted + '\n');
        return;
    }

    // Fetch historical priceThen from Yahoo for each (ticker, date) for accuracy
    const limit = pLimit(3);
    const priceThenMap = new Map<string, number>();
    const fetchPriceThenTasks = fullSignals.map((s) =>
        limit(async () => {
            const key = `${s.ticker}|${s.date}`;
            const stock = await fetchYahooChartAsOfDate(s.ticker, s.date);
            const price = stock?.lastPrice ?? s.priceThen;
            priceThenMap.set(key, price);
        })
    );
    await Promise.all(fetchPriceThenTasks);

    // Fetch current prices for priceNow
    const uniqueTickers = [...new Set(fullSignals.map((s) => s.ticker))];
    const { stocks } = await fetchAllStocks(uniqueTickers);
    const priceNowMap = new Map(stocks.map((s) => [s.ticker, s.lastPrice]));

    const now = new Date();
    const rows: OutputRow[] = fullSignals.map((s) => {
        const key = `${s.ticker}|${s.date}`;
        const priceThen = priceThenMap.get(key) ?? s.priceThen;
        const priceNow = priceNowMap.get(s.ticker) ?? null;
        const changePct =
            priceNow != null ? ((priceNow - priceThen) / priceThen) * 100 : null;
        const days = Math.floor(
            (now.getTime() - new Date(s.date).getTime()) / (24 * 60 * 60 * 1000)
        );
        return {
            ticker: s.ticker,
            date: s.date,
            weekStart: weekStartForDate(s.date),
            priceThen,
            priceNow,
            changePct,
            days,
        };
    });

    const validChanges = rows.filter((r) => r.changePct != null);
    const avgChange =
        validChanges.length > 0
            ? validChanges.reduce((a, r) => a + (r.changePct ?? 0), 0) / validChanges.length
            : 0;

    const byWeek = new Map<string, { rows: OutputRow[]; avg: number; winRate: number }>();
    for (const r of rows) {
        const list = byWeek.get(r.weekStart) ?? { rows: [], avg: 0, winRate: 0 };
        list.rows.push(r);
        byWeek.set(r.weekStart, list);
    }
    for (const [ws, w] of byWeek) {
        const withPrice = w.rows.filter((r) => r.changePct != null);
        w.avg =
            withPrice.length > 0
                ? withPrice.reduce((a, r) => a + (r.changePct ?? 0), 0) / withPrice.length
                : 0;
        const wins = withPrice.filter((r) => (r.changePct ?? 0) > 0).length;
        w.winRate = withPrice.length > 0 ? (wins / withPrice.length) * 100 : 0;
    }

    const formatted = formatReport({ rows, avgChange, total: rows.length, byWeek });
    process.stdout.write(formatted + '\n');
}

main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
});
