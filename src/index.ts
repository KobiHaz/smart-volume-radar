/**
 * Smart Volume Radar - Main Entry Point
 * Orchestrates the daily stock volume scan and reporting
 */

import { loadWatchlist, validateConfig, config, getSectorForTicker, fetchAndCacheWatchlist, getInvalidTickersFromWatchlist, getIndexSkippedFromWatchlist, getDisabledTickersFromWatchlist } from './config/index.js';
import { classifyTickersWithGroq } from './services/llmSummary.js';
import { fetchAllStocksAsOfDate, fetchMarketRegime, fetchSpy63dReturn, fetchMarketHealth } from './services/marketData.js';
import { evaluateMomentumSetup } from './utils/setup.js';
import { applyChampionScore } from './utils/championScore.js';
import { buildTickerStats, getTickerStats } from './utils/tickerStats.js';
import { applyRSPercentile } from './utils/rsPercentile.js';
import { applySectorRanks } from './utils/sectorRank.js';
import { enrichWithFundamentals } from './services/finnhubFundamentals.js';
import { calculateRVOL } from './services/rvolCalculator.js';
// News enrichment removed 2026-05-22 (Finnhub news feature deprecated).
// `enrichWithFundamentals` (separate concern — earnings + EPS) still imported above.
import { sendDailyReport, sendTelegramMessage, formatMonitorTelegramMessage, formatFragilityAlert, formatFragilityWatchAlert, GraduationInfo, MonitorMeta } from './services/telegramBot.js';
import { computePurpleFragility } from './services/purpleFragility.js';
import { ingestFragilityToD1 } from './utils/fragilityD1Ingest.js';
import { loadMonitorState, saveMonitorState } from './utils/monitorStore.js';
import { updateMonitorState } from './services/monitorTracker.js';
import { RVOLResult, MarketStatus, StockData } from './types/index.js';
import logger from './utils/logger.js';
import { formatErrorForTelegram } from './utils/errorHandler.js';
import { buildStoredScanResult, writeScanResults, writeScanDebug } from './utils/writeScanResults.js';
import { ingestSetupToD1 } from './utils/setupD1Ingest.js';
import { writeRadarSnapshot, computeActionDistribution } from './utils/snapshotWriter.js';
import { writeSmartTradingViewWatchlists } from './services/tradingViewWatchlist.js';
import { getLastTradingDay } from './utils/tradingDate.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Check if US market is open/closed for the day
 * Returns true if we should run the scan
 */
