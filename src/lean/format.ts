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

/**
 * Build the "also-matches" badge for a stock. Lean signals are orthogonal
 * (breakout / high-vol / pullback can all fire on the same stock), so we
 * pre-compute which extras to badge under the PRIMARY section.
 *
 * Priority: breakout > pullback > high-volume. A stock is rendered once
 * under its primary; the others become badges like "+ 🔥 5.2x" or
 * "+ 📉 -18.7%" appended to the reason line.
 */
function buildSecondaryBadges(
    ticker: string,
    primary: 'breakout' | 'volume' | 'pullback',
    result: LeanScanResult
): string {
    const badges: string[] = [];
    if (primary !== 'breakout') {
        const b = result.consolidationBreakouts.find((r) => r.stock.ticker === ticker);
        if (b) badges.push(`+ 📈 בסיס ${b.signal.window}`);
    }
    if (primary !== 'pullback') {
        const p = result.pullbacks.find((r) => r.stock.ticker === ticker);
        if (p) badges.push(`+ 📉 Pullback ${fmtPct(p.signal.pctFromAth)}`);
    }
    if (primary !== 'volume') {
        const v = result.highVolume.find((r) => r.stock.ticker === ticker);
        if (v) {
            const tag = v.signal.level === 'extreme' ? '⚡ EXTREME' : '🔥';
            badges.push(`+ ${tag} ${fmtRvol(v.stock.rvol)}`);
        }
    }
    return badges.length ? `  ·  <b>${badges.join('  ·  ')}</b>` : '';
}

/** Top-level format function. Deduplicates per ticker — same stock appears
 * once, in its primary section, with badges for other matching signals. */
