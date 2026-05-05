/**
 * Telegram Formatter Tests — momentum-only output (2026-05-05)
 *
 * The daily report is now driven exclusively by momentum tiers
 * (Full / Recovery / Watchlist). Legacy entry-path labels and the
 * Silent Activity section are no longer in the Telegram output.
 */

// Mock config and llmSummary before importing telegramBot (avoids p-limit ESM in Jest)
jest.mock('../src/config/index.js', () => ({
    config: {
        telegramBotToken: 'mock-token',
        telegramChatId: 'mock-chat-id',
        llmPerStock: false,
        llmMinRvol: 0,
        formatPrecision: { price: 2, pct: 2, base: 2, rvol: 2, rsi: 0 },
        athThresholdPct: 20,
        athCloseThresholdPct: 25,
        sma21TouchThresholdPct: 3,
        sma21CloseThresholdPct: 5,
        consolidationMinMonths: 6,
        consolidationMaxMonths: 36,
        consolidationCloseMinMonths: 4,
    },
}));
jest.mock('../src/services/llmSummary.js', () => ({
    getReportSummary: jest.fn(),
    getPerStockAnalyses: jest.fn(),
}));

import { formatDailyReport } from '../src/services/telegramBot';
import { RVOLResult, MomentumResult } from '../src/types';

const fullCriteria: MomentumResult['criteria'] = {
    rvolPass: true,
    stage2: true,
    lowRiskEntry: true,
    pivotBreakout: true,
    tightness: true,
    aboveGapAvwap: true,
    antsAccumulation: false,
    bigMoveToday: true,
};
const watchlistCriteria: MomentumResult['criteria'] = {
    rvolPass: true,
    stage2: true,
    lowRiskEntry: false,
    pivotBreakout: true,
    tightness: false,
    aboveGapAvwap: true,
    antsAccumulation: false,
    bigMoveToday: false,
};

const fullMomentum: MomentumResult = {
    level: 'full',
    criteria: fullCriteria,
    failures: [],
};
const watchlistMomentum: MomentumResult = {
    level: 'close',
    criteria: watchlistCriteria,
    failures: ['lowRiskEntry', 'tightness'],
};

