#!/usr/bin/env npx tsx
/**
 * Replay scan only for MISSING days (Feb + Mar).
 * Scans results/ for existing scan-YYYY-MM-DD.json, replays missing days, writes same format.
 *
 * Run: npm run replay-missing-days
 * Env: GOOGLE_SHEET_ID.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import { fetchYahooChartAsOfDate } from '../src/services/marketData.js';
import { calculateRVOL } from '../src/services/rvolCalculator.js';
import { config } from '../src/config/index.js';
import type { RVOLResult } from '../src/types/index.js';
import { buildStoredScanResult, writeScanResults } from '../src/utils/writeScanResults.js';
import pLimit from 'p-limit';

const limit = pLimit(3);
const resultsDir = path.join(process.cwd(), 'results');

/** Trading days (Mon–Fri) in range */
function getTradingDays(from: Date, to: Date): string[] {
    const out: string[] = [];
    const cur = new Date(from);
    cur.setHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    while (cur <= end) {
        const day = cur.getUTCDay();
        if (day >= 1 && day <= 5) out.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}

function getExistingDates(): Set<string> {
    const out = new Set<string>();
    if (!fs.existsSync(resultsDir)) return out;
    for (const name of fs.readdirSync(resultsDir)) {
        const m = name.match(/^scan-(\d{4}-\d{2}-\d{2})\.json$/);
        if (m) out.add(m[1]!);
    }
    return out;
}

async function main(): Promise<void> {
    const febStart = new Date('2026-02-01');
    const marEnd = new Date('2026-03-14');
    const allDays = getTradingDays(febStart, marEnd);
    const existing = getExistingDates();
    const missing = allDays.filter((d) => !existing.has(d));

    if (missing.length === 0) {
        process.stderr.write('✅ אין ימים חסרים — כל פברואר ומרץ קיימים.\n');
        return;
    }

    process.stderr.write(`\n📊 Replay על ${missing.length} ימים חסרים: ${missing[0]}–${missing[missing.length - 1]}\n\n`);

    const tickers = await (async () => {
        if (!process.env.GOOGLE_SHEET_ID?.trim()) {
            process.stderr.write('⚠️ GOOGLE_SHEET_ID לא מוגדר\n');
            process.exit(2);
        }
        await fetchAndCacheWatchlist();
        return loadWatchlist();
    })();

    fs.mkdirSync(resultsDir, { recursive: true });

    for (let i = 0; i < missing.length; i++) {
        const date = missing[i]!;
        process.stderr.write(`  [${i + 1}/${missing.length}] ${date}\n`);

        const results = await Promise.all(
            tickers.map((t) => limit(() => fetchYahooChartAsOfDate(t, date)))
        );
        const stocks = results.filter((s): s is NonNullable<typeof s> => s != null);

        const { topSignals, volumeWithoutPrice } = calculateRVOL(stocks, {
            minRVOL: config.minRVOL,
            topN: config.topN,
            priceChangeThreshold: config.priceChangeThreshold,
        });

        const stored = buildStoredScanResult(date, topSignals as unknown as RVOLResult[], volumeWithoutPrice);
        writeScanResults(stored, resultsDir);

        await new Promise((r) => setTimeout(r, 200));
    }

    process.stderr.write(`\n✅ נשמרו ${missing.length} קבצים ב־results/\n`);
}

main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
});
