/**
 * One-off: compute the Purple List fragility score locally and print the last
 * 10 days plus the would-be Telegram header line and crossing alert (HTML
 * stripped). Does NOT send to Telegram and does NOT write to D1.
 *
 * Run: npx tsx scripts/preview-fragility.ts
 */
import { computePurpleFragility, FRAGILITY_THRESHOLD } from '../src/services/purpleFragility.js';
import { formatFragilityAlert } from '../src/services/telegramBot.js';
import { getLastTradingDay } from '../src/utils/tradingDate.js';
import logger from '../src/utils/logger.js';

const fmt = (x: number | null, digits = 2): string => (x == null ? '  —  ' : x.toFixed(digits).padStart(5));

async function main(): Promise<void> {
    const scanDate = getLastTradingDay();
    const result = await computePurpleFragility(scanDate);
    if (!result) {
        logger.error('Fragility compute returned null — see warnings above');
        process.exit(1);
    }

    logger.info('━━━━━ PURPLE FRAGILITY — last 10 days ━━━━━');
    logger.info('date        score  wick10 %>50  dist20 ext50  corr20 disp10  index   DD%   canary');
    for (const d of result.series.slice(-10)) {
        logger.info(
            `${d.date}  ${fmt(d.score)}  ${fmt(d.z.wick10)} ${fmt(d.z.pctAbove50)} ${fmt(d.z.dist20)} ` +
            `${fmt(d.z.ext50)} ${fmt(d.z.corr20)} ${fmt(d.z.disp10)}  ${d.indexValue.toFixed(3)}  ` +
            `${d.drawdownPct.toFixed(1).padStart(6)}  ${d.canaryCount ?? '—'}`
        );
    }
    logger.info(`Tickers: ${result.tickersUsed.join(', ')}${result.tickersFailed.length ? ` | failed: ${result.tickersFailed.join(', ')}` : ''}`);
    logger.info(`Latest: ${result.latest.score?.toFixed(2)} (prev ${result.prevScore?.toFixed(2) ?? '—'}) | crossedUp=${result.crossedUp} | threshold=${FRAGILITY_THRESHOLD}`);

    // Header line as it would appear in the daily report (plain text).
    const s = result.latest.score!;
    const emoji = s >= FRAGILITY_THRESHOLD ? '🔴' : s >= 0.5 ? '🟡' : '🟢';
    const canaryBit = result.indexNearHigh ? ` | Canary ${result.canaryCount}/${result.tickersUsed.length}` : '';
    logger.info('━━━━━ HEADER LINE ━━━━━');
    logger.info(`🟣 Purple Fragility: ${emoji} ${s.toFixed(2)} (סף ${FRAGILITY_THRESHOLD.toFixed(1)}) | DD ${result.latest.drawdownPct.toFixed(1)}%${canaryBit}`);

    logger.info('━━━━━ CROSSING ALERT (as it would render) ━━━━━');
    logger.info(formatFragilityAlert(result).replace(/<[^>]+>/g, ''));
}

main().catch((err) => {
    logger.error('preview-fragility failed:', (err as Error).message);
    process.exit(1);
});
