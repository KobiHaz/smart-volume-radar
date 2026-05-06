/**
 * Smart Volume Radar - Main Entry Point
 * Orchestrates the daily stock volume scan and reporting
 */

import { loadWatchlist, validateConfig, config, getSectorForTicker, fetchAndCacheWatchlist, getInvalidTickersFromWatchlist, getIndexSkippedFromWatchlist } from './config/index.js';
import { classifyTickersWithGroq } from './services/llmSummary.js';
import { fetchAllStocksAsOfDate, fetchMarketRegime } from './services/marketData.js';
import { evaluateMomentumSetup } from './utils/setup.js';
import { applyChampionScore } from './utils/championScore.js';
import { calculateRVOL } from './services/rvolCalculator.js';
import { enrichWithNews } from './services/newsService.js';
import { sendDailyReport, sendTelegramMessage, formatMonitorTelegramMessage, GraduationInfo, MonitorMeta } from './services/telegramBot.js';
import { loadMonitorState, saveMonitorState } from './utils/monitorStore.js';
import { updateMonitorState } from './services/monitorTracker.js';
import { RVOLResult, MarketStatus, StockData } from './types/index.js';
import logger from './utils/logger.js';
import { formatErrorForTelegram } from './utils/errorHandler.js';
import { buildStoredScanResult, writeScanResults, writeScanDebug } from './utils/writeScanResults.js';
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

        // 3. Log LLM summary config (helps debug when summary doesn't appear)
        const llmProvider = config.llmProvider;
        const llmKey =
            llmProvider === 'gemini'
                ? config.geminiApiKey
                : llmProvider === 'perplexity'
                  ? config.perplexityApiKey
                  : llmProvider === 'groq'
                    ? config.groqApiKey
                    : config.openaiApiKey;
        logger.info(`LLM Summary: ${config.enableLlmSummary ? 'enabled' : 'DISABLED'} | provider=${llmProvider} | key=${llmKey ? '✓ set' : '✗ missing'}`);

        // 4. Fetch watchlist from Google Sheet and load symbols
        await fetchAndCacheWatchlist();
        const tickers = loadWatchlist();
        logger.info(`📋 Loaded ${tickers.length} tickers to scan`);

        // 5. Determine scan date (last US trading day) and fetch market data
        const scanDate = getLastTradingDay();
        logger.info(`📅 Scan date: ${scanDate} (last US trading day)`);
        // Market regime (bull/bear) from SPY vs SMA200 — scoped to scanDate so backtests stay honest.
        const marketRegime = await fetchMarketRegime(scanDate);
        logger.info(`🧭 Market regime: ${marketRegime.toUpperCase()} (SPY vs SMA200)`);
        const { stocks, failedTickers } = await fetchAllStocksAsOfDate(tickers, scanDate);
        // Tag every stock with the regime + run momentum evaluator (additive — does not affect existing pipeline).
        // Then apply the Champion Score layer (continuous score + action label + trade plan).
        for (const s of stocks) {
            s.marketRegime = marketRegime;
            s.momentum = evaluateMomentumSetup(s, { regime: marketRegime });
            applyChampionScore(s);
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
        const actionableStocks = stocks.filter(
            (s) =>
                s.action === 'BUY' ||
                s.action === 'WATCH' ||
                s.action === 'CAUTION_EXTENDED' ||
                s.action === 'CAUTION_NO_VOL'
        );
        const actionRank: Record<string, number> = {
            BUY: 0,
            CAUTION_EXTENDED: 1,
            CAUTION_NO_VOL: 1,
            WATCH: 2,
        };
        actionableStocks.sort((a, b) => {
            const aR = actionRank[a.action ?? ''] ?? 99;
            const bR = actionRank[b.action ?? ''] ?? 99;
            if (aR !== bR) return aR - bR;
            // within same action bucket, higher score first, then higher RVOL
            const sDiff = (b.championScore ?? 0) - (a.championScore ?? 0);
            if (Math.abs(sDiff) > 0.5) return sDiff;
            return (b.rvol ?? 0) - (a.rvol ?? 0);
        });
        const buyCount = actionableStocks.filter((s) => s.action === 'BUY').length;
        const watchCount = actionableStocks.filter((s) => s.action === 'WATCH').length;
        const cautionCount = actionableStocks.filter(
            (s) => s.action === 'CAUTION_EXTENDED' || s.action === 'CAUTION_NO_VOL'
        ).length;
        logger.info(`🎯 Telegram signals: ${buyCount} BUY + ${watchCount} WATCH + ${cautionCount} CAUTION`);

        // 7. Enrich with news — only actionable stocks (what Telegram sends)
        logger.info('📰 Enriching with news...');
        const enrichedMomentum = await enrichWithNews(actionableStocks);

        // Build RVOLResult shape (with sector). isVolumeWithoutPrice always false for momentum.
        const finalSignals: RVOLResult[] = enrichedMomentum.map((s) => ({
            ...s,
            sector: getSectorForTicker(s.ticker),
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

        const totalInSheet = tickers.length + invalidTickers.length + getIndexSkippedFromWatchlist().length;
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
        const resultsDir = path.join(__dirname, '..', 'results');
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
        });

        // JSON history keeps the legacy 3-path + silent set so backtest scripts still see them.
        // News not enriched here (it's only fetched for momentum stocks above) — empty array is fine.
        const legacyForHistory: RVOLResult[] = topSignals.map((s) => ({
            ...s,
            sector: getSectorForTicker(s.ticker),
            isVolumeWithoutPrice: false,
            news: [],
        }));
        const stored = buildStoredScanResult(scanDate, legacyForHistory, volumeWithoutPrice);
        writeScanResults(stored, resultsDir);
        writeScanDebug(
            { date: scanDate, failedTickers, fetchedCount: stocks.length, debug },
            resultsDir
        );
        logger.info(`📁 Saved results to ${resultsDir}/scan-${scanDate}.json`);
        logger.info(`📋 Saved scan-debug to ${resultsDir}/scan-debug-${scanDate}.json (greenSortedFull, failedTickers, for investigation)`);

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
