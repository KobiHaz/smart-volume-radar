import { tvToYahoo } from '../src/services/symbolMap';

describe('tvToYahoo', () => {
    it('strips US exchange prefixes (incl. OTC)', () => {
        expect(tvToYahoo('NASDAQ:NVDA')).toBe('NVDA');
        expect(tvToYahoo('NYSE:XOM')).toBe('XOM');
        expect(tvToYahoo('OTC:SAFRF')).toBe('SAFRF');
    });

    it('converts US class shares to Yahoo dash form', () => {
        expect(tvToYahoo('NYSE:BRK.B')).toBe('BRK-B');
    });

    it('maps international exchanges to Yahoo suffixes', () => {
        expect(tvToYahoo('TASE:QLTU')).toBe('QLTU.TA');
        expect(tvToYahoo('TSE:6857')).toBe('6857.T');
        expect(tvToYahoo('KRX:000660')).toBe('000660.KS');
        expect(tvToYahoo('XETR:RHM')).toBe('RHM.DE');
        expect(tvToYahoo('SET:KIOXIA23')).toBe('KIOXIA23.BK');
    });

    it('strips a trailing dot on LSE tickers (BA. → BA.L, not BA..L)', () => {
        expect(tvToYahoo('LSE:BA.')).toBe('BA.L');
        expect(tvToYahoo('LSE:RR.')).toBe('RR.L');
    });

    it('resolves known EURONEXT symbols via the override table', () => {
        expect(tvToYahoo('EURONEXT:ASML')).toBe('ASML.AS');
        expect(tvToYahoo('EURONEXT:AIR')).toBe('AIR.PA');
    });

    it('returns null for ambiguous EURONEXT and unknown exchanges', () => {
        expect(tvToYahoo('EURONEXT:UNKNOWNX')).toBeNull();
        expect(tvToYahoo('BINANCE:BTCUSDT')).toBeNull();
        expect(tvToYahoo('FX:EURUSD')).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(tvToYahoo('')).toBeNull();
        expect(tvToYahoo('NASDAQ:')).toBeNull();
    });
});
