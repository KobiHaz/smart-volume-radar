/**
 * One-off: compute the Purple List fragility score locally and print the last
 * 10 days plus the would-be Telegram header line and crossing alert (HTML
 * stripped). Does NOT send to Telegram and does NOT write to D1.
 *
 * Run: npx tsx scripts/preview-fragility.ts
 */
import { computePurpleFragility, FRAGILITY_THRESHOLD, CORE3_THRESHOLD, CORE3_WATCH_DISPLAY, CLIMAX_THRESHOLD } from '../src/services/purpleFragility.js';
import { formatFragilityAlert, formatFragilityWatchAlert } from '../src/services/telegramBot.js';
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
    logger.info('date        score  core3 climax  cap.   wick10 %>50  dist20 ext50  corr20 disp10  index   DD%   canary  nearHigh');
    for (const d of result.series.slice(-10)) {
        logger.info(
            `${d.date}  ${fmt(d.score)}  ${fmt(d.core3)}  ${fmt(d.climax)}  ${fmt(d.capitulation)}  ${fmt(d.z.wick10)} ${fmt(d.z.pctAbove50)} ${fmt(d.z.dist20)} ` +
            `${fmt(d.z.ext50)} ${fmt(d.z.corr20)} ${fmt(d.z.disp10)}  ${d.indexValue.toFixed(3)}  ` +
            `${d.drawdownPct.toFixed(1).padStart(6)}  ${d.canaryCount ?? '—'}      ${d.indexNearHigh}`
        );
    }
    logger.info(`Tickers: ${result.tickersUsed.join(', ')}${result.tickersFailed.length ? ` | failed: ${result.tickersFailed.join(', ')}` : ''}`);
    logger.info(
        `Latest: ${result.latest.score?.toFixed(2)} (prev ${result.prevScore?.toFixed(2) ?? '—'}) | ` +
        `core3=${result.latest.core3?.toFixed(2) ?? '—'} | climax=${result.latest.climax?.toFixed(2) ?? '—'} | ` +
        `capitulation=${result.latest.capitulation?.toFixed(2) ?? '—'} | ` +
        `indexNearHigh=${result.indexNearHigh} | crossedUp=${result.crossedUp} | ` +
        `core3CrossedUp=${result.core3CrossedUp} (trigger=${result.watchTrigger ?? '—'}) | threshold=${FRAGILITY_THRESHOLD}`
    );

    // Header line as it would appear in the daily report (plain text) — mirrors
    // the two-tier emoji logic in telegramBot.ts's formatReportHeader.
    const s = result.latest.score!;
    const c3 = result.latest.core3;
    const climax = result.latest.climax;
    const capitulation = result.latest.capitulation;
    const nearHigh = result.indexNearHigh;
    const emoji =
        s >= FRAGILITY_THRESHOLD && nearHigh ? '🔴'
        : (c3 != null && c3 >= CORE3_WATCH_DISPLAY) || (climax != null && climax >= CLIMAX_THRESHOLD && nearHigh) ? '🟡'
        : '🟢';
    const canaryBit = nearHigh ? ` | Canary ${result.canaryCount}/${result.tickersUsed.length}` : '';
    const core3Bit = c3 != null ? ` | core3 ${c3.toFixed(2)}` : '';
    const climaxBit = climax != null ? ` | climax ${climax.toFixed(2)}` : '';
    const capitulationBit = capitulation != null ? ` | capitulation ${capitulation.toFixed(2)}` : '';
    logger.info('━━━━━ HEADER LINE ━━━━━');
    logger.info(`🟣 Purple Fragility: ${emoji} ${s.toFixed(2)} (סף ${FRAGILITY_THRESHOLD.toFixed(1)})${core3Bit}${climaxBit}${capitulationBit} | DD ${result.latest.drawdownPct.toFixed(1)}%${canaryBit}`);

    logger.info(`━━━━━ 🔴 ALERT (mean6≥${FRAGILITY_THRESHOLD}) — crossedUp=${result.crossedUp} ━━━━━`);
    logger.info(formatFragilityAlert(result).replace(/<[^>]+>/g, ''));

    logger.info(`━━━━━ 🟡 WATCH (core3≥${CORE3_THRESHOLD}) — core3CrossedUp=${result.core3CrossedUp} ━━━━━`);
    logger.info(formatFragilityWatchAlert(result).replace(/<[^>]+>/g, ''));
}

main().catch((err) => {
    logger.error('preview-fragility failed:', (err as Error).message);
    process.exit(1);
});
