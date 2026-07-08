/**
 * Smart Volume Radar — Lean Radar entrypoint (stable branch).
 *
 * Stripped-down pipeline: load watchlist → fetch → run 3 detectors →
 * format → send to Telegram. No Champion Score, no momentum tiers, no
 * monitor follow-up, no fundamentals, no graduation alerts. Just the
 * three crisp signals defined in `src/lean/signals.ts`.
 *
 * Runs on the same schedule as the experimental Radar (main), in the
 * SAME Telegram chat — the `🪶 LEAN RADAR` header makes it visually
 * distinct so the user can A/B-compare.
 */
import {
    fetchAndCacheWatchlist,
    loadWatchlist,
    validateConfig,
    getSectorForTicker,
} from './config/index.js';
import { fetchAllStocksAsOfDate } from './services/marketData.js';
import { sendTelegramMessage, chunkMessage } from './services/telegramBot.js';
import { getLastTradingDay } from './utils/tradingDate.js';
import logger from './utils/logger.js';
import { formatErrorForTelegram } from './utils/errorHandler.js';
import {
    detectConsolidationBreakout,
    detectConsolidationNearMiss,
    qualifiesAsHighVolume,
    qualifiesAsVolumeNearMiss,
    qualifiesAsHealthyPullback,
    qualifiesAsPullbackNearMiss,
    passesLeaderGate,
    isHvLeader,
    momentum63,
    LEADER_MOM63_MIN,
    qualifiesAsCreep,
} from './lean/signals.js';
import { loadRecentSignalTickers } from './lean/signalHistory.js';
import { formatLeanReport, type LeanScanResult } from './lean/format.js';
import { attachGraduated } from './lean/graduates.js';
import { writeTradingViewWatchlist } from './lean/tradingViewWatchlist.js';
import { writeDashboardRows } from './lean/dashboardRows.js';
import { writeLeanSnapshot } from './utils/snapshotWriter.js';
import { calculateSMA } from './utils/technicalAnalysis.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Yahoo chart returns OHLC — we need close/high/low arrays for the
 * consolidation detector. Refetch raw chart per ticker (cached at HTTP layer
 * by Yahoo's edge for up to a few seconds — fine for 366 watchlist).
 */
async function fetchOHLCSeries(
    ticker: string
): Promise<{ closes: number[]; highs: number[]; lows: number[] } | null> {
    const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
        `?interval=1d&range=2y`;
    try {
        const r = await fetch(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'application/json',
            },
        });
        if (!r.ok) return null;
        const data = (await r.json()) as {
            chart?: {
                result?: Array<{
                    indicators?: {
                        quote?: Array<{
                            close?: (number | null)[];
                            high?: (number | null)[];
                            low?: (number | null)[];
                        }>;
                    };
                }>;
            };
        };
        const q = data?.chart?.result?.[0]?.indicators?.quote?.[0];
        if (!q?.close) return null;
        const closes: number[] = [];
        const highs: number[] = [];
        const lows: number[] = [];
        for (let i = 0; i < q.close.length; i++) {
            const c = q.close[i];
            const h = q.high?.[i];
            const l = q.low?.[i];
            if (c == null || !Number.isFinite(c)) continue;
            closes.push(c);
            highs.push(h ?? c);
            lows.push(l ?? c);
        }
        return { closes, highs, lows };
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    logger.info('🪶 Smart Volume Radar — LEAN RADAR starting...');
    const startTime = Date.now();

    try {
        try {
            validateConfig();
        } catch (err) {
            logger.warn('Config validation warning: ' + (err as Error).message);
        }

        // Load watchlist
        await fetchAndCacheWatchlist();
        const tickers = loadWatchlist();
        logger.info(`📋 Loaded ${tickers.length} tickers`);

        const scanDate = getLastTradingDay();
        logger.info(`📅 Scan date: ${scanDate}`);

        // Fetch the standard StockData (gives us rvol, sma, pctFromAth, etc.)
        const { stocks, failedTickers } = await fetchAllStocksAsOfDate(tickers, scanDate);
        // Add sector
        for (const s of stocks) s.sector = getSectorForTicker(s.ticker);
        logger.info(`✅ Fetched ${stocks.length}/${tickers.length} stocks (${failedTickers.length} failed)`);

        // For consolidation detection we ALSO need the raw OHLC series.
        // Fetch in parallel (p-limit 5 via Promise.all batching to keep things simple).
        logger.info('🔍 Fetching OHLC series for consolidation detection...');
        const ohlcByTicker = new Map<string, { closes: number[]; highs: number[]; lows: number[] }>();
        const BATCH = 5;
        for (let i = 0; i < stocks.length; i += BATCH) {
            const batch = stocks.slice(i, i + BATCH);
            const results = await Promise.all(batch.map((s) => fetchOHLCSeries(s.ticker)));
            batch.forEach((s, idx) => {
                const r = results[idx];
                if (r) ohlcByTicker.set(s.ticker, r);
            });
        }
        logger.info(`📊 OHLC series fetched for ${ohlcByTicker.size}/${stocks.length} stocks`);

        // Market regime: SPY vs SMA50/200 (2026-07-08 regime study — pullbacks in
        // weak tape were the strongest setup measured; boost, don't filter).
        let regime: { spyAboveSma50: boolean; spyAboveSma200: boolean } | undefined;
        try {
            const spy = await fetchOHLCSeries('SPY');
            if (spy && spy.closes.length >= 200) {
                const last = spy.closes[spy.closes.length - 1]!;
                const sma50 = calculateSMA(spy.closes, 50);
                const sma200 = calculateSMA(spy.closes, 200);
                if (sma50 != null && sma200 != null) {
                    regime = { spyAboveSma50: last > sma50, spyAboveSma200: last > sma200 };
                    logger.info(
                        `🌡️ Regime: SPY ${regime.spyAboveSma50 ? 'above' : 'BELOW'} SMA50, ` +
                            `${regime.spyAboveSma200 ? 'above' : 'BELOW'} SMA200`
                    );
                }
            }
        } catch (e) {
            logger.warn(`⚠️ SPY regime fetch failed (scan proceeds without it): ${(e as Error).message}`);
        }

        // Run the 3 detectors + 3 near-miss variants
        const result: LeanScanResult = {
            consolidationBreakouts: [],
            highVolume: [],
            pullbacks: [],
            creep: [],
            nearConsolidation: [],
            nearVolume: [],
            nearPullback: [],
        };
        if (regime) result.regime = regime;

        // Cross-day dedup (2026-07-08 study): repeat near-breakouts are noise —
        // +0.89% med21 vs +1.70% for first alerts, at 10x the volume.
        const resultsDir = path.join(__moduleDir, '..', 'results');
        const recentNearBO = loadRecentSignalTickers(resultsDir, scanDate, 'nearConsolidation', 21);
        const recentCreep = loadRecentSignalTickers(resultsDir, scanDate, 'creep', 21);

        for (const stock of stocks) {
            const ohlc = ohlcByTicker.get(stock.ticker);
            // NOTE: an ADR>=2% floor was trialled here and REJECTED by the
            // criteria-tester validation (2026-07-08): ADR<2 breakouts actually
            // outperformed (+3.56% vs -0.16% med63) and the floor degraded the
            // gated nearBreakout tier (+6.10% -> +4.12% med63). ETF de-emphasis
            // is handled by the isETFSector score penalty instead.
            if (ohlc) {
                const consolidation = detectConsolidationBreakout(stock, ohlc.closes, ohlc.highs, ohlc.lows);
                if (consolidation) {
                    result.consolidationBreakouts.push({ stock, signal: consolidation });
                } else {
                    // Study gates: only FIRST alert in 21d AND 63d momentum >= 20%
                    // (206 alerts/yr instead of 6,837; +2.58% med21, win 64%).
                    const m = momentum63(ohlc.closes);
                    const nearC =
                        m != null && m >= LEADER_MOM63_MIN && !recentNearBO.has(stock.ticker)
                            ? detectConsolidationNearMiss(stock, ohlc.closes, ohlc.highs, ohlc.lows)
                            : null;
                    if (nearC) result.nearConsolidation.push({ stock, signal: nearC });
                }
            }
            const vol = qualifiesAsHighVolume(stock);
            if (vol) {
                // A-tier (2026-07-08 study): Stage2 leader near highs — 2x forward returns.
                vol.leader = ohlc ? isHvLeader(stock, ohlc.closes) : false;
                result.highVolume.push({ stock, signal: vol });
            } else {
                const nearV = qualifiesAsVolumeNearMiss(stock);
                if (nearV) result.nearVolume.push({ stock, signal: nearV });
            }
            const pb = qualifiesAsHealthyPullback(stock);
            if (pb && ohlc && passesLeaderGate(stock, ohlc.closes)) {
                result.pullbacks.push({ stock, signal: pb });
            } else {
                const nearP = qualifiesAsPullbackNearMiss(stock);
                if (nearP) result.nearPullback.push({ stock, signal: nearP });
            }
            // CREEP tier (2026-07-08 study): quiet Stage-2 leader near highs.
            // Covers the 58% of explosive moves that launch with no volume anomaly.
            if (ohlc && !recentCreep.has(stock.ticker)) {
                const cr = qualifiesAsCreep(stock, ohlc.closes);
                if (cr) result.creep.push({ stock, signal: cr });
            }
        }

        // Sort each section: best signal first.
        result.consolidationBreakouts.sort((a, b) => (b.stock.rvol ?? 0) - (a.stock.rvol ?? 0));
        result.highVolume.sort(
            (a, b) =>
                Number(b.signal.leader ?? false) - Number(a.signal.leader ?? false) ||
                (b.stock.rvol ?? 0) - (a.stock.rvol ?? 0)
        );
        result.pullbacks.sort((a, b) => (a.signal.pctFromAth ?? 0) - (b.signal.pctFromAth ?? 0));
        result.creep.sort((a, b) => b.signal.mom63 - a.signal.mom63);
        result.nearConsolidation.sort((a, b) => a.signal.distanceToPivotPct - b.signal.distanceToPivotPct);
        result.nearVolume.sort((a, b) => b.signal.rvol - a.signal.rvol);
        result.nearPullback.sort((a, b) => a.signal.pctFromAth - b.signal.pctFromAth);

        logger.info(
            `🎯 Lean signals: ${result.consolidationBreakouts.length} breakouts, ` +
                `${result.highVolume.length} high-volume, ${result.pullbacks.length} pullbacks ` +
                `+ ${result.nearConsolidation.length + result.nearVolume.length + result.nearPullback.length} near-misses`
        );

        // Attach Graduated cohort — stocks that were in yesterday's Silent
        // Watchlist (any near-*) and fired a real signal today. Empirically
        // the highest-quality cohort per 2026-05-13 conversion analysis.
        // Degrades to empty if no prior snapshot is available.
        attachGraduated(result, scanDate, path.join(__moduleDir, '..', 'results'));

        // Emit flat dashboard rows for D1 ingestion (independent of Telegram).
        try {
            const dashFile = writeDashboardRows(scanDate, result, path.join(__moduleDir, '..', 'results'));
            logger.info(`📊 Dashboard rows → ${dashFile}`);
        } catch (e) {
            logger.warn(`⚠️ dashboard rows emit failed: ${(e as Error).message}`);
        }

        // Format + send (chunked — Telegram's hard limit is 4096 chars per message)
        const message = formatLeanReport(scanDate, result);
        const chunks = chunkMessage(message);
        logger.info(`📤 Sending lean report (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})...`);
        if (!process.env.DRY_RUN) {
            for (let i = 0; i < chunks.length; i++) {
                if (i > 0) await new Promise((r) => setTimeout(r, 1200)); // gentle rate-limit
                await sendTelegramMessage(chunks[i]!);
            }
            logger.info('✉️ Lean report sent to Telegram');
        } else {
            logger.info('(DRY_RUN=1 — skipping Telegram send)');
            console.log('\n' + message.replace(/<[^>]+>/g, ''));
        }

        // TradingView watchlist export — daily file with every "approaching
        // breakout" ticker (graduated + real breakouts + near-pivot). Used by
        // manual paste-import into TradingView OR the browser-automation flow.
        try {
            const tvResultsDir = path.join(__moduleDir, '..', 'results');
            const tvOut = writeTradingViewWatchlist(scanDate, result, tvResultsDir);
            logger.info(
                `📋 TradingView watchlists: ` +
                    `${tvOut.breakouts.count} breakouts → ${path.relative(process.cwd(), tvOut.breakouts.latest)} ` +
                    `| ${tvOut.near.count} near → ${path.relative(process.cwd(), tvOut.near.latest)}`
            );
        } catch (tvErr) {
            logger.error('⚠️ Failed to write TradingView watchlist (non-fatal):', (tvErr as Error).message);
        }

        // Full debug snapshot for retrospective analysis (gitignored; captured
        // via GitHub Actions artifact). Contains every fetched stock + detections.
        try {
            const resultsDir = path.join(__moduleDir, '..', 'results');
            const snapshotPath = writeLeanSnapshot(
                {
                    scanDate,
                    runStartedAt: new Date(startTime).toISOString(),
                    version: process.env.npm_package_version ?? 'dev',
                    // marketRegime intentionally omitted — Lean Radar doesn't compute it
                    watchlist: {
                        total: tickers.length,
                        fetched: stocks.length,
                        failed: failedTickers,
                    },
                    detections: {
                        consolidationBreakouts: result.consolidationBreakouts.map((r) => ({
                            ticker: r.stock.ticker,
                            window: r.signal.window,
                            baseRangePct: r.signal.baseRangePct,
                            windowHigh: r.signal.windowHigh,
                        })),
                        highVolume: result.highVolume.map((r) => ({
                            ticker: r.stock.ticker,
                            level: r.signal.level,
                            rvol: r.stock.rvol ?? 0,
                        })),
                        pullbacks: result.pullbacks.map((r) => ({
                            ticker: r.stock.ticker,
                            pctFromAth: r.signal.pctFromAth,
                        })),
                        creep: result.creep.map((r) => ({
                            ticker: r.stock.ticker,
                            mom63: r.signal.mom63,
                            pctFromAth: r.signal.pctFromAth,
                        })),
                        nearConsolidation: result.nearConsolidation.map((r) => ({
                            ticker: r.stock.ticker,
                            window: r.signal.window,
                            distanceToPivotPct: r.signal.distanceToPivotPct,
                        })),
                        nearVolume: result.nearVolume.map((r) => ({
                            ticker: r.stock.ticker,
                            rvol: r.signal.rvol,
                        })),
                        nearPullback: result.nearPullback.map((r) => ({
                            ticker: r.stock.ticker,
                            pctFromAth: r.signal.pctFromAth,
                        })),
                    },
                    stocks,
                },
                resultsDir
            );
            if (snapshotPath) {
                logger.info(`📸 Saved lean snapshot to ${snapshotPath} (${stocks.length} stocks)`);
            }
        } catch (snapErr) {
            logger.error('⚠️ Failed to write lean snapshot (non-fatal):', (snapErr as Error).message);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.info(`✅ Lean scan complete in ${duration}s`);
    } catch (error) {
        logger.error('❌ Fatal error in lean scanner:', error);
        try {
            await sendTelegramMessage(`❌ <b>Lean Radar failed</b>\n\n${formatErrorForTelegram(error)}`);
        } catch {
            // ignore
        }
        process.exit(1);
    }
}

main();
