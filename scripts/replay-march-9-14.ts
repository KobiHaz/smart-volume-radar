#!/usr/bin/env npx tsx
/**
 * Replay March 9–14, save as scan-replay-YYYY-MM-DD.json (does NOT overwrite scan-*.json).
 * Run: npm run replay-march-9-14
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import { fetchYahooChartAsOfDate } from '../src/services/marketData.js';
import { calculateRVOL } from '../src/services/rvolCalculator.js';
import { config } from '../src/config/index.js';
import type { RVOLResult } from '../src/types/index.js';
import { buildStoredScanResult } from '../src/utils/writeScanResults.js';
import pLimit from 'p-limit';

const limit = pLimit(3);
const resultsDir = path.join(process.cwd(), 'results');
const DAYS = ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14'];

async function main(): Promise<void> {
    process.stderr.write(`\n📊 Replay מרץ 9–14 → scan-replay-*.json\n\n`);

    const tickers = await (async () => {
        if (!process.env.GOOGLE_SHEET_ID?.trim()) {
            process.stderr.write('⚠️ GOOGLE_SHEET_ID לא מוגדר\n');
            process.exit(2);
        }
        await fetchAndCacheWatchlist();
        return loadWatchlist();
    })();

    fs.mkdirSync(resultsDir, { recursive: true });

    for (let i = 0; i < DAYS.length; i++) {
        const date = DAYS[i]!;
        process.stderr.write(`  [${i + 1}/${DAYS.length}] ${date}\n`);

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
        const file = path.join(resultsDir, `scan-replay-${date}.json`);
        fs.writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', 'utf-8');

        await new Promise((r) => setTimeout(r, 200));
    }

    process.stderr.write(`\n✅ נשמרו ${DAYS.length} קבצים: scan-replay-2026-03-09.json … scan-replay-2026-03-14.json\n`);
}

main().catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
});
