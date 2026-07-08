/**
 * Tests for the Lean Radar Telegram formatter.
 */

jest.mock('../src/config/index.js', () => ({
    config: {
        telegramBotToken: 'mock',
        telegramChatId: 'mock',
        formatPrecision: { price: 2, pct: 2, base: 2, rvol: 2, rsi: 0 },
    },
}));

import { formatLeanReport, type LeanScanResult } from '../src/lean/format';
import type { StockData } from '../src/types';

const stock = (over: Partial<StockData>): StockData => ({
    ticker: 'NVDA',
    currentVolume: 1,
    avgVolume: 1,
    rvol: 3.5,
    priceChange: 4.2,
    lastPrice: 850,
    sector: 'Semiconductor',
    ath: 900,
    pctFromAth: -5.5,
    sma50: 800,
    sma200: 700,
    ...over,
});

const empty = (): LeanScanResult => ({
    consolidationBreakouts: [],
    highVolume: [],
    pullbacks: [],
    nearConsolidation: [],
    nearVolume: [],
    nearPullback: [],
});

describe('formatLeanReport', () => {
    it('renders the LEAN RADAR header always', () => {
        const out = formatLeanReport('2026-05-09', empty());
        expect(out).toContain('LEAN RADAR');
        expect(out).toContain('2026-05-09');
    });

    it('shows empty-state when nothing detected', () => {
        const out = formatLeanReport('2026-05-09', empty());
        expect(out).toContain('אין איתותים');
    });

    it('renders Consolidation section with window and base range', () => {
        const r = empty();
        r.consolidationBreakouts.push({
            stock: stock({ ticker: 'AMKR', rvol: 2.4, priceChange: 5.2 }),
            signal: { window: '3M', baseRangePct: 11.4, windowHigh: 35 },
        });
        const out = formatLeanReport('2026-05-09', r);
        expect(out).toContain('פריצת קונסולידציה');
        expect(out).toContain('AMKR');
        expect(out).toContain('בסיס 3M');
        expect(out).toContain('11.4%');
        expect(out).toContain('RVOL 2.4x');
    });

    it('renders High Volume section with EXTREME tag at level=extreme', () => {
        const r = empty();
        r.highVolume.push({
            stock: stock({ ticker: 'TSLA', rvol: 6.5 }),
            signal: { level: 'extreme', climax: false },
        });
        r.highVolume.push({
            stock: stock({ ticker: 'AMD', rvol: 3.5 }),
            signal: { level: 'high', climax: false },
        });
        const out = formatLeanReport('2026-05-09', r);
        expect(out).toContain('נפח גבוה');
        expect(out).toContain('⚡ EXTREME');
        expect(out).toContain('TSLA');
        expect(out).toContain('AMD');
        // AMD's BLOCK (ticker line + metrics + reason lines) should have 🔥 not EXTREME.
        // Blocks are multi-line; slice from the AMD ticker line to the next blank line.
        const lines = out.split('\n');
        const amdIdx = lines.findIndex((l) => l.includes('AMD'));
        let end = amdIdx;
        while (end < lines.length && lines[end].trim() !== '') end++;
        const amdBlock = lines.slice(amdIdx, end).join('\n');
        expect(amdBlock).toContain('🔥');
        expect(amdBlock).not.toContain('EXTREME');
    });

    it('appends a climax warning when RVOL >= 8', () => {
        const r = empty();
        r.highVolume.push({
            stock: stock({ ticker: 'PUMP', rvol: 9.2 }),
            signal: { level: 'extreme', climax: true },
        });
        const out = formatLeanReport('2026-05-09', r);
        expect(out).toContain('⚠️ קליימקס');
    });

    it('renders Pullback section with pctFromAth', () => {
        const r = empty();
        r.pullbacks.push({
            stock: stock({ ticker: 'AAPL', pctFromAth: -18.3, ath: 250, lastPrice: 204 }),
            signal: { pctFromAth: -18.3 },
        });
        const out = formatLeanReport('2026-05-09', r);
        expect(out).toContain('Pullback תקין');
        expect(out).toContain('AAPL');
        expect(out).toContain('-18.3%');
    });

    it('renders Silent Watchlist with all 3 sub-sections when present', () => {
        const r = empty();
        r.nearConsolidation.push({
            stock: stock({ ticker: 'COIN' }),
            signal: { window: '1M', baseRangePct: 7, windowHigh: 200, distanceToPivotPct: 1.2 },
        });
        r.nearVolume.push({
            stock: stock({ ticker: 'SHOP', rvol: 2.7 }),
            signal: { rvol: 2.7 },
        });
        r.nearPullback.push({
            stock: stock({ ticker: 'PYPL', pctFromAth: -13.4 }),
            signal: { pctFromAth: -13.4 },
        });
        const out = formatLeanReport('2026-05-09', r);
        expect(out).toContain('Silently Watching');
        expect(out).toContain('קרובים לפריצה');
        expect(out).toContain('COIN');
        expect(out).toContain('1.2%');
        expect(out).toContain('כמעט 3x');
        expect(out).toContain('SHOP');
        expect(out).toContain('קרובים לאזור pullback');
        expect(out).toContain('PYPL');
    });

    it('hides empty sections (does not render zero-row headers)', () => {
        const r = empty();
        r.highVolume.push({
            stock: stock({ ticker: 'NVDA' }),
            signal: { level: 'high' },
        });
        const out = formatLeanReport('2026-05-09', r);
        expect(out).toContain('נפח גבוה');
        expect(out).not.toContain('פריצת קונסולידציה');
        expect(out).not.toContain('Pullback תקין');
        expect(out).not.toContain('Silently Watching');
    });

    it('output is reasonably compact on a typical 24-stock run (well below 6KB)', () => {
        const r = empty();
        // Simulate 24 stocks (typical day) across the 3 main sections
        for (let i = 0; i < 8; i++) {
            r.highVolume.push({
                stock: stock({ ticker: `T${i}`, rvol: 3 + i * 0.1 }),
                signal: { level: 'high' },
            });
            r.pullbacks.push({
                stock: stock({ ticker: `P${i}`, pctFromAth: -16 - i * 0.5 }),
                signal: { pctFromAth: -16 - i * 0.5 },
            });
            r.consolidationBreakouts.push({
                stock: stock({ ticker: `C${i}` }),
                signal: { window: '3M', baseRangePct: 12, windowHigh: 100 },
            });
        }
        const out = formatLeanReport('2026-05-09', r);
        // Sanity ceiling — the lean format should stay tight; if this trips,
        // someone added too much per-stock detail.
        expect(out.length).toBeLessThan(6000);
    });
});
