/**
 * Telegram Formatter Tests — action-based output (2026-05-06).
 *
 * The daily report is now driven by Champion-Score actions
 * (BUY / WATCH / CAUTION_EXTENDED / CAUTION_NO_VOL). PASS and
 * PASS_TOO_LATE are filtered out before reaching the formatter.
 * Stocks must have `action` set; otherwise they're invisible.
 */

// Mock p-limit to avoid ESM import issues in Jest (telegramBot → purpleFragility → p-limit)
jest.mock('p-limit', () => () => (fn: () => Promise<unknown>) => fn());
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
import { RVOLResult, MomentumResult, TradePlan } from '../src/types';

const buyCriteria: MomentumResult['criteria'] = {
    rvolPass: true,
    stage2: true,
    lowRiskEntry: false,
    pivotBreakout: true,
    tightness: true,
    aboveGapAvwap: true,
    antsAccumulation: false,
    bigMoveToday: true,
};
const watchCriteria: MomentumResult['criteria'] = {
    rvolPass: false,
    stage2: true,
    lowRiskEntry: true,
    pivotBreakout: false,
    tightness: false,
    aboveGapAvwap: true,
    antsAccumulation: false,
    bigMoveToday: false,
};

const fullMomentum: MomentumResult = { level: 'full', criteria: buyCriteria, failures: [] };
const watchlistMomentum: MomentumResult = {
    level: 'close',
    criteria: watchCriteria,
    failures: ['rvolPass', 'pivotBreakout'],
};

const buyTradePlan: TradePlan = {
    pivot: 855,
    buyZoneLow: 837.9,
    buyZoneHigh: 872.1,
    stopLoss: 779,
    riskPct: -8.4,
    distanceToEntryPct: 0.6,
    extensionPct: 0,
};
const watchTradePlan: TradePlan = {
    pivot: 150,
    buyZoneLow: 147,
    buyZoneHigh: 153,
    stopLoss: 123.5,
    riskPct: -14.8,
    distanceToEntryPct: 3.3,
    extensionPct: 0,
};