describe('Telegram Formatter (momentum-only)', () => {
    const fullStock: RVOLResult = {
        ticker: 'NVDA',
        sector: 'Semiconductor',
        lastPrice: 850.0,
        priceChange: 6.25,
        currentVolume: 80_000_000,
        avgVolume: 16_000_000,
        rvol: 5.0,
        rsi: 65,
        sma50: 800,
        sma200: 700,
        sma200Slope: 'up',
        sma21: 820,
        ath: 855,
        pctFromAth: -0.6,
        daysSinceAth: 25,
        news: [],
        isVolumeWithoutPrice: false,
        momentum: fullMomentum,
    };
    const watchlistStock: RVOLResult = {
        ticker: 'AMD',
        sector: 'Semiconductor',
        lastPrice: 145.0,
        priceChange: 2.1,
        currentVolume: 60_000_000,
        avgVolume: 20_000_000,
        rvol: 3.0,
        rsi: 60,
        sma50: 140,
        sma200: 130,
        sma200Slope: 'flat',
        sma21: 130,
        ath: 150,
        pctFromAth: -3.3,
        daysSinceAth: 8,
        news: [],
        isVolumeWithoutPrice: false,
        momentum: watchlistMomentum,
    };

    describe('formatDailyReport', () => {
        it('renders header, sentiment, and tier sections', () => {
            const report = formatDailyReport('2026-02-01', [fullStock, watchlistStock], []);

            expect(report).toContain('SMART VOLUME RADAR');
            expect(report).toContain('2026-02-01');
            expect(report).toContain('Sentiment:');
            expect(report).toContain('FULL MOMENTUM');
            expect(report).toContain('MOMENTUM WATCHLIST');
            expect(report).toContain('NVDA');
            expect(report).toContain('AMD');
        });

        it('renders the 8-criteria checklist for Watchlist stocks (where it varies)', () => {
            const report = formatDailyReport('2026-02-01', [watchlistStock], []);

            expect(report).toContain('Mandatory:');
            expect(report).toContain('Quality:');
            expect(report).toContain('RVOL ✓');
            expect(report).toContain('Stage2 ✓');
            expect(report).toContain('Pivot ✓');
            expect(report).toContain('AVWAP ✓');
        });

        it('omits the Mandatory checklist for Full stocks (always all-green by definition)', () => {
            const report = formatDailyReport('2026-02-01', [fullStock], []);
            // Full passes 4/4 mandatory by tier definition; rendering them is just noise.
            expect(report).not.toContain('Mandatory:');
            expect(report).not.toContain('Quality:');
        });

        it('marks failing criteria with ✗ for watchlist stock and labels them in Hebrew', () => {
            const report = formatDailyReport('2026-02-01', [watchlistStock], []);

            expect(report).toContain('LowRisk ✗');
            expect(report).toContain('Tight ✗');
            // Hebrew labels in the (חסר: ...) hint instead of camelCase code names
            expect(report).toContain('מרחק SMA21');
            expect(report).toContain('תקופת בסיס');
        });

        it('shows distance metrics (SMA21 / ATH / days since ATH)', () => {
            const report = formatDailyReport('2026-02-01', [fullStock], []);

            expect(report).toContain('SMA21'); // distance row
            expect(report).toContain('ATH -0.6%');
            expect(report).toContain('25d since ATH');
        });

        it('shows trend stack (Price vs SMA50, SMA50 vs SMA200, SMA200 slope)', () => {
            const report = formatDailyReport('2026-02-01', [fullStock], []);

            expect(report).toContain('Price ↑ SMA50');
            expect(report).toContain('SMA50 ↑ SMA200');
            expect(report).toContain('SMA200 ↗up');
        });

        it('handles the empty case with a momentum-specific message', () => {
            const report = formatDailyReport('2026-02-01', [], []);

            expect(report).toContain('אין מניות במומנטום היום');
            expect(report).not.toContain('Sentiment:');
        });

        it('does not render Silent Activity Watchlist (momentum-only Telegram)', () => {
            const report = formatDailyReport('2026-02-01', [fullStock], []);

            expect(report).not.toContain('SILENT ACTIVITY WATCHLIST');
        });

        it('does not include legacy entry-path labels (RVOL+מחיר / Pullback / SMA21 Touch)', () => {
            const report = formatDailyReport('2026-02-01', [fullStock, watchlistStock], []);

            expect(report).not.toContain('כניסה: RVOL+מחיר');
            expect(report).not.toContain('כניסה: Pullback 15%');
            expect(report).not.toContain('כניסה: SMA21 Touch');
        });

        it('groups by tier — Full appears before Watchlist regardless of input order', () => {
            const report = formatDailyReport('2026-02-01', [watchlistStock, fullStock], []);
            const fullIdx = report.indexOf('FULL MOMENTUM');
            const watchIdx = report.indexOf('MOMENTUM WATCHLIST');

            expect(fullIdx).toBeGreaterThan(0);
            expect(watchIdx).toBeGreaterThan(fullIdx);
        });

        it('uses correct price-direction emoji per stock', () => {
            const report = formatDailyReport('2026-02-01', [fullStock, watchlistStock], []);

            expect(report).toContain('🟢 +6.25%');
            expect(report).toContain('🟢 +2.10%');
        });

        it('includes sector hint next to the ticker', () => {
            const report = formatDailyReport('2026-02-01', [fullStock], []);

            expect(report).toContain('Semiconductor');
        });

        it('does not leak failed tickers into the report body (issues section is separate)', () => {
            const report = formatDailyReport('2026-02-01', [fullStock], [], ['BAD.TA', 'MISSING']);

            expect(report).not.toContain('Could not check');
            expect(report).not.toContain('BAD.TA');
        });

        describe('Graduation alert section', () => {
            const graduations = [
                {
                    ticker: 'NXPI',
                    sector: 'Semiconductor',
                    firstAlertDate: '2026-04-15',
                    firstAlertPrice: 88.20,
                    currentPrice: 99.05,
                    daysSinceAlert: 12,
                    returnPct: 12.3,
                },
            ];

            it('renders the graduation block when graduations are passed', () => {
                const report = formatDailyReport('2026-04-27', [fullStock], [], [], graduations);

                expect(report).toContain('GRADUATION ALERT (1)');
                expect(report).toContain('Watchlist → Full Momentum');
                expect(report).toContain('NXPI');
                expect(report).toContain('Semiconductor');
                expect(report).toContain('+12.3%');
                expect(report).toContain('12 ימים');
            });

            it('places graduation block before the FULL MOMENTUM section', () => {
                const report = formatDailyReport('2026-04-27', [fullStock], [], [], graduations);
                const gradIdx = report.indexOf('GRADUATION ALERT');
                // Tier section header is "🎯 <b>FULL MOMENTUM</b> <i>(1)</i>" — find the FIRST
                // FULL MOMENTUM occurrence after the graduation block, which is the tier header
                // (not the per-stock badge inside the graduation block).
                const reportRadarHeaderIdx = report.indexOf('SMART VOLUME RADAR');
                const fullIdx = report.indexOf('FULL MOMENTUM', reportRadarHeaderIdx);

                expect(gradIdx).toBeGreaterThanOrEqual(0);
                expect(fullIdx).toBeGreaterThan(gradIdx);
            });

            it('omits the section entirely when no graduations', () => {
                const report = formatDailyReport('2026-04-27', [fullStock], [], [], []);

                expect(report).not.toContain('GRADUATION ALERT');
            });

            it('still shows graduation block when there are no momentum signals', () => {
                const report = formatDailyReport('2026-04-27', [], [], [], graduations);

                expect(report).toContain('GRADUATION ALERT');
                expect(report).toContain('NXPI');
                // Empty-state for momentum is still appended
                expect(report).toContain('אין מניות במומנטום היום');
            });
        });
    });
});
