#!/usr/bin/env npx tsx
/**
 * Validate a past scan: compare replay (production code) vs actual scan results.
 * Exits 1 if there are unexplained misses (stocks in replay top but not in actual, and not in failedTickers).
 *
 * Run: npx tsx scripts/validate-scan.ts [YYYY-MM-DD]
 * If no date: uses most recent scan-debug in results/
 *
 * Used by scan-validation workflow; invokes Jules when issues found.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import { fetchYahooChartAsOfDate } from '../src/services/marketData.js';
import { calculateRVOL } from '../src/services/rvolCalculator.js';
import { config } from '../src/config/index.js';
import pLimit from 'p-limit';

const limit = pLimit(3);

interface ScanDebugPayload {
    date: string;
    failedTickers: string[];
    fetchedCount: number;
    debug: { greenSortedFull: Array<{ ticker: string; rvol: number; priceChange: number }>; greenCount: number };
}

interface StoredSignal {
    ticker: string;
    source: string;
}

interface StoredScanResult {
    date: string;
    signals: StoredSignal[];
}

function findLatestScanDate(resultsDir: string): string | null {
    const files = fs.readdirSync(resultsDir).filter((f) => f.startsWith('scan-debug-') && f.endsWith('.json'));
    if (files.length === 0) return null;
    const dates = files.map((f) => f.replace('scan-debug-', '').replace('.json', ''));
    dates.sort((a, b) => b.localeCompare(a));
    return dates[0]!;
}

async function main(): Promise<void> {
    const resultsDir = path.join(process.cwd(), 'results');
    const targetDate = process.argv[2] || findLatestScanDate(resultsDir);

    if (!targetDate) {
        console.error('❌ No scan-debug files in results/. Run a scan first.');
        process.exit(2);
    }

    const debugPath = path.join(resultsDir, `scan-debug-${targetDate}.json`);
    const scanPath = path.join(resultsDir, `scan-${targetDate}.json`);

    if (!fs.existsSync(debugPath)) {
        console.error(`❌ scan-debug-${targetDate}.json not found`);
        process.exit(2);
    }

    const debug = JSON.parse(fs.readFileSync(debugPath, 'utf-8')) as ScanDebugPayload;
    const failedSet = new Set(debug.failedTickers || []);

    const actualTopTickers = new Set<string>();
    if (fs.existsSync(scanPath)) {
        const scan = JSON.parse(fs.readFileSync(scanPath, 'utf-8')) as StoredScanResult;
        for (const s of scan.signals) {
            if (s.source === 'topSignals-green' || s.source === 'topSignals-pullback' || s.source === 'topSignals-sma21') actualTopTickers.add(s.ticker);
        }
    }

    console.log(`\n📋 Validating scan ${targetDate}`);
    console.log(`   Actual topSignals: ${actualTopTickers.size} | Failed: ${debug.failedTickers?.length ?? 0}\n`);

    const tickers = await (async () => {
        if (!process.env.GOOGLE_SHEET_ID?.trim()) {
            console.error('⚠️ GOOGLE_SHEET_ID not set — cannot load watchlist for replay');
            process.exit(2);
        }
        await fetchAndCacheWatchlist();
        return loadWatchlist();
    })();

    const results = await Promise.all(
        tickers.map((t) => limit(() => fetchYahooChartAsOfDate(t, targetDate)))
    );
    const stocks = results.filter((s): s is NonNullable<typeof s> => s != null);

    const { topSignals, debug: replayDebug } = calculateRVOL(stocks, {
        minRVOL: config.minRVOL,
        topN: config.topN,
        priceChangeThreshold: config.priceChangeThreshold,
    });

    const replayTopTickers = new Set(topSignals.map((s) => s.ticker));
    const inReplayNotActual = [...replayTopTickers].filter((t) => !actualTopTickers.has(t));

    const unexplained: string[] = [];
    const explainedByFetch: string[] = [];
    for (const t of inReplayNotActual) {
        if (failedSet.has(t)) explainedByFetch.push(t);
        else unexplained.push(t);
    }

    const report = {
        date: targetDate,
        replayTopCount: replayTopTickers.size,
        actualTopCount: actualTopTickers.size,
        inReplayNotActual: inReplayNotActual.length,
        explainedByFetch,
        unexplained,
        failedTickers: debug.failedTickers || [],
    };

    console.log('Result:');
    console.log(`  Replay topSignals: ${report.replayTopCount}`);
    console.log(`  Actual topSignals: ${report.actualTopCount}`);
    if (explainedByFetch.length > 0) {
        console.log(`  In replay but not actual (explained by fetch failure): ${explainedByFetch.join(', ')}`);
    }
    if (unexplained.length > 0) {
        console.log(`  ⚠️ UNEXPLAINED MISSES: ${unexplained.join(', ')}`);
    }

    const reportPath = path.join(process.cwd(), '.scan-validation-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    console.log(`\n📄 Report saved to ${reportPath}`);

    if (unexplained.length > 0) {
        console.log('\n❌ Validation FAILED — unexplained misses. Jules may be invoked to investigate.');
        process.exit(1);
    }
    console.log('\n✅ Validation OK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