describe('Telegram Formatter (action-based)', () => {
    const buyStock: RVOLResult = {
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
        daysSinceAth: 0,
        news: [],
        isVolumeWithoutPrice: false,
        momentum: fullMomentum,
        championScore: 87,
        action: 'BUY',
        breakoutStage: 'Breaking Out',
        tradePlan: buyTradePlan,
    };
    const watchStock: RVOLResult = {
        ticker: 'AMD',
        sector: 'Semiconductor',
        lastPrice: 145.0,
        priceChange: 2.1,
        currentVolume: 60_000_000,
        avgVolume: 20_000_000,
        rvol: 1.4,
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
        championScore: 62,
        action: 'WATCH',
        breakoutStage: 'Pre-Pivot',
        tradePlan: watchTradePlan,
    };

    describe('formatDailyReport', () => {
        it('renders header with sentiment + action counts', () => {
            const report = formatDailyReport('2026-02-01', [buyStock, watchStock], []);

            expect(report).toContain('SMART VOLUME RADAR');
            expect(report).toContain('2026-02-01');
            expect(report).toContain('Sentiment:');
            expect(report).toContain('BUY');
            expect(report).toContain('WATCH');
            expect(report).toContain('NVDA');
            expect(report).toContain('AMD');
        });

        it('groups by action — BUY before WATCH regardless of input order', () => {
            const report = formatDailyReport('2026-02-01', [watchStock, buyStock], []);
            const buyIdx = report.indexOf('🟢 <b>BUY</b>');
            const watchIdx = report.indexOf('👀 <b>WATCH</b>');
            expect(buyIdx).toBeGreaterThan(0);
            expect(watchIdx).toBeGreaterThan(buyIdx);
        });

        it('shows RS percentile next to ticker (score removed from header, TD-27)', () => {
            const report = formatDailyReport('2026-02-01', [{ ...buyStock, rsPercentile: 93 }], []);
            expect(report).toContain('NVDA');
            expect(report).toContain('RS 93');
            expect(report).toContain('🔥'); // RS >= 90 leader flame
            expect(report).not.toContain('/100'); // weighted score no longer displayed
        });

        it('no flame below RS 90', () => {
            const report = formatDailyReport('2026-02-01', [{ ...buyStock, rsPercentile: 74 }], []);
            expect(report).toContain('RS 74');
            expect(report).not.toContain('RS 74 🔥');
        });

        it('renders the trade plan (buy zone + pivot + stop + risk)', () => {
            const report = formatDailyReport('2026-02-01', [buyStock], []);
            expect(report).toContain('Buy zone');
            expect(report).toContain('837.90'); // buyZoneLow
            expect(report).toContain('872.10'); // buyZoneHigh
            expect(report).toContain('pivot $855');
            expect(report).toContain('Stop');
            expect(report).toContain('779');
            expect(report).toContain('Risk');
            expect(report).toContain('-8.4%');
        });

        it('shows breakout stage with Hebrew descriptor', () => {
            const buyReport = formatDailyReport('2026-02-01', [buyStock], []);
            expect(buyReport).toContain('Stage:');
            expect(buyReport).toContain('Breaking Out');

            const watchReport = formatDailyReport('2026-02-01', [watchStock], []);
            expect(watchReport).toContain('Pre-Pivot');
        });

        it('omits criteria checklist for BUY actions (already confirmed)', () => {
            const report = formatDailyReport('2026-02-01', [buyStock], []);
            expect(report).not.toContain('Mandatory:');
        });

        it('renders the criteria checklist for WATCH (where it varies)', () => {
            const report = formatDailyReport('2026-02-01', [watchStock], []);
            expect(report).toContain('Mandatory:');
            expect(report).toContain('Quality:');
        });

        it('shows the WATCH narrative line about distance to pivot', () => {
            const report = formatDailyReport('2026-02-01', [watchStock], []);
            expect(report).toContain('עד ה-pivot');
        });

        it('handles the empty case with action-vocabulary message', () => {
            const report = formatDailyReport('2026-02-01', [], []);
            expect(report).toContain('אין מניות אקטיביות');
            expect(report).not.toContain('Sentiment:');
        });

        it('does not render Silent Activity Watchlist (action-only Telegram)', () => {
            const report = formatDailyReport('2026-02-01', [buyStock], []);
            expect(report).not.toContain('SILENT ACTIVITY WATCHLIST');
        });

        it('does not include legacy entry-path labels (RVOL+מחיר / Pullback / SMA21 Touch)', () => {
            const report = formatDailyReport('2026-02-01', [buyStock, watchStock], []);
            expect(report).not.toContain('כניסה: RVOL+מחיר');
            expect(report).not.toContain('כניסה: Pullback 15%');
            expect(report).not.toContain('כניסה: SMA21 Touch');
        });

        it('uses correct price-direction emoji per stock', () => {
            const report = formatDailyReport('2026-02-01', [buyStock, watchStock], []);
            expect(report).toContain('🟢 +6.25%');
            expect(report).toContain('🟢 +2.10%');
        });

        it('includes sector hint next to the ticker', () => {
            const report = formatDailyReport('2026-02-01', [buyStock], []);
            expect(report).toContain('Semiconductor');
        });

        it('does not leak failed tickers into the report body (issues section is separate)', () => {
            const report = formatDailyReport('2026-02-01', [buyStock], [], ['BAD.TA', 'MISSING']);
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
                const report = formatDailyReport('2026-04-27', [buyStock], [], [], graduations);

                expect(report).toContain('GRADUATION ALERT (1)');
                expect(report).toContain('Watchlist → Full Momentum');
                expect(report).toContain('NXPI');
                expect(report).toContain('Semiconductor');
                expect(report).toContain('+12.3%');
                expect(report).toContain('12 ימים');
            });

            it('places graduation block before the BUY section', () => {
                const report = formatDailyReport('2026-04-27', [buyStock], [], [], graduations);
                const gradIdx = report.indexOf('GRADUATION ALERT');
                const reportRadarHeaderIdx = report.indexOf('SMART VOLUME RADAR');
                const buyIdx = report.indexOf('🟢 <b>BUY</b>', reportRadarHeaderIdx);

                expect(gradIdx).toBeGreaterThanOrEqual(0);
                expect(buyIdx).toBeGreaterThan(gradIdx);
            });

            it('omits the section entirely when no graduations', () => {
                const report = formatDailyReport('2026-04-27', [buyStock], [], [], []);
                expect(report).not.toContain('GRADUATION ALERT');
            });

            it('still shows graduation block when there are no actionable signals', () => {
                const report = formatDailyReport('2026-04-27', [], [], [], graduations);
                expect(report).toContain('GRADUATION ALERT');
                expect(report).toContain('NXPI');
                expect(report).toContain('אין מניות אקטיביות');
            });
        });
    });
});
