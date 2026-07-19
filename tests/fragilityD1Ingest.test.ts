import {
    buildFragilityBatches,
    ingestFragilityToD1,
    FRAGILITY_COL_COUNT,
    ROWS_PER_INSERT,
} from '../src/utils/fragilityD1Ingest.js';
import type { FragilityDay } from '../src/services/purpleFragility.js';

function day(date: string, score: number | null): FragilityDay {
    return {
        date,
        score,
        z: { wick10: 0.1, pctAbove50: 0.2, dist20: 0.3, ext50: 0.4, corr20: 0.5, disp10: 0.6 },
        raw: { wick10: 0.25, pctAbove50: 0.8, dist20: 3, ext50: 0.15, corr20: 0.4, disp10: 0.02 },
        indexValue: 2.5,
        drawdownPct: -1.23,
        canaryCount: 2,
        indexNearHigh: true,
    };
}

describe('buildFragilityBatches', () => {
    it('stays under the D1 100-bound-param cap', () => {
        expect(FRAGILITY_COL_COUNT * ROWS_PER_INSERT).toBeLessThanOrEqual(100);
    });

    it('emits CREATE first, then a range DELETE from the first ingested date', () => {
        const days = [day('2026-07-01', 0.5), day('2026-07-02', 0.6)];
        const batches = buildFragilityBatches(days, 'stamp');
        expect(batches[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS fragility_daily');
        expect(batches[1]!.sql).toBe('DELETE FROM fragility_daily WHERE scan_date >= ?');
        expect(batches[1]!.params).toEqual(['2026-07-01']);
    });

    it('skips null-score (burn-in) days entirely', () => {
        const days = [day('2026-06-30', null), day('2026-07-01', 0.5)];
        const batches = buildFragilityBatches(days, 'stamp');
        // DELETE starts at the first SCORED date, not the burn-in date.
        expect(batches[1]!.params).toEqual(['2026-07-01']);
        const insert = batches[2]!;
        expect(insert.params.length).toBe(FRAGILITY_COL_COUNT);
        expect(insert.params[0]).toBe('2026-07-01');
    });

    it('chunks inserts at ROWS_PER_INSERT rows (9 rows → 2 insert batches)', () => {
        const days = Array.from({ length: 9 }, (_, i) =>
            day(`2026-07-${String(i + 1).padStart(2, '0')}`, 0.5)
        );
        const batches = buildFragilityBatches(days, 'stamp');
        const inserts = batches.filter((b) => b.sql.startsWith('INSERT'));
        expect(inserts.length).toBe(2);
        expect(inserts[0]!.params.length).toBe(ROWS_PER_INSERT * FRAGILITY_COL_COUNT); // 96
        expect(inserts[1]!.params.length).toBe(1 * FRAGILITY_COL_COUNT);
    });

    it('orders row params to match the column list', () => {
        const batches = buildFragilityBatches([day('2026-07-01', 0.5)], 'the-stamp');
        const p = batches[2]!.params;
        expect(p).toEqual([
            '2026-07-01', 0.5,
            0.1, 0.2, 0.3, 0.4, 0.5, 0.6,   // z components
            2.5, -1.23, 2, 'the-stamp',
        ]);
    });

    it('emits only CREATE when no scored rows exist', () => {
        const batches = buildFragilityBatches([day('2026-07-01', null)], 'stamp');
        expect(batches.length).toBe(1);
    });
});

describe('ingestFragilityToD1', () => {
    it('returns false (no-op) for a null result', async () => {
        await expect(ingestFragilityToD1(null, '2026-07-01')).resolves.toBe(false);
    });

    it('returns false and never throws when CF_* config is missing', async () => {
        const result = {
            scanDate: '2026-07-01',
            series: [day('2026-07-01', 0.5)],
            latest: day('2026-07-01', 0.5),
            prevScore: null,
            crossedUp: false,
            canaryCount: 0,
            indexNearHigh: false,
            tickersUsed: ['A'],
            tickersFailed: [],
        };
        await expect(
            ingestFragilityToD1(result, '2026-07-01', { accountId: '', databaseId: '', apiToken: '' })
        ).resolves.toBe(false);
    });
});
