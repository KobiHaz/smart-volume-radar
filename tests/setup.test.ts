/**
 * Setup Utilities Tests
 */

import { isFullSetup, isCloseSetup } from '../src/utils/setup';

describe('setup', () => {
    const base = {
        ticker: 'TEST',
        currentVolume: 1e6,
        avgVolume: 500e3,
        rvol: 2,
        priceChange: 1,
        lastPrice: 100,
    };

    describe('isFullSetup', () => {
        it('returns true when nearSMA21, nearAth, inConsolidationWindow', () => {
            const s = { ...base, nearSMA21: true, nearAth: true, inConsolidationWindow: true };
            expect(isFullSetup(s)).toBe(true);
        });
        it('returns false when any condition is false', () => {
            expect(isFullSetup({ ...base, nearSMA21: false, nearAth: true, inConsolidationWindow: true })).toBe(false);
            expect(isFullSetup({ ...base, nearSMA21: true, nearAth: false, inConsolidationWindow: true })).toBe(false);
            expect(isFullSetup({ ...base, nearSMA21: true, nearAth: true, inConsolidationWindow: false })).toBe(false);
        });
        it('returns false when all undefined', () => {
            expect(isFullSetup(base)).toBe(false);
        });
    });

    describe('isCloseSetup', () => {
        it('returns true when all Close variants met', () => {
            const s = { ...base, nearSMA21Close: true, nearAthClose: true, inConsolidationClose: true };
            expect(isCloseSetup(s)).toBe(true);
        });
        it('returns true when mix of met and close', () => {
            const s = { ...base, nearSMA21: true, nearAthClose: true, inConsolidationWindow: true };
            expect(isCloseSetup(s)).toBe(true);
        });
        it('returns false when any condition missing', () => {
            expect(isCloseSetup({ ...base, nearSMA21: true, nearAth: true })).toBe(false); // no base
        });
    });
});