export function formatLeanReport(date: string, result: LeanScanResult): string {
    const parts: string[] = [];

    // Header
    parts.push(
        `🪶 <b>LEAN RADAR</b>\n` +
            `📅 <code>${date}</code>\n` +
            `<i>3 signals: 📈 breakout · 🔥 RVOL 3x+ · 📉 -15% pullback</i>\n` +
            `<i>כל מנייה: 📊 RVOL · 📉 ATH% · 🪜 Stage2 · אם תואם כמה — מסומן עם +</i>\n` +
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

    // ─── Dedup: track which tickers we've already rendered in a real section
    // so a stock that matches breakout+pullback+volume only shows ONCE under
    // its highest-priority section. Also suppresses near-miss for tickers
    // that already fired a real signal.
    const renderedTickers = new Set<string>();

    // 1. Consolidation Breakouts (PRIMARY — strongest action)
    if (result.consolidationBreakouts.length > 0) {
        const items = result.consolidationBreakouts.filter((r) => !renderedTickers.has(r.stock.ticker));
        parts.push(`\n📈 <b>פריצת קונסולידציה</b>  ·  ${items.length}\n━━━━━━━━━━━━━━━━━━━━━━`);
        for (const { stock, signal } of items) {
            const reason =
                `📈 שובר בסיס ${signal.window} (טווח ${signal.baseRangePct.toFixed(1)}%, פיבוט $${fmtPrice(signal.windowHigh)})` +
                buildSecondaryBadges(stock.ticker, 'breakout', result);
            parts.push(stockBlock(stock, reason));
            renderedTickers.add(stock.ticker);
        }
    }

    // 2. Healthy Pullback (PRIMARY — entry opportunity)
    if (result.pullbacks.length > 0) {
        const items = result.pullbacks.filter((r) => !renderedTickers.has(r.stock.ticker));
        if (items.length > 0) {
            parts.push(`\n📉 <b>Pullback תקין (15-25% מ-52w high)</b>  ·  ${items.length}\n━━━━━━━━━━━━━━━━━━━━━━`);
            for (const { stock, signal } of items) {
                const reason =
                    `📉 Pullback בריא (${fmtPct(signal.pctFromAth)} מ-ATH $${fmtPrice(stock.ath)}, מעל SMA200)` +
                    buildSecondaryBadges(stock.ticker, 'pullback', result);
                parts.push(stockBlock(stock, reason));
                renderedTickers.add(stock.ticker);
            }
        }
    }

    // 3. High Volume (PRIMARY when alone — otherwise badge under another section)
    if (result.highVolume.length > 0) {
        const items = result.highVolume.filter((r) => !renderedTickers.has(r.stock.ticker));
        if (items.length > 0) {
            parts.push(`\n🔥 <b>נפח גבוה — 3x+</b>  ·  ${items.length}\n━━━━━━━━━━━━━━━━━━━━━━`);
            for (const { stock, signal } of items) {
                const tag = signal.level === 'extreme' ? '⚡ EXTREME volume' : '🔥 נפח גבוה';
                const reason = `${tag} (${fmtRvol(stock.rvol)})` + buildSecondaryBadges(stock.ticker, 'volume', result);
                parts.push(stockBlock(stock, reason));
                renderedTickers.add(stock.ticker);
            }
        }
    }

    // 4. Silent Watchlist — only stocks that did NOT fire any real signal.
    //    Within near-misses, also dedup with same priority.
    const nearRendered = new Set<string>();
    const nearC = result.nearConsolidation.filter((r) => !renderedTickers.has(r.stock.ticker));
    const nearP = result.nearPullback.filter((r) => !renderedTickers.has(r.stock.ticker));
    const nearV = result.nearVolume.filter((r) => !renderedTickers.has(r.stock.ticker));

    const nearTotal = new Set([
        ...nearC.map((r) => r.stock.ticker),
        ...nearP.map((r) => r.stock.ticker),
        ...nearV.map((r) => r.stock.ticker),
    ]).size;

    if (nearTotal > 0) {
        parts.push(`\n👁️ <b>Silently Watching</b>  ·  ${nearTotal}\n━━━━━━━━━━━━━━━━━━━━━━`);

        const buildNearBadges = (ticker: string, primary: 'breakout' | 'volume' | 'pullback'): string => {
            const badges: string[] = [];
            if (primary !== 'breakout') {
                const r = result.nearConsolidation.find((x) => x.stock.ticker === ticker);
                if (r) badges.push(`+ 📈 ${r.signal.distanceToPivotPct.toFixed(1)}% מתחת לפיבוט`);
            }
            if (primary !== 'pullback') {
                const r = result.nearPullback.find((x) => x.stock.ticker === ticker);
                if (r) badges.push(`+ 📉 ${fmtPct(r.signal.pctFromAth)}`);
            }
            if (primary !== 'volume') {
                const r = result.nearVolume.find((x) => x.stock.ticker === ticker);
                if (r) badges.push(`+ 🔥 ${fmtRvol(r.signal.rvol)}`);
            }
            return badges.length ? `  ·  <b>${badges.join('  ·  ')}</b>` : '';
        };

        const itemsC = nearC.filter((r) => !nearRendered.has(r.stock.ticker));
        if (itemsC.length > 0) {
            parts.push(`\n<b>📈 קרובים לפריצה:</b>`);
            for (const { stock, signal } of itemsC) {
                const reason =
                    `📈 בסיס ${signal.window}, ${signal.distanceToPivotPct.toFixed(1)}% מתחת לפיבוט $${fmtPrice(signal.windowHigh)}` +
                    buildNearBadges(stock.ticker, 'breakout');
                parts.push(stockBlock(stock, reason));
                nearRendered.add(stock.ticker);
            }
        }
        const itemsP = nearP.filter((r) => !nearRendered.has(r.stock.ticker));
        if (itemsP.length > 0) {
            parts.push(`\n<b>📉 קרובים לאזור pullback:</b>`);
            for (const { stock, signal } of itemsP) {
                const reason =
                    `📉 קרוב ל-pullback band (${fmtPct(signal.pctFromAth)} מ-ATH)` +
                    buildNearBadges(stock.ticker, 'pullback');
                parts.push(stockBlock(stock, reason));
                nearRendered.add(stock.ticker);
            }
        }
        const itemsV = nearV.filter((r) => !nearRendered.has(r.stock.ticker));
        if (itemsV.length > 0) {
            parts.push(`\n<b>🔥 כמעט 3x:</b>`);
            for (const { stock, signal } of itemsV) {
                const reason = `🔥 כמעט 3x (${fmtRvol(signal.rvol)})` + buildNearBadges(stock.ticker, 'volume');
                parts.push(stockBlock(stock, reason));
                nearRendered.add(stock.ticker);
            }
        }
    }

    return parts.join('\n');
}
