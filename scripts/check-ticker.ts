#!/usr/bin/env npx tsx
/**
 * Quick check: why did a ticker NOT appear in the radar?
 * Usage: npx tsx scripts/check-ticker.ts NBIS
 */
import 'dotenv/config';
import { validateTicker } from '../src/config/index.js';
import { fetchAllStocks } from '../src/services/marketData.js';

const ticker = process.argv[2]?.toUpperCase() || 'NBIS';

async function main(): Promise<void> {
    console.log(`\n🔍 Checking why ${ticker} did not appear in radar...\n`);

    // 1. Format validation
    const valid = validateTicker(ticker);
    console.log(`1. Ticker format valid: ${valid ? '✅' : '❌'}`);

    // 2. Fetch data
    const { stocks, failedTickers } = await fetchAllStocks([ticker]);
    if (failedTickers.includes(ticker)) {
        console.log(`2. Fetch: ❌ FAILED — no data from Yahoo or Twelve Data`);
        console.log(`   → Check: typo? delisted? needs exchange suffix (e.g. .TA, .L)?`);
        return;
    }

    const s = stocks[0]!;
    console.log(`2. Fetch: ✅ OK`);
    console.log(`   RVOL: ${s.rvol.toFixed(2)}x`);
    console.log(`   Price change: ${s.priceChange >= 0 ? '+' : ''}${s.priceChange.toFixed(2)}%`);
    console.log(`   Tags: ${(s.tags ?? []).join(', ') || 'none'}`);

    // 3. Thresholds (default config)
    const minRVOL = 2.0;
    const priceChangeThreshold = 2;
    const topN = 15;

    console.log(`\n3. Filter check:`);
    const greenPass = s.rvol >= minRVOL && Math.abs(s.priceChange) >= priceChangeThreshold;
    console.log(`   Green path (RVOL≥${minRVOL} AND |change|≥${priceChangeThreshold}%): ${greenPass ? '✅' : '❌'}`);
    console.log(`   → RVOL ${s.rvol.toFixed(2)} ${s.rvol >= minRVOL ? '≥' : '<'} ${minRVOL}`);
    console.log(`   → |priceChange| ${Math.abs(s.priceChange).toFixed(2)}% ${Math.abs(s.priceChange) >= priceChangeThreshold ? '≥' : '<'} ${priceChangeThreshold}%`);

    const tags = s.tags ?? [];
    const hasAllThree = tags.includes('SMA21 Touch') && tags.includes('Pullback 15%') && tags.includes('1M Breakout');
    console.log(`   Blue path (all 3 tags): ${hasAllThree ? '✅' : '❌'}`);
    if (!greenPass && !hasAllThree) {
        console.log(`\n   ❌ Result: ${ticker} does NOT meet green or blue path — will NOT appear in topSignals`);
    } else {
        console.log(`\n   ✅ Would appear in topSignals (if in watchlist + within top ${topN} by RVOL)`);
    }

    // 4. Watchlist
    console.log(`\n4. Watchlist: Check your Google Sheet — is ${ticker} in column A?`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
