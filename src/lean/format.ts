/**
 * Smart Volume Radar — Lean Radar Telegram formatter (stable branch).
 *
 * UNIFIED LINE FORMAT (2026-05-12 redesign):
 * Every stock — in any section, including Silent Watchlist — shows the SAME
 * four metrics, regardless of which signal flagged it:
 *
 *   TICKER (sector) · $price (day%)
 *     📊 RVOL Xx · 📉 ATH−X% · 🪜 S2✓/✗ · ↳ [why it appeared in this section]
 *
 * Rationale: previously each section only displayed the metric it matched on
 * (high-volume showed RVOL; pullback showed ATH%) — making cross-section
 * triage hard. Unified format lets you assess every candidate against all
 * four lenses at a glance.
 *
 * Sections (only rendered when non-empty):
 *   📈 Consolidation Breakout
 *   🔥 High Volume (3x+)
 *   📉 Healthy Pullback
 *   👁️ Silently Watching (near-misses)
 */
import type { StockData } from '../types/index.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { isStage2 } from './signals.js';
import type {
    ConsolidationSignal,
    HighVolumeSignal,
    PullbackSignal,
    ConsolidationNearMiss,
    VolumeNearMiss,
    PullbackNearMiss,
} from './signals.js';

export interface LeanScanResult {
    consolidationBreakouts: Array<{ stock: StockData; signal: ConsolidationSignal }>;
    highVolume: Array<{ stock: StockData; signal: HighVolumeSignal }>;
    pullbacks: Array<{ stock: StockData; signal: PullbackSignal }>;
    nearConsolidation: Array<{ stock: StockData; signal: ConsolidationNearMiss }>;
    nearVolume: Array<{ stock: StockData; signal: VolumeNearMiss }>;
    nearPullback: Array<{ stock: StockData; signal: PullbackNearMiss }>;
}

function tickerLink(stock: StockData): string {
    const isIsraeli = stock.ticker.endsWith('.TA');
    const tvTicker = stock.ticker.replace('.TA', '');
    const encTv = encodeURIComponent(isIsraeli ? 'TASE-' + tvTicker : tvTicker);
    return `<a href="https://www.tradingview.com/symbols/${encTv}">${escapeHtml(stock.ticker)}</a>`;
}

function fmtPrice(p: number | undefined): string {
    if (p == null) return '?';
    return p < 10 ? p.toFixed(3) : p < 100 ? p.toFixed(2) : p.toFixed(1);
}

function fmtRvol(r: number | undefined): string {
    if (r == null) return '?';
    return `${r.toFixed(1)}x`;
}

function fmtPct(p: number | undefined): string {
    if (p == null) return '?';
    const sign = p >= 0 ? '+' : '';
    return `${sign}${p.toFixed(1)}%`;
}

/** Render the shared metrics block — `📊 RVOL · 📉 ATH · 🪜 S2`. */
function metricsBlock(stock: StockData): string {
    const stageFlag = isStage2(stock) ? '✓' : '✗';
    const athPart = stock.pctFromAth != null ? `📉 ATH ${fmtPct(stock.pctFromAth)}` : '📉 ATH ?';
    return `📊 RVOL ${fmtRvol(stock.rvol)}  ·  ${athPart}  ·  🪜 S2${stageFlag}`;
}

/** Render the identity line — `TICKER (sector) · $price (day%)`. */
function identityLine(stock: StockData): string {
    const sectorTag = stock.sector ? ` <i>(${escapeHtml(stock.sector)})</i>` : '';
    return `${tickerLink(stock)}${sectorTag}  ·  $${fmtPrice(stock.lastPrice)}  (${fmtPct(stock.priceChange)})`;
}

/** Render a full per-stock block: identity + metrics + reason. */
function stockBlock(stock: StockData, reason: string): string {
    return (
        `${identityLine(stock)}\n` +
        `  ${metricsBlock(stock)}  ·  ↳ ${reason}`
    );
}

