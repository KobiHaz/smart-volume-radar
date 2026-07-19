/**
 * Standalone Purple Fragility → D1 ingest (no Telegram, no full scan).
 *
 * Computes the fragility series as of the last trading day and writes the
 * ~250-row backfill to fragility_daily. Same fail-open contract as the daily
 * scan's ingest. Used by the manual backfill-fragility workflow (and handy
 * locally when CF_* env is available).
 *
 * Run: npx tsx scripts/ingest-fragility.ts
 */
import { computePurpleFragility } from '../src/services/purpleFragility.js';
import { ingestFragilityToD1 } from '../src/utils/fragilityD1Ingest.js';
import { getLastTradingDay } from '../src/utils/tradingDate.js';
import logger from '../src/utils/logger.js';

async function main(): Promise<void> {
    const scanDate = getLastTradingDay();
    const result = await computePurpleFragility(scanDate);
    if (!result) {
        logger.error('Fragility compute returned null — nothing ingested');
        process.exit(1);
    }
    const ok = await ingestFragilityToD1(result, scanDate);
    if (!ok) {
        logger.error('D1 fragility ingest failed or skipped (check CF_* env)');
        process.exit(1);
    }
    logger.info(`✅ fragility_daily backfilled through ${scanDate}`);
}

main().catch((err) => {
    logger.error('ingest-fragility failed:', (err as Error).message);
    process.exit(1);
});
