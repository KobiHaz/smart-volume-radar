/**
 * Smart Volume Radar - Telegram Bot Service
 * Sends formatted reports via Telegram Bot API
 */

import { RVOLResult, StockData, TelegramApiError } from '../types/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { isFullSetup, isCloseSetup } from '../utils/setup.js';
import { formatRVOL, formatPriceChange } from '../utils/formatters.js';
import { getReportSummary, getPerStockAnalyses, parseLlmReply, formatCodeVsLlmLine } from './llmSummary.js';

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Format setup indicator with clear status: met ✓, close ~, or far ✗
 * Shows actual value and how close/far from threshold when relevant
 */
function formatSetupIndicator(
    stock: StockData,
    athThreshold: number,
    athCloseThreshold: number,
    smaTouch: number,
    smaClose: number,
    baseMin: number,
    baseMax: number,
    baseCloseMin: number
): string[] {
    const lines: string[] = [];

    // SMA21
    if (stock.sma21 != null && stock.sma21 > 0) {
        const pctFromSMA = Math.abs(stock.lastPrice - stock.sma21) / stock.sma21 * 100;
        const met = pctFromSMA <= smaTouch;
        const close = !met && pctFromSMA <= smaClose;
        let detail = `${pctFromSMA.toFixed(1)}%`;
        if (met) detail += ` ✓ (req ≤${smaTouch}%)`;
        else if (close) detail += ` ~ (${(pctFromSMA - smaTouch).toFixed(1)}% over ${smaTouch}%, under ${smaClose}% close)`;
        else detail += ` ✗ (${(pctFromSMA - smaTouch).toFixed(1)}% over ${smaTouch}% threshold)`;
        lines.push(`<b>SMA21</b> ${detail}`);
    }

    // High (52-week; 5y removed as not relevant)
    if (stock.pctFromAth != null) {
        const absPct = Math.abs(stock.pctFromAth);
        const highLabel = '52w';
        const met = absPct <= athThreshold;
        const close = absPct > athThreshold && absPct <= athCloseThreshold;
        let detail = `${stock.pctFromAth.toFixed(0)}% from ${highLabel}`;
        if (met) detail += ` ✓ (req ≤${athThreshold}%)`;
        else if (close) detail += ` ~ (${(absPct - athThreshold).toFixed(0)}% over ${athThreshold}%, under ${athCloseThreshold}% close)`;
        else detail += ` ✗ (${(absPct - athThreshold).toFixed(0)}% over ${athThreshold}% threshold)`;
        lines.push(`<b>High</b> ${detail}`);
    }

    // Base (months in consolidation)
    if (stock.monthsInConsolidation != null) {
        const mo = stock.monthsInConsolidation;
        const moRounded = Math.round(mo);
        const met = mo >= baseMin && mo <= baseMax;
        const close = mo >= baseCloseMin && mo < baseMin;
        let detail = `${moRounded}mo base`;
        if (met) detail += ` ✓ (req ${baseMin}–${baseMax}mo)`;
        else if (close) detail += ` ~ (${(baseMin - mo).toFixed(1)}mo short of ${baseMin}mo, above ${baseCloseMin}mo)`;
        else if (mo < baseCloseMin) detail += ` ✗ (${(baseCloseMin - mo).toFixed(1)}mo short of ${baseCloseMin}mo threshold)`;
        else detail += ` ✗ (${(mo - baseMax).toFixed(1)}mo over ${baseMax}mo)`;
        lines.push(`<b>Base</b> ${detail}`);
    }

    return lines;
}

/**
 * Truncate string to max length with ellipsis
 */
function truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

/**
 * Send a message via Telegram Bot API
 * @param message - HTML formatted message
 */
