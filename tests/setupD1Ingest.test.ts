import {
    buildSetupRows,
    buildRsRows,
    buildBatches,
    regionOf,
    ingestSetupToD1,
} from '../src/utils/setupD1Ingest.js';
import type { StockData, MomentumResult } from '../src/types/index.js';

function momentum(level: 'full' | 'close' | 'recovery' | 'none', stage2 = true): MomentumResult {
    return {
        level,
        criteria: {
            rvolPass: true,
            stage2,
            lowRiskEntry: false,
            pivotBreakout: true,
            tightness: true,
            aboveGapAvwap: true,
            antsAccumulation: false,
            bigMoveToday: false,
            momentumGate: true,
        },
        failures: [],
        rvolThreshold: 2,
    };
}

function stock(over: Partial<StockData>): StockData {
    return {
        ticker: 'NVDA',
        currentVolume: 1_000_000,
        avgVolume: 500_000,
        rvol: 2.0,
        priceChange: 1.5,
        lastPrice: 100,
        news: [],
        ...over,
    } as StockData;
}

describe('setupD1Ingest — row building', () => {
    it('maps momentum levels to setup kinds and skips none', () => {
        const stocks = [
            stock({ ticker: 'AAA', momentum: momentum('full'), rsPercentile: 95, pctFromAth: -1.2 }),
            stock({ ticker: 'BBB', momentum: momentum('close'), rsPercentile: 70 }),
            stock({ ticker: 'CCC', momentum: momentum('recovery', false) }),
            stock({ ticker: 'DDD', momentum: momentum('none') }),
            stock({ ticker: 'EEE' }), // no momentum at all
        ];
        const rows = buildSetupRows(stocks, '2026-07-09');
        expect(rows.map((r) => [r.ticker, r.sig])).toEqual([
            ['AAA', 'setupFull'],
            ['BBB', 'setupClose'],
            ['CCC', 'setupRecovery'],
        ]);
        expect(rows[0]!.athPct).toBe(-1.2);
        expect(rows[2]!.stage2).toBe(0);
    });

    it('score = base + min(rvol,6)*5 + stage2 + RS>=90 bonus', () => {
        const [r] = buildSetupRows(
            [stock({ momentum: momentum('full'), rvol: 3, rsPercentile: 92 })],
            '2026-07-09'
        );
        // 60 + 15 + 20 + 10
        expect(r!.score).toBe(105);
        const [c] = buildSetupRows(
            [stock({ momentum: momentum('close', false), rvol: 10, rsPercentile: 50 })],
            '2026-07-09'
        );
        // 40 + 30 (capped) + 0 + 0
        expect(c!.score).toBe(70);
    });

    it('prefers projectedRvol over raw rvol', () => {
        const [r] = buildSetupRows(
            [stock({ momentum: momentum('full'), rvol: 1.0, projectedRvol: 4.0 })],
            '2026-07-09'
        );
        expect(r!.rvol).toBe(4.0);
    });

    it('buildRsRows keeps only stocks with an RS percentile', () => {
        const rows = buildRsRows(
            [stock({ ticker: 'AAA', rsPercentile: 88 }), stock({ ticker: 'BBB' })],
            '2026-07-09'
        );
        expect(rows).toEqual([{ scanDate: '2026-07-09', ticker: 'AAA', rs: 88 }]);
    });

    it('regionOf classifies TASE / foreign / US suffixes', () => {
        expect(regionOf('TLSY.TA')).toBe('TASE');
        expect(regionOf('000660.KS')).toBe('Foreign');
        expect(regionOf('NVDA')).toBe('US');
    });
});

describe('setupD1Ingest — batches', () => {
    it('creates tables, deletes per date, batches under the 100-param cap', () => {
        const setup = buildSetupRows(
            Array.from({ length: 15 }, (_, i) =>
                stock({ ticker: `T${i}`, momentum: momentum('close') })
            ),
            '2026-07-09'
        );
        const rs = buildRsRows(
            Array.from({ length: 65 }, (_, i) => stock({ ticker: `T${i}`, rsPercentile: 50 })),
            '2026-07-09'
        );
        const batches = buildBatches(setup, rs, 'stamp');
        expect(batches[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS setup_signals');
        expect(batches[1]!.sql).toContain('CREATE TABLE IF NOT EXISTS rs_daily');
        expect(batches[2]!.sql).toContain('DELETE FROM setup_signals');
        expect(batches[3]!.sql).toContain('DELETE FROM rs_daily');
        for (const b of batches) {
            expect(b.params.length).toBeLessThanOrEqual(100);
        }
        // 15 setup rows / 7 per batch = 3 inserts; 65 rs / 30 = 3 inserts
        const inserts = batches.filter((b) => b.sql.startsWith('INSERT'));
        expect(inserts).toHaveLength(6);
    });
});

describe('setupD1Ingest — soft-fail contract', () => {
    it('returns false (no throw) when CF_* env is missing', async () => {
        const ok = await ingestSetupToD1(
            [stock({ momentum: momentum('full') })],
            '2026-07-09',
            { accountId: '', databaseId: '', apiToken: '' }
        );
        expect(ok).toBe(false);
    });

    it('returns false (no throw) when the D1 request fails', async () => {
        const fetchSpy = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' } as Response);
        const ok = await ingestSetupToD1(
            [stock({ momentum: momentum('full') })],
            '2026-07-09',
            { accountId: 'a', databaseId: 'd', apiToken: 't' }
        );
        expect(ok).toBe(false);
        fetchSpy.mockRestore();
    });
});
