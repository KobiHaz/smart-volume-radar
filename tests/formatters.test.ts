/**
 * Formatters Utilities Tests
 */

jest.mock('../src/config/index.js', () => ({
    config: {
        formatPrecision: { price: 2, pct: 2, base: 2, rvol: 2, rsi: 0 },
    },
}));

import { formatRVOL, formatPriceChange } from '../src/utils/formatters';

describe('formatters', () => {
    describe('formatRVOL', () => {
        it('formats with config precision', () => {
            expect(formatRVOL(2.5)).toBe('2.50x');
            expect(formatRVOL(3.123)).toBe('3.12x');
        });
    });
    describe('formatPriceChange', () => {
        it('includes sign for positive', () => {
            expect(formatPriceChange(1.5)).toBe('+1.50%');
        });
        it('includes sign for negative', () => {
            expect(formatPriceChange(-2.3)).toBe('-2.30%');
        });
        it('uses config precision', () => {
            expect(formatPriceChange(0.123)).toBe('+0.12%');
        });
    });
});