export async function sendTelegramMessage(message: string): Promise<void> {
    const { telegramBotToken, telegramChatId } = config;

    if (!telegramBotToken || !telegramChatId) {
        logger.warn('Telegram credentials not configured, skipping send');
        logger.info('--- TELEGRAM MESSAGE PREVIEW ---\n' + message.replace(/<[^>]*>/g, '') + '\n--- END PREVIEW ---');
        return;
    }

    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: telegramChatId,
                text: message,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }),
        });

        if (!response.ok) {
            const error = (await response.json()) as TelegramApiError;
            let errorMessage = `Telegram API error: ${JSON.stringify(error)}`;

            if (error.description === 'Bad Request: chat not found') {
                errorMessage += '\n💡 TIP: Ensure your TELEGRAM_CHAT_ID is correct and the bot has been started by the user or added to the group.';
            }

            throw new Error(errorMessage);
        }

        logger.info('Telegram message sent successfully');
    } catch (error: unknown) {
        logger.error('Failed to send Telegram message', error);
        throw error;
    }
}

function formatFailedSection(failedTickers: string[]): string {
    if (failedTickers.length === 0) return '';
    return `\n\n━━━━━━━━━━━━━━━━━━━━━━\n⚠️ <b>Could not check (fetch error)</b>\n<code>${failedTickers.map((t) => escapeHtml(t)).join(', ')}</code>\n<i>(Check for typos or if the symbol is delisted)</i>`;
}

function formatReportHeader(date: string, bullish: number, bearish: number): string {
    return `🛰 <b>SMART VOLUME RADAR</b>\n📅 <code>${date}</code>\n🎭 Sentiment: ${bullish} 🟢 | ${bearish} 🔴\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
}

function buildStockUrls(stock: RVOLResult): { tvUrl: string; yahooUrl: string; newsUrl: string; newsLabel: string } {
    const isIsraeli = stock.ticker.endsWith('.TA');
    const tvTicker = stock.ticker.replace('.TA', '');
    const encTicker = encodeURIComponent(stock.ticker);
    const encTvTicker = encodeURIComponent(isIsraeli ? 'TASE-' + tvTicker : tvTicker);
    return {
        tvUrl: `https://www.tradingview.com/symbols/${encTvTicker}`,
        yahooUrl: `https://finance.yahoo.com/quote/${encTicker}`,
        newsUrl: isIsraeli
            ? `https://www.bizportal.co.il/searchresult?q=${encodeURIComponent(tvTicker)}`
            : `https://x.com/search?q=%24${encodeURIComponent(tvTicker)}`,
        newsLabel: isIsraeli ? 'BIZ' : 'X',
    };
}