function checkMarketStatus(): MarketStatus {
    const now = new Date();
    // Get time in New York (EST/EDT)
    const nyTime = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hour12: false,
        weekday: 'long',
    }).formatToParts(now);

    const weekday = nyTime.find(p => p.type === 'weekday')?.value;
    const hour = parseInt(nyTime.find(p => p.type === 'hour')?.value || '0', 10);

    // Skip weekends (Saturday, Sunday)
    if (weekday === 'Saturday' || weekday === 'Sunday') {
        return {
            isOpen: false,
            exchange: 'NYSE/NASDAQ',
            currentTime: now,
            message: `Market closed (it is ${weekday} in NY)`,
        };
    }

    // US markets close at 16:00 (4 PM) EST. 
    // We ideally run after close for final daily volume.
    if (hour < 16) {
        const msg = `Market is still open (it is ${hour}:00 in NY). Data will be intraday.`;
        logger.warn(msg);
        return {
            isOpen: true,
            exchange: 'NYSE/NASDAQ',
            currentTime: now,
            message: msg
        };
    }

    return {
        isOpen: true,
        exchange: 'NYSE/NASDAQ',
        currentTime: now,
    };
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
    logger.info('🚀 Smart Volume Radar starting...');
    const startTime = Date.now();

    try {
        // 1. Check market status
        const marketStatus = checkMarketStatus();
        if (!marketStatus.isOpen && marketStatus.message && process.env.FORCE_SCAN !== 'true') {
            logger.info(marketStatus.message);
            await sendTelegramMessage(`📊 Smart Volume Radar\n\n${marketStatus.message}\nNo scan performed.`);
            return;
        } else if (process.env.FORCE_SCAN === 'true') {
            logger.info(`${marketStatus.message} - FORCING scan using last available data.`);
        }

        // 2. Validate configuration
        try {
            validateConfig();
        } catch (error) {
            // Don't fail completely if config is missing, just warn
            logger.warn('Config validation warning: ' + (error as Error).message);
            logger.info('Continuing with available configuration...');
        }

        // (LLM summary feature removed 2026-05-22 — see decisions-log.)
        // The Groq key is still used for ticker classification by classifyTickersWithGroq.
        logger.info(`Ticker classification (Groq): key=${config.groqApiKey ? '✓ set' : '✗ missing — will skip'}`);

        // 4. Fetch watchlist from Google Sheet and load symbols
        await fetchAndCacheWatchlist();
        const tickers = loadWatchlist();
        logger.info(`📋 Loaded ${tickers.length} tickers to scan`);

        // 5. Determine scan date (last US trading day) and fetch market data
        const scanDate = getLastTradingDay();
        logger.info(`📅 Scan date: ${scanDate} (last US trading day)`);
        const resultsDir = path.join(__dirname, '..', 'results');
        // Market regime (bull/bear) from SPY vs SMA200 — scoped to scanDate so backtests stay honest.
        const marketRegime = await fetchMarketRegime(scanDate);
        logger.info(`🧭 Market regime: ${marketRegime.toUpperCase()} (SPY vs SMA200)`);
        // ChampionScan-style 3-point market-health banner (display-only, gates nothing).
        const marketHealth = await fetchMarketHealth(scanDate);
        if (marketHealth) {
            logger.info(`🩺 Market health: ${marketHealth.label} (${marketHealth.score}/3)`);
        }
        // Purple List fragility score (display + separate crossing alert; gates nothing).
        const fragility = await computePurpleFragility(scanDate);
        if (fragility?.latest.score != null) {
            logger.info(
                `🟣 Fragility score: ${fragility.latest.score.toFixed(2)} ` +
                `(prev ${fragility.prevScore?.toFixed(2) ?? '—'}) | ` +
                `core3: ${fragility.latest.core3?.toFixed(2) ?? '—'} | ` +
                `climax: ${fragility.latest.climax?.toFixed(2) ?? '—'} | ` +
                `capitulation: ${fragility.latest.capitulation?.toFixed(2) ?? '—'}` +
                (fragility.crossedUp ? ' ⚠️ CROSSED (mean6+nearHigh)' : fragility.core3CrossedUp ? ` 🟡 Watch crossed (${fragility.watchTrigger})` : '')
            );
        }
        const { stocks, failedTickers } = await fetchAllStocksAsOfDate(tickers, scanDate);

        // BUG FIX 2026-05-22 (TD-1): fetchAllStocks doesn't populate `sector` —
        // it comes from the Google Sheet via getSectorForTicker. Without this
        // assignment here, applySectorRanks() skipped every stock (because
        // `if (!s.sector) continue`), and sectorRank / sectorMedianReturn63d
        // stayed null on all stocks. The new spam-fix sector filter in
        // formatNotableSection was silently a no-op as a result.
        for (const s of stocks) {
            s.sector = getSectorForTicker(s.ticker);
        }

        // Compute RS percentile across the watchlist using SPY's 63-day return as
        // the alpha baseline. Fail-soft: passes null → falls back to raw return.
        const spyReturn63d = await fetchSpy63dReturn(scanDate);
        applyRSPercentile(stocks, spyReturn63d);

        // Dynamic sector ranking (Phase 4B) — median return63d per sector,
        // mutates each stock's sectorRank / sectorMedianReturn63d / sectorTotalCount.
        const sectorRanks = applySectorRanks(stocks);
        if (sectorRanks.size > 0) {
            const top5 = Array.from(sectorRanks.entries())
                .sort((a, b) => a[1].rank - b[1].rank)
                .slice(0, 5)
                .map(
                    ([sec, info]) =>
                        `${sec} #${info.rank} ${info.median63d >= 0 ? '+' : ''}${info.median63d.toFixed(1)}% (n=${info.count})`
                )
                .join(' | ');
            logger.info(`🏭 Top sectors (63d median): ${top5}`);
        }

        // Enrich with Finnhub fundamentals (earnings date, EPS/Rev acceleration).
        // Fail-soft: API errors leave fields undefined and the score gracefully ignores them.
        // Cache TTL 7d → amortized ~100 API calls/day, well under free-tier 1k/day limit.
        try {
            const fStats = await enrichWithFundamentals(stocks, scanDate);
            logger.info(
                `💰 Fundamentals enrichment: ${fStats.enriched} stocks populated ` +
                `(${fStats.cacheHits} cache hits, ${fStats.apiCalls} API calls)`
            );
        } catch (fErr) {
            logger.warn(`Fundamentals enrichment failed (non-fatal): ${(fErr as Error).message}`);
        }
        const populated = stocks.filter((s) => s.rsPercentile != null).length;
        if (populated > 0) {
            const top = [...stocks]
                .filter((s) => s.rsPercentile != null)
                .sort((a, b) => (b.rsPercentile ?? 0) - (a.rsPercentile ?? 0))
                .slice(0, 5)
                .map((s) => `${s.ticker}=${s.rsPercentile}`)
                .join(', ');
            logger.info(`📊 RS percentile (${populated} stocks, SPY 63d=${spyReturn63d?.toFixed(1) ?? 'n/a'}%): ${top}`);
        }

        // Build per-ticker history stats once (drives TD-19/20/21/22/23
        // gates inside determineAction — Double BUY, ticker fatigue, sector
        // override, hot streak, auto blacklist). Falls back to empty Map if
        // no scan history yet — pipeline still works on a fresh repo.
        const tickerStatsMap = buildTickerStats(resultsDir, scanDate);
        if (tickerStatsMap.size > 0) {
            logger.info(`📊 Ticker history: ${tickerStatsMap.size} tickers in 20-td window`);
        }

        // Tag every stock with the regime + run momentum evaluator (additive — does not affect existing pipeline).
        // Then apply the Champion Score layer (continuous score + action label + trade plan).
        for (const s of stocks) {
            s.marketRegime = marketRegime;
            s.momentum = evaluateMomentumSetup(s, { regime: marketRegime });
            applyChampionScore(s, getTickerStats(tickerStatsMap, s.ticker));
        }
        logger.info(`✅ Fetched data for ${stocks.length}/${tickers.length} stocks`);

        if (stocks.length === 0) {
            await sendTelegramMessage('❌ Smart Volume Radar: No stock data available. Check API status.');
            return;
        }

        // 6. Calculate RVOL — kept only for JSON history / backtest scripts.
        //    Telegram is driven exclusively by momentum (see step 6.5).
        logger.info('🔢 Calculating RVOL (for JSON history)...');
        const { topSignals, volumeWithoutPrice, debug } = calculateRVOL(stocks, {
            minRVOL: config.minRVOL,
            topN: config.topN,
            priceChangeThreshold: config.priceChangeThreshold,
        });
        logger.info(`🎯 Legacy 3-path: ${topSignals.length} signals + ${volumeWithoutPrice.length} silent (history only)`);

        // 6.5. Action-based signal list — THIS is what Telegram sends.
        //      Built directly from `stocks`, filtered by Champion-Score action label.
        //      PASS and PASS_TOO_LATE are excluded (not actionable).
        // Telegram filter (2026-05-10 two-tier redesign):
        //   Tier 1 (full blocks): BUY / WATCH / CAUTION_EXTENDED — actionable.
        //   Tier 2 (compact one-liners): CAUTION_NO_VOL / CAUTION_DISTRIBUTION —
        //     informational warnings, shown so the user doesn't miss relevant
        //     setups currently lacking volume confirmation or under distribution.
        // The split is rendered inside formatDailyReport / formatNotableSection.
        const actionableStocks = stocks.filter(
            (s) =>
                s.action === 'BUY' ||
                s.action === 'WATCH' ||
                s.action === 'CAUTION_EXTENDED' ||
                s.action === 'CAUTION_NO_VOL' ||
                s.action === 'CAUTION_DISTRIBUTION'
        );
        const actionRank: Record<string, number> = {
            BUY: 0,
            CAUTION_EXTENDED: 1,
            CAUTION_NO_VOL: 1,
            CAUTION_DISTRIBUTION: 1,
            WATCH: 2,
        };
        actionableStocks.sort((a, b) => {
            const aR = actionRank[a.action ?? ''] ?? 99;
            const bR = actionRank[b.action ?? ''] ?? 99;
            if (aR !== bR) return aR - bR;
            // Within the same action bucket: RS percentile first, then RVOL.
            // The 2y score study (2026-07-09, 10,736 episodes) found the weighted
            // ChampionScore FLAT inside the momentum-gated stream (win63 67.5-71%
            // across all bands) while RS percentile kept a clean gradient
            // (RS 90-100: 75.1% / +17.9% med63 vs RS 50-69: 67.9% / +8.3%),
            // robust in both the trending and the choppy year.
            const rsDiff = (b.rsPercentile ?? -1) - (a.rsPercentile ?? -1);
            if (rsDiff !== 0) return rsDiff;
            return (b.rvol ?? 0) - (a.rvol ?? 0);
        });
        const buyCount = actionableStocks.filter((s) => s.action === 'BUY').length;
        const watchCount = actionableStocks.filter((s) => s.action === 'WATCH').length;
        const cautionCount = actionableStocks.filter(
            (s) => s.action === 'CAUTION_EXTENDED' || s.action === 'CAUTION_NO_VOL'
        ).length;
        logger.info(`🎯 Telegram signals: ${buyCount} BUY + ${watchCount} WATCH + ${cautionCount} CAUTION`);

        // 7. (News enrichment removed 2026-05-22 — see decisions-log.)
        // Build RVOLResult shape. sector is already populated above (before
        // applySectorRanks). isVolumeWithoutPrice always false for momentum.
        const finalSignals: RVOLResult[] = actionableStocks.map((s) => ({
            ...s,
            isVolumeWithoutPrice: false,
        }));

        // 8. Classify problematic tickers (invalid + failed) with Groq – INDEX/BOND excluded from Jules
        const invalidTickers = getInvalidTickersFromWatchlist();
        let indexTickers = [...getIndexSkippedFromWatchlist()];
        const combined = [...new Set([...invalidTickers, ...failedTickers])];

        if (combined.length > 0 && config.groqApiKey) {
            logger.info(`🔍 Classifying ${combined.length} problematic tickers with Groq...`);
            const classified = await classifyTickersWithGroq(combined);
            for (const [sym, type] of classified) {
                if (type === 'INDEX' || type === 'BOND') {
                    if (!indexTickers.includes(sym)) indexTickers.push(sym);
                }
            }
        }

        const llmIndicesSet = new Set(indexTickers);
        const fixableInvalid = invalidTickers.filter((t) => !llmIndicesSet.has(t));
        const fixableFailed = failedTickers.filter((t) => !llmIndicesSet.has(t));

        const disabledTickers = getDisabledTickersFromWatchlist();
        if (disabledTickers.length > 0) {
            logger.info(`⛔ ${disabledTickers.length} ticker(s) disabled in watchlist (Status = "disabled"): ${disabledTickers.join(', ')}`);
        }
        const totalInSheet = tickers.length + invalidTickers.length + getIndexSkippedFromWatchlist().length + disabledTickers.length;
        const notAnalyzed = fixableInvalid.length + indexTickers.length + fixableFailed.length;
        // SMA21 skip check covers everything we evaluated (so the diagnostic catches issues even
        // for stocks that never made the momentum cut).
        const sma21TouchSkippedTickers = stocks
            .filter((s) => !s.sma21 || s.sma21 <= 0 || !s.lastPrice || s.lastPrice <= 0)
            .map((s) => s.ticker);

        // 7.5. Monitor state update — must run BEFORE sendDailyReport so the report
        // can surface today's Watchlist→Full graduations at the top (highest-confidence
        // signal per 2026-05-05 criteria analysis: median +24% vs +2-7% for other tiers).
        const stocksByTicker = new Map<string, StockData>();
        for (const s of stocks) stocksByTicker.set(s.ticker.toUpperCase(), s);
        const monitorState = loadMonitorState(resultsDir);
        let monitorSummary: ReturnType<typeof updateMonitorState> | null = null;
        let graduations: GraduationInfo[] = [];
        try {
            logger.info('📊 Updating monitor follow-up state...');
            monitorSummary = updateMonitorState(monitorState, stocksByTicker, scanDate);
            saveMonitorState(monitorState, resultsDir);
            logger.info(`💾 Saved monitor-list.json (${monitorState.entries.length} entries)`);

            graduations = monitorSummary.transitions
                .filter((t) => t.newStatus === 'graduated')
                .map((t) => {
                    const e = t.entry;
                    const stock = stocksByTicker.get(e.ticker.toUpperCase());
                    const currentPrice = stock?.lastPrice ?? e.firstAlertPrice;
                    const returnPct = e.firstAlertPrice > 0
                        ? ((currentPrice - e.firstAlertPrice) / e.firstAlertPrice) * 100
                        : 0;
                    const daysSinceAlert = Math.max(
                        0,
                        Math.round(
                            (Date.parse(scanDate) - Date.parse(e.firstAlertDate)) / 86400_000
                        )
                    );
                    return {
                        ticker: e.ticker,
                        sector: e.sector,
                        firstAlertDate: e.firstAlertDate,
                        firstAlertPrice: e.firstAlertPrice,
                        currentPrice,
                        daysSinceAlert,
                        returnPct,
                    };
                });
            if (graduations.length > 0) {
                logger.info(`🎓 ${graduations.length} graduation(s) detected today — surfacing at top of report`);
            }
        } catch (monitorErr) {
            logger.error('⚠️ Monitor update failed (non-fatal):', (monitorErr as Error).message);
        }

        // Build per-ticker monitor metadata for persistence markers (🆕 / 🔁N).
        // Re-alert count comes from the entry's events; first-alert-today comes from the
        // entry's firstAlertDate matching scanDate.
        const monitorMetaByTicker = new Map<string, MonitorMeta>();
        for (const entry of monitorState.entries) {
            const reAlertCount = entry.events.filter((e) => e.type.startsWith('re-alert')).length;
            const isFirstAlertToday = entry.firstAlertDate === scanDate;
            const daysSinceFirst = Math.max(
                0,
                Math.round(
                    (Date.parse(scanDate) - Date.parse(entry.firstAlertDate)) / 86400_000
                )
            );
            monitorMetaByTicker.set(entry.ticker.toUpperCase(), {
                isFirstAlertToday,
                reAlertCount,
                daysSinceFirst,
            });
        }

        // 8. Telegram: momentum-only (finalSignals already filtered). Pass [] for silent activity.
        await sendDailyReport(scanDate, finalSignals, [], fixableFailed, {
            watchlistCount: tickers.length,
            invalidTickers: fixableInvalid,
            indexTickers,
            sma21TouchSkippedTickers,
            watchlistStats: {
                totalInSheet,
                analyzed: stocks.length,
                notAnalyzed,
                reasonInvalid: fixableInvalid.length,
                reasonIndex: indexTickers.length,
                reasonFetchFailed: fixableFailed.length,
            },
            graduations,
            monitorMetaByTicker,
            marketHealth,
            fragility,
        });

        // Fragility threshold-crossing alerts — separate messages, never fail the scan.
        // 🔴 Alert (mean6>=1.0 AND indexNearHigh) wins over 🟡 Watch
        // (core3>=1.0 OR climax>=1.5 AND indexNearHigh) on the same day.
        if (fragility?.crossedUp) {
            try {
                await sendTelegramMessage(formatFragilityAlert(fragility));
                logger.info('⚠️ Fragility crossing alert sent to Telegram');
            } catch (fragErr) {
                logger.warn('Fragility alert send failed (non-fatal): ' + (fragErr as Error).message);
            }
        } else if (fragility?.core3CrossedUp) {
            try {
                await sendTelegramMessage(formatFragilityWatchAlert(fragility));
                logger.info(`🟡 Fragility Watch (${fragility.watchTrigger}) alert sent to Telegram`);
            } catch (fragErr) {
                logger.warn('Fragility watch alert send failed (non-fatal): ' + (fragErr as Error).message);
            }
        }

        // JSON history keeps the legacy 3-path + silent set so backtest scripts still see them.
        // sector is already populated on stocks (see line ~130 — assigned before applySectorRanks).
        const legacyForHistory: RVOLResult[] = topSignals.map((s) => ({
            ...s,
            isVolumeWithoutPrice: false,
        }));
        const stored = buildStoredScanResult(scanDate, legacyForHistory, volumeWithoutPrice);
        writeScanResults(stored, resultsDir);
        writeScanDebug(
            { date: scanDate, failedTickers, fetchedCount: stocks.length, debug },
            resultsDir
        );
        logger.info(`📁 Saved results to ${resultsDir}/scan-${scanDate}.json`);

        // 8.05 Dashboard integration: push the day's Setup signals + RS
        // percentiles to D1 (own tables — read-merged by the dashboard API).
        // Soft-fail by design: a D1/network hiccup must not fail the scan.
        await ingestSetupToD1(stocks, scanDate);

        // 8.06 Fragility series → D1 (own table, soft-fail; no-op when compute failed).
        await ingestFragilityToD1(fragility, scanDate);

        // 8.1 Write TradingView watchlist files (BUY + WATCH) for nightly TV sync.
        // Files land in results/ alongside scan-*.json so the daily-scan GHA
        // upload-artifact step picks them up automatically.
        try {
            const tvOut = writeSmartTradingViewWatchlists(scanDate, stocks, resultsDir);
            logger.info(
                `📋 TV watchlists: BUY=${tvOut.buy.count} (${path.basename(tvOut.buy.latest)}), WATCH=${tvOut.watch.count} (${path.basename(tvOut.watch.latest)})`
            );
        } catch (tvErr) {
            logger.error('⚠️ Failed to write TV watchlists (non-fatal):', (tvErr as Error).message);
        }
        logger.info(`📋 Saved scan-debug to ${resultsDir}/scan-debug-${scanDate}.json (greenSortedFull, failedTickers, for investigation)`);

        // 8.4 Full debug snapshot (every fetched stock with all computed fields).
        // Persists per-day for retrospective debugging via GitHub Actions artifact.
        try {
            const snapshotPath = writeRadarSnapshot(
                {
                    scanDate,
                    runStartedAt: new Date(startTime).toISOString(),
                    version: process.env.npm_package_version ?? 'dev',
                    marketRegime,
                    watchlist: {
                        total: tickers.length,
                        fetched: stocks.length,
                        failed: failedTickers,
                    },
                    topSectors: Array.from(sectorRanks.entries())
                        .sort((a, b) => a[1].rank - b[1].rank)
                        .slice(0, 5)
                        .map(([sec, info]) => ({
                            sector: sec,
                            rank: info.rank,
                            median63d: info.median63d,
                            count: info.count,
                        })),
                    fragility: fragility
                        ? {
                              score: fragility.latest.score,
                              prevScore: fragility.prevScore,
                              crossedUp: fragility.crossedUp,
                              core3: fragility.latest.core3,
                              core3CrossedUp: fragility.core3CrossedUp,
                              climax: fragility.latest.climax,
                              watchTrigger: fragility.watchTrigger,
                              capitulation: fragility.latest.capitulation,
                              canaryCount: fragility.canaryCount,
                              indexNearHigh: fragility.indexNearHigh,
                              indexValue: fragility.latest.indexValue,
                              drawdownPct: fragility.latest.drawdownPct,
                          }
                        : undefined,
                    actionDistribution: computeActionDistribution(stocks),
                    telegramSentCount: finalSignals.length,
                    stocks,
                },
                resultsDir
            );
            if (snapshotPath) {
                logger.info(`📸 Saved radar snapshot to ${snapshotPath} (${stocks.length} stocks)`);
            }
        } catch (snapErr) {
            logger.error('⚠️ Failed to write radar snapshot (non-fatal):', (snapErr as Error).message);
        }

        // 8.5 Send the monitor follow-up message (separate from daily report).
        try {
            if (!monitorSummary) {
                throw new Error('Monitor state not initialized — skipping followup message');
            }
            // Send a separate Telegram message with the followup if there's anything to report.
            const monitorMsg = formatMonitorTelegramMessage(monitorSummary, monitorState, scanDate, stocksByTicker);
            if (monitorMsg) {
                await sendTelegramMessage(monitorMsg);
                logger.info('✉️ Monitor followup sent to Telegram');
            } else {
                logger.info('Monitor followup: nothing to report (no transitions, new entries, or active monitors)');
            }
        } catch (monitorErr) {
            // Monitor failures must never break the daily scan — log + continue.
            logger.error('⚠️ Monitor update failed (non-fatal):', (monitorErr as Error).message);
        }

        // 9. Write run-issues for Jules – only fixable tickers; skip if same issues as last Jules run (one fix attempt)
        const hasFixable = fixableInvalid.length > 0 || fixableFailed.length > 0;
        if (hasFixable) {
            const issuesHash = [...fixableInvalid, ...fixableFailed].sort().join('|');
            const lastPath = path.join(__dirname, '..', '.jules-last-issues.json');
            let skipJules = false;
            if (fs.existsSync(lastPath)) {
                try {
                    const last = JSON.parse(fs.readFileSync(lastPath, 'utf-8')) as {
                        hash?: string;
                        invalidTickers?: string[];
                        failedTickers?: string[];
                    };
                    const lastHash = [...(last.invalidTickers ?? []), ...(last.failedTickers ?? [])].sort().join('|');
                    if (lastHash === issuesHash) {
                        skipJules = true;
                        logger.info(
                            '⏭️ Same issues as last Jules run – skipping .scan-issues.json (one fix attempt)'
                        );
                    }
                } catch {
                    // ignore
                }
            }

            if (!skipJules) {
                const issuesFile = process.env.SCAN_ISSUES_FILE || '.scan-issues.json';
                const payload = {
                    date: scanDate,
                    invalidTickers: fixableInvalid,
                    failedTickers: fixableFailed,
                    summary: `Invalid format: ${fixableInvalid.length} | Fetch failed: ${fixableFailed.length}`,
                };
                fs.writeFileSync(issuesFile, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
                logger.info(`📝 Wrote ${issuesFile} for Jules auto-fix`);

                const lastPayload = {
                    hash: issuesHash,
                    invalidTickers: fixableInvalid,
                    failedTickers: fixableFailed,
                    date: scanDate,
                };
                fs.writeFileSync(
                    path.join(__dirname, '..', '.jules-last-issues.json'),
                    JSON.stringify(lastPayload, null, 2),
                    'utf-8'
                );
            }
        }

        // 10. Log completion
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.info(`\n✅ Report sent successfully in ${duration}s`);
        logger.info(`   Scanned: ${stocks.length} | Telegram(actionable): ${finalSignals.length} | History(3-path+silent): ${topSignals.length}+${volumeWithoutPrice.length}`);

    } catch (error) {
        const errorMessage = formatErrorForTelegram(error);
        logger.error('❌ Fatal error:', error);

        // Try to notify via Telegram
        try {
            await sendTelegramMessage(`❌ Smart Volume Radar failed:\n\n${errorMessage}`);
        } catch {
            logger.error('Failed to send error notification to Telegram');
        }

        process.exit(1);
    }
}

// Run
main();