/** Top-level format function. */
export function formatLeanReport(date: string, result: LeanScanResult): string {
    const parts: string[] = [];

    // Header
    parts.push(
        `🪶 <b>LEAN RADAR</b>\n` +
            `📅 <code>${date}</code>\n` +
            `<i>3 signals: 📈 breakout · 🔥 RVOL 3x+ · 📉 -15% pullback</i>\n` +
            `<i>כל מנייה: 📊 RVOL · 📉 ATH% · 🪜 Stage2</i>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━`
    );

    const totalReal =
        result.consolidationBreakouts.length +
        result.highVolume.length +
        result.pullbacks.length;
    const totalNear =
        result.nearConsolidation.length +
        result.nearVolume.length +
        result.nearPullback.length;

    if (totalReal === 0 && totalNear === 0) {
        parts.push(`\n📭 <i>אין איתותים היום — לא breakouts, לא RVOL גבוה, לא pullbacks תקינים.</i>`);
        return parts.join('\n');
    }

    // 1. Consolidation Breakouts
    if (result.consolidationBreakouts.length > 0) {
        parts.push(
            `\n📈 <b>פריצת קונסולידציה</b>  ·  ${result.consolidationBreakouts.length}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`
        );
        for (const { stock, signal } of result.consolidationBreakouts) {
            const reason = `📈 שובר בסיס ${signal.window} (טווח ${signal.baseRangePct.toFixed(1)}%, פיבוט $${fmtPrice(signal.windowHigh)})`;
            parts.push(stockBlock(stock, reason));
        }
    }

    // 2. High Volume
    if (result.highVolume.length > 0) {
        parts.push(
            `\n🔥 <b>נפח גבוה — 3x+</b>  ·  ${result.highVolume.length}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`
        );
        for (const { stock, signal } of result.highVolume) {
            const tag = signal.level === 'extreme' ? '⚡ EXTREME volume' : '🔥 נפח גבוה';
            const reason = `${tag} (${fmtRvol(stock.rvol)})`;
            parts.push(stockBlock(stock, reason));
        }
    }

    // 3. Healthy Pullback
    if (result.pullbacks.length > 0) {
        parts.push(
            `\n📉 <b>Pullback תקין (15-25% מ-52w high)</b>  ·  ${result.pullbacks.length}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`
        );
        for (const { stock, signal } of result.pullbacks) {
            const reason = `📉 Pullback בריא (${fmtPct(signal.pctFromAth)} מ-ATH $${fmtPrice(stock.ath)}, מעל SMA200)`;
            parts.push(stockBlock(stock, reason));
        }
    }

    // 4. Silent Watchlist (near-misses) — same unified format
    if (totalNear > 0) {
        parts.push(`\n👁️ <b>Silently Watching</b>  ·  ${totalNear}\n━━━━━━━━━━━━━━━━━━━━━━`);

        if (result.nearConsolidation.length > 0) {
            parts.push(`\n<b>📈 קרובים לפריצה:</b>`);
            for (const { stock, signal } of result.nearConsolidation) {
                const reason = `📈 בסיס ${signal.window}, ${signal.distanceToPivotPct.toFixed(1)}% מתחת לפיבוט $${fmtPrice(signal.windowHigh)}`;
                parts.push(stockBlock(stock, reason));
            }
        }
        if (result.nearVolume.length > 0) {
            parts.push(`\n<b>🔥 כמעט 3x:</b>`);
            for (const { stock, signal } of result.nearVolume) {
                const reason = `🔥 כמעט 3x (${fmtRvol(signal.rvol)})`;
                parts.push(stockBlock(stock, reason));
            }
        }
        if (result.nearPullback.length > 0) {
            parts.push(`\n<b>📉 קרובים לאזור pullback:</b>`);
            for (const { stock, signal } of result.nearPullback) {
                const reason = `📉 קרוב ל-pullback band (${fmtPct(signal.pctFromAth)} מ-ATH)`;
                parts.push(stockBlock(stock, reason));
            }
        }
    }

    return parts.join('\n');
}
