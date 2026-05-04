#!/usr/bin/env npx tsx
/**
 * Regenerate all scan-YYYY-MM-DD.json in results/ with date-accurate data.
 * Uses fetchYahooChartAsOfDate so every file has data matching its date.
 *
 * Run: npm run regenerate-results
 * Env: GOOGLE_SHEET_ID.
 *
 * Options:
 *   REGENERATE_VERIFY_ONLY=1 — compare stored vs replayed lastPrice, report discrepancies (no overwrite)
 *   REGENERATE_START=2026-02-01 — only process dates >= this
 *   REGENERATE_END=2026-03-14 — only process dates <= this
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import { fetchYahooChartAsOfDate } from '../src/services/marketData.js';
import { calculateRVOL } from '../src/services/rvolCalculator.js';
import { config } from '../src/config/index.js';
import type { RVOLResult, StoredScanResult } from '../src/types/index.js';
import { buildStoredScanResult, writeScanResults } from '../src/utils/writeScanResults.js';
import pLimit from 'p-limit';

const limit = pLimit(3);
const resultsDir = path.join(process.cwd(), 'results');
const verifyOnly = process.env.REGENERATE_VERIFY_ONLY === '1' || process.env.REGENERATE_VERIFY_ONLY === 'true';
const startDate = process.env.REGENERATE_START || null;
const endDate = process.env.REGENERATE_END || null;

function getExistingScanDates(): Array<{ date: string; path: string }> {
    const out: Array<{ date: string; path: string }> = [];
    if (!fs.existsSync(resultsDir)) return out;
    for (const name of fs.readdirSync(resultsDir)) {
        const m = name.match(/^scan-(\d{4}-\d{2}-\d{2})\.json$/);
        if (m && !name.startsWith('scan-replay-') && !name.startsWith('scan-debug-')) {
            const date = m[1]!;
            if (startDate && date < startDate) continue;
            if (endDate && date > endDate) continue;
            out.push({ date, path: path.join(resultsDir, name) });
        }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
}

async function main(): Promise<void> {
    const datesToProcess = getExistingScanDates();
    if (datesToProcess.length === 0) {
        process.stderr.write('אין קבצי scan-YYYY-MM-DD.json לתוכן (או טווח התאריכים ריק).\n');
        return;
    }

    process.stderr.write(
        `\n📊 ${verifyOnly ? 'אימות' : 'יצירה מחדש'} ${datesToProcess.length} קבצים\n` +
            `   תאריכים: ${datesToProcess[0]!.date} – ${datesToProcess[datesToProcess.length - 1]!.date}\n` +
            (verifyOnly ? '   (REGENERATE_VERIFY_ONLY=1 — ללא כתיבה)\n' : '') +
            '\n'
    );

    const tickers = await (async () => {
        if (!process.env.GOOGLE_SHEET_ID?.trim()) {
            process.stderr.write('⚠️ GOOGLE_SHEET_ID לא מוגדר\n');
            process.exit(2);
        }
        await fetchAndCacheWatchlist();
        return loadWatchlist();
    })();

    fs.mkdirSync(resultsDir, { recursive: true });

    let mismatchCount = 0;
    for (let i = 0; i < datesToProcess.length; i++) {
        const { date, path: filePath } = datesToProcess[i]!;
        process.stderr.write(`  [${i + 1}/${datesToProcess.length}] ${date}`);

        const results = await Promise.all(
            tickers.map((t) => limit(() => fetchYahooChartAsOfDate(t, date)))
        );
        const stocks = results.filter((s): s is NonNullable<typeof s> => s != null);

        const { topSignals, volumeWithoutPrice } = calculateRVOL(stocks, {
            minRVOL: config.minRVOL,
            topN: config.topN,
            priceChangeThreshold: config.priceChangeThreshold,
        });

        if (verifyOnly) {
            const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredScanResult;
            const replayedMap = new Map(
                [...topSignals, ...volumeWithoutPrice].map((s) => [`${s.ticker}`, s.lastPrice])
            );
            const mismatches: string[] = [];
            for (const sig of stored.signals) {
                const replayed = replayedMap.get(sig.ticker);
                if (replayed != null && Math.abs(replayed - sig.lastPrice) > 0.01) {
                    mismatches.push(`${sig.ticker}: stored=${sig.lastPrice} replayed=${replayed.toFixed(2)}`);
                }
            }
            if (mismatches.length > 0) {
                process.stderr.write(` — ⚠️ ${mismatches.length} חריגות\n`);
                for (const m of mismatches.slice(0, 5)) process.stderr.write(`     ${m}\n`);
                if (mismatches.length > 5) process.stderr.write(`     ... ועוד ${mismatches.length - 5}\n`);
                mismatchCount++;
            } else {
                process.stderr.write(' — ✓\n');
            }
        } else {
            const stored = buildStoredScanResult(
                date,
                topSignals as unknown as RVOLResult[],
                volumeWithoutPrice
            );
            writeScanResults(stored, resultsDir);
            process.stderr.write(' — ✓\n');
        }

        await new Promise((r) => setTimeout(r, 200));
    }

    if (verifyOnly) {
        process.stderr.write(
            `\n${mismatchCount === 0 ? '✅' : '⚠️'} סיימנו: ${mismatchCount} קבצים עם חריגות.\n` +
                '   להרצה מחדש ללא אימות: npm run regenerate-results\n'
        );
    } else {
        process.stderr.write(`\n✅ נשמרו ${datesToProcess.length} קבצים ב־results/\n`);
    }
}

main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
});