function formatSingleStockBlock(stock: RVOLResult): string {
    const isIsraeli = stock.ticker.endsWith('.TA');
    let statusEmoji = stock.priceChange >= 0 ? '↗️' : '↘️';
    if (stock.rvol > 4) statusEmoji = '⚡️';
    else if (stock.rvol > 2) statusEmoji = '🔥';

    const trendColor = stock.priceChange >= 0 ? '🟢' : '🔴';
    const { tvUrl, yahooUrl, newsUrl, newsLabel } = buildStockUrls(stock);

    let block = `${statusEmoji} <b><a href="${tvUrl}">${escapeHtml(stock.ticker)}</a></b>\n`;
    block += `├ 📊 <b>RVOL</b> ${formatRVOL(stock.rvol)}\n`;
    block += `├ <b>Price</b> ${trendColor} ${formatPriceChange(stock.priceChange)}\n`;

    if (stock.rsi != null) {
        const rsiContext = stock.rsi > 70 ? ' ⚠️' : stock.rsi < 30 ? ' ✅' : '';
        block += `├ 📈 <b>RSI</b> ${stock.rsi.toFixed(0)}${rsiContext}\n`;
    }
    if (stock.sma50 != null) {
        const trend = stock.lastPrice > stock.sma50 ? 'Above SMA50' : 'Below SMA50';
        block += `├ ${trend}\n`;
    }

    const setupLines = formatSetupIndicator(
        stock,
        config.athThresholdPct,
        config.athCloseThresholdPct,
        config.sma21TouchThresholdPct,
        config.sma21CloseThresholdPct,
        config.consolidationMinMonths,
        config.consolidationMaxMonths,
        config.consolidationCloseMinMonths
    );
    if (setupLines.length > 0) {
        const setupEmoji = isFullSetup(stock) ? ' 🎯' : isCloseSetup(stock) ? ' 👀' : '';
        block += `├ 🎯 Setup${setupEmoji}\n`;
        for (const line of setupLines) block += `│   ${line}\n`;
    }

    block += `├ ⛓ <a href="${tvUrl}">TV</a>  <a href="${yahooUrl}">YF</a>  <a href="${newsUrl}">${newsLabel}</a>\n`;

    if (stock.news && stock.news.length > 0) {
        block += `└ 📑\n`;
        for (const news of stock.news.slice(0, 2)) {
            const source = news.source ? escapeHtml(news.source) + ' ' : '';
            const headline = escapeHtml(truncate(news.headline, 55));
            const safeUrl = news.url.startsWith('https://') ? news.url.replace(/"/g, '&quot;') : '#';
            block += `   • <a href="${safeUrl}">${source}${headline}</a>\n`;
        }
    } else {
        block += isIsraeli ? `└ 📑 <a href="${newsUrl}">BizPortal news</a>\n` : `└ <i>No recent news</i>\n`;
    }
    block += `\n`;
    return block;
}

function formatVolumeWithoutPriceSection(volumeWithoutPrice: StockData[]): string {
    if (volumeWithoutPrice.length === 0) return '';
    const items = volumeWithoutPrice
        .sort((a, b) => b.rvol - a.rvol)
        .slice(0, 5)
        .map(
            (s) =>
                `• <b>${escapeHtml(s.ticker)}</b> (${formatRVOL(s.rvol)})${isFullSetup(s) ? ' 🎯' : isCloseSetup(s) ? ' 👀' : ''}`
        )
        .join('\n');
    return `━━━━━━━━━━━━━━━━━━━━━━\n👀 <b>SILENT ACTIVITY WATCHLIST</b>\n<i>(High RVOL, low price change - potential breakouts)</i>\n${items}`;
}

/**
 * Split message into chunks that fit Telegram's limit
 */
function chunkMessage(message: string, maxLen: number = TELEGRAM_MAX_LENGTH): string[] {
    if (message.length <= maxLen) {
        return [message];
    }

    const chunks: string[] = [];
    const lines = message.split('\n');
    let currentChunk = '';

    for (const line of lines) {
        if (currentChunk.length + line.length + 1 > maxLen) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
            }
            currentChunk = line + '\n';
        } else {
            currentChunk += line + '\n';
        }
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

/**
 * Format the daily report message
 */
export function formatDailyReport(
    date: string,
    topSignals: RVOLResult[],
    volumeWithoutPrice: StockData[],
    failedTickers: string[] = []
): string {
    const failedSection = formatFailedSection(failedTickers);

    if (topSignals.length === 0) {
        return `📊 <b>Smart Volume Radar</b>\n📅 ${date}\n\n📭 No high-volume signals detected today.\n\nEverything within normal range.${failedSection}`;
    }

    const sortedSignals = [...topSignals].sort((a, b) => b.rvol - a.rvol);
    const bullish = topSignals.filter((s) => s.priceChange > 0).length;
    const bearish = topSignals.filter((s) => s.priceChange < 0).length;

    let message = formatReportHeader(date, bullish, bearish);

    const sectors: Record<string, RVOLResult[]> = {};
    for (const stock of sortedSignals) {
        const sector = stock.sector || 'Other';
        if (!sectors[sector]) sectors[sector] = [];
        sectors[sector].push(stock);
    }

    for (const [sectorName, stocks] of Object.entries(sectors)) {
        message += `📍 <b>${escapeHtml(sectorName.toUpperCase())}</b>\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const stock of stocks) {
            message += formatSingleStockBlock(stock);
        }
    }

    message += formatVolumeWithoutPriceSection(volumeWithoutPrice);
    message += failedSection;
    return message;
}

/**
 * Format legend explaining each field, source (API vs calculated), and calculation method
 */
export function formatLegend(): string {
    return `📖 <b>Field Guide</b>

<b>From APIs:</b>
• <b>Price, Volume</b> – Yahoo / Twelve Data
• <b>RSI, SMA21</b> – Twelve Data (if API key set), else calculated
• <b>52w high</b> – Twelve Data (fallback only)
• <b>News</b> – Finnhub

<b>Calculated locally:</b>
• <b>RVOL</b> = today's volume ÷ 63-day avg volume
• <b>Price Change %</b> = (close − prev close) ÷ prev close × 100
• <b>SMA50, SMA200</b> = SMA of last 50/200 closes
• <b>52w high</b> = max of last 252 trading days (Yahoo / Twelve Data)
• <b>pctFromAth</b> = (price − ATH) ÷ ATH × 100
• <b>monthsInConsolidation</b> = days since ATH touch ÷ 21

<b>Setup symbols:</b>
✓ = met condition | ~ = close | 🎯 = full setup | 👀 = close to setup`;
}

/** Shared row format: TICKER | RVOL X.XXx | Price ±X.XX% | RSI XX | Setup (code + LLM use same structure) */
const STOCK_ROW_FORMAT = 'TICKER | RVOL X.XXx | Price ±X.XX% | RSI XX | Setup';

/**
 * Format one stock row in the shared structure (used by both code and LLM).
 */
function formatStockRow(stock: StockData, setupEmoji: '🎯' | '👀' | '—'): string {
    const rsi = stock.rsi != null ? stock.rsi.toFixed(0) : '—';
    return `${stock.ticker} | RVOL ${formatRVOL(stock.rvol)} | Price ${formatPriceChange(stock.priceChange)} | RSI ${rsi} | ${setupEmoji}`;
}

/**
 * Get the StockData[] list for LLM (same stocks as getAllSignalRows).
 * Used so LLM receives the exact params the code calculated.
 */
export function getStocksForLlm(topSignals: RVOLResult[], volumeWithoutPrice: StockData[]): StockData[] {
    const hasSetup = (s: StockData): boolean => isFullSetup(s) || isCloseSetup(s);
    const setupFromSilent = volumeWithoutPrice.filter(hasSetup);
    const topSilent = [...volumeWithoutPrice].sort((a, b) => b.rvol - a.rvol).slice(0, 10);
    return [...topSignals, ...setupFromSilent, ...topSilent]
        .filter((s, i, arr) => arr.findIndex((x) => x.ticker === s.ticker) === i)
        .sort((a, b) => b.rvol - a.rvol);
}

/**
 * Get ALL high-RVOL signal rows for LLM (every stock we report on).
 * Includes 🎯 full setup, 👀 close setup, — no setup. LLM sees complete picture.
 * Ensures ALL setup stocks (🎯/👀) are included + topSignals + top 10 silent.
 */
export function getAllSignalRows(topSignals: RVOLResult[], volumeWithoutPrice: StockData[]): string[] {
    const stocks = getStocksForLlm(topSignals, volumeWithoutPrice);
    return stocks.map((s) => {
        const emoji: '🎯' | '👀' | '—' = isFullSetup(s) ? '🎯' : isCloseSetup(s) ? '👀' : '—';
        return formatStockRow(s, emoji);
    });
}

/**
 * Get setup stock rows from code (setup stocks only – for compact Data display).
 */
export function getSetupRowsFromData(topSignals: RVOLResult[], volumeWithoutPrice: StockData[]): string[] {
    const seen = new Set<string>();
    const rows: string[] = [];
    for (const s of [...topSignals, ...volumeWithoutPrice]) {
        if (seen.has(s.ticker)) continue;
        if (isFullSetup(s)) {
            seen.add(s.ticker);
            rows.push(formatStockRow(s, '🎯'));
        } else if (isCloseSetup(s)) {
            seen.add(s.ticker);
            rows.push(formatStockRow(s, '👀'));
        }
    }
    return rows;
}

/**
 * Format setup stocks from code data – full structure for comparison with LLM.
 * Same params and format as LLM output: ticker, RVOL, price, RSI, setup.
 */
function formatSetupReference(topSignals: RVOLResult[], volumeWithoutPrice: StockData[]): string {
    const rows = getSetupRowsFromData(topSignals, volumeWithoutPrice);
    if (rows.length === 0) return '';
    return `📋 <b>Data (code):</b>\n<code>${STOCK_ROW_FORMAT}</code>\n${rows.map((r) => `<code>${r}</code>`).join('\n')}\n\n`;
}

/**
 * Format a data header line for every Telegram message (date, stats, part).
 */
function formatMessageDataHeader(
    date: string,
    topSignalsCount: number,
    volumeWithoutPriceCount: number,
    partLabel?: string
): string {
    const parts: string[] = [`📅 ${date}`];
    if (topSignalsCount > 0) parts.push(`${topSignalsCount} signals`);
    if (volumeWithoutPriceCount > 0) parts.push(`${volumeWithoutPriceCount} silent`);
    if (partLabel) parts.push(partLabel);
    return `📊 <code>${parts.join(' • ')}</code>\n\n`;
}

/** Scope info for LLM verification and run issues */
export interface ReportScope {
    watchlistCount?: number;
    invalidTickers?: string[];
}

/** Format run issues (invalid format + failed fetch) for visibility in first message */
function formatRunIssuesSection(invalidTickers: string[], failedTickers: string[]): string {
    const parts: string[] = [];
    if (invalidTickers.length > 0) {
        parts.push(`⚠️ <b>פורמט לא נתמך (דולגו):</b> <code>${invalidTickers.map((t) => escapeHtml(t)).join(', ')}</code>`);
    }
    if (failedTickers.length > 0) {
        parts.push(
            `⚠️ <b>לא הצלחנו לשלוף נתונים:</b> <code>${failedTickers.map((t) => escapeHtml(t)).join(', ')}</code>\n<i>(בדקו שגיאות כתיב או אם הסימול נמחק מהבורסה)</i>`
        );
    }
    if (parts.length === 0) return '';
    return `━━━━━━━━━━━━━━━━━━━━━━\n${parts.join('\n')}\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
}

async function buildLlmSummaryMessage(
    date: string,
    topSignals: RVOLResult[],
    volumeWithoutPrice: StockData[],
    scope?: ReportScope
): Promise<string | null> {
    if (topSignals.length === 0) return null;

    const llmMinRvol = config.llmMinRvol;
    const forLlm =
        llmMinRvol > 0
            ? {
                  topSignals: topSignals.filter((s) => s.rvol > llmMinRvol),
                  volumeWithoutPrice: volumeWithoutPrice.filter((s) => s.rvol > llmMinRvol),
              }
            : { topSignals, volumeWithoutPrice };
    const allSignalRows = getAllSignalRows(forLlm.topSignals, forLlm.volumeWithoutPrice);
    const setupRows = getSetupRowsFromData(topSignals, volumeWithoutPrice);

    if (allSignalRows.length === 0) return null;

    const stocksForLlm = config.llmSignalsOnly
        ? forLlm.topSignals
        : getStocksForLlm(forLlm.topSignals, forLlm.volumeWithoutPrice);

    let summary: string | null = null;
    if (config.llmPerStock) {
        const analyses = await getPerStockAnalyses(stocksForLlm, date);
        const lines = analyses
            .filter((a) => a.analysis)
            .map((a) => formatCodeVsLlmLine(a.ticker, a.codeSetup, parseLlmReply(a.analysis ?? ''), a.analysis));
        summary = lines.length > 0 ? lines.join('\n') : null;
    } else {
        summary = await getReportSummary(stocksForLlm, date, {
            watchlistCount: scope?.watchlistCount,
            setupCount: setupRows.length,
        });
    }

    if (!summary) return null;

    // Per-stock: summary is HTML from formatCodeVsLlmLine (already escaped). Batch: plain text from LLM.
    const safeSummary = config.llmPerStock ? summary : escapeHtml(summary);
    const llmDataHeader = formatMessageDataHeader(date, topSignals.length, volumeWithoutPrice.length, 'LLM Summary');
    const setupRef = formatSetupReference(topSignals, volumeWithoutPrice);
    const tickersSent = allSignalRows.map((r) => r.split('|')[0].trim()).join(', ');
    const rvolNote = llmMinRvol > 0 ? ` (RVOL>${llmMinRvol})` : '';
    const scopeLine =
        scope?.watchlistCount != null
            ? `\n<i>✅ נסרקו ${scope.watchlistCount} מניות מ-Sheets | ל-LLM נשלחו ${allSignalRows.length}${rvolNote}: ${tickersSent}</i>\n\n`
            : `\n<i>✅ ל-LLM נשלחו ${allSignalRows.length}${rvolNote} מניות: ${tickersSent}</i>\n\n`;
    const modeLabel = config.llmPerStock ? ' (כל מניה: LLM מחשב בעצמו, אותו תנאים)' : '';
    const explanation = '<i>קוד = חישוב המערכת | LLM = חישוב עצמאי (אותם תנאים) | תואמים/חוסר התאמה = השוואה</i>\n\n';

    return `${llmDataHeader}${explanation}${scopeLine}${setupRef}🤖 <b>ניתוח LLM${modeLabel}:</b>\n\n${safeSummary}\n\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
}

/**
 * Send the daily report, splitting if necessary.
 * If LLM summary is enabled and succeeds, it is prepended to the first message.
 * Every message includes a data header (date, stats, part).
 */
export async function sendDailyReport(
    date: string,
    topSignals: RVOLResult[],
    volumeWithoutPrice: StockData[],
    failedTickers: string[] = [],
    scope?: ReportScope
): Promise<void> {
    const report = formatDailyReport(date, topSignals, volumeWithoutPrice, failedTickers);
    const chunks = chunkMessage(report);

    const issuesSection = formatRunIssuesSection(scope?.invalidTickers ?? [], failedTickers);
    const llmMessage = await buildLlmSummaryMessage(date, topSignals, volumeWithoutPrice, scope);
    if (llmMessage) {
        await sendTelegramMessage((issuesSection ? issuesSection : '') + llmMessage);
        logger.info('LLM summary sent as first Telegram message');
        if (config.debug) {
            logger.info('--- LLM MESSAGE PREVIEW ---\n' + llmMessage.replace(/<[^>]*>/g, '') + '\n--- END LLM PREVIEW ---');
        }
    } else if (topSignals.length > 0) {
        const forLlm =
            config.llmMinRvol > 0
                ? {
                      topSignals: topSignals.filter((s) => s.rvol > config.llmMinRvol),
                      volumeWithoutPrice: volumeWithoutPrice.filter((s) => s.rvol > config.llmMinRvol),
                  }
                : { topSignals, volumeWithoutPrice };
        const allSignalRows = getAllSignalRows(forLlm.topSignals, forLlm.volumeWithoutPrice);
        if (allSignalRows.length === 0) {
            logger.info(
                `LLM summary skipped: no stocks with RVOL > ${config.llmMinRvol}. Set LLM_MIN_RVOL=0 to include all signals.`
            );
        } else {
            logger.warn(
                'LLM summary not sent. Check: ENABLE_LLM_SUMMARY=true, correct LLM_PROVIDER, and API key set for that provider.'
            );
        }
    } else {
        logger.info('LLM summary skipped (no high-RVOL signals to summarize)');
    }

    logger.info(`Sending ${chunks.length} message(s) to Telegram`);

    // Issues section goes in first message only (LLM or first report chunk)
    const issuesInFirstReport = !llmMessage && issuesSection;
    for (let i = 0; i < chunks.length; i++) {
        const partLabel = chunks.length > 1 ? `Part ${i + 1}/${chunks.length}` : undefined;
        const msgDataHeader = formatMessageDataHeader(date, topSignals.length, volumeWithoutPrice.length, partLabel);
        const content =
            i === 0 && issuesInFirstReport ? issuesSection + msgDataHeader + chunks[i] : msgDataHeader + chunks[i];
        await sendTelegramMessage(content);
    }
}
