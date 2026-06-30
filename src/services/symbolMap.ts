/**
 * Convert a TradingView `EXCHANGE:SYMBOL` into the Yahoo Finance symbol the radar
 * scans with (Yahoo is the market-data provider). Returns `null` when the exchange is
 * unknown or the venue is ambiguous — the caller reports and skips those, mirroring the
 * `invalidSkipped` handling in `parseWatchlistCsv`.
 *
 * Inverse of `toTradingViewSymbol` in tradingViewWatchlist.ts, extended to cover the
 * exchanges that appear in the synced lists (Tokyo, Thailand, HK, etc.).
 */

/** TradingView exchange prefix → Yahoo suffix appended after the base ticker. */
const PREFIX_TO_SUFFIX: Record<string, string> = {
    TASE: '.TA', // Tel Aviv
    XETR: '.DE', // Frankfurt Xetra
    FWB: '.F', // Frankfurt floor
    SIX: '.SW', // Swiss
    LSE: '.L', // London
    MIL: '.MI', // Milan
    VIE: '.VI', // Vienna
    TWSE: '.TW', // Taiwan
    KRX: '.KS', // Korea (KOSPI default; KOSDAQ .KQ not distinguishable from prefix)
    BMFBOVESPA: '.SA', // Brazil
    BME: '.MC', // Madrid
    TSE: '.T', // Tokyo
    SET: '.BK', // Thailand
    HKEX: '.HK', // Hong Kong
    ASX: '.AX', // Australia
    TSX: '.TO', // Toronto
    TSXV: '.V', // Toronto Venture
    NSE: '.NS', // India NSE
    BSE: '.BO', // India BSE
    OMXSTO: '.ST', // Stockholm
    OMXHEX: '.HE', // Helsinki
    OMXCOP: '.CO', // Copenhagen
    OSL: '.OL', // Oslo
    WSE: '.WA', // Warsaw
};

/** US exchanges → bare Yahoo ticker (no suffix). OTC/Pink tickers exist on Yahoo as-is. */
const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'NYSEARCA', 'BATS', 'CBOE', 'OTC']);

/**
 * EURONEXT collapses Paris/Amsterdam/Brussels/Lisbon under one TradingView prefix, so it
 * cannot be inverted from the prefix alone. Disambiguate known tickers; otherwise skip.
 */
const EURONEXT_OVERRIDES: Record<string, string> = {
    ASML: '.AS', // Amsterdam
    BESI: '.AS', // BE Semiconductor — Amsterdam
    ADYEN: '.AS',
    PRX: '.AS',
    HEIA: '.AS',
    INGA: '.AS',
    MT: '.AS',
    THEON: '.AS', // Theon International — Amsterdam
    SOI: '.PA', // Soitec — Paris
    NXI: '.PA', // Nexity — Paris
    EXA: '.PA', // Exosens — Paris
    EXENS: '.PA', // Exosens (full ticker) — Paris
    DSY: '.PA', // Dassault Systèmes — Paris
    AIR: '.PA',
    MC: '.PA',
    OR: '.PA',
    TTE: '.PA',
    SAN: '.PA',
    BNP: '.PA',
};

/**
 * Map e.g. "NASDAQ:NVDA" → "NVDA", "TASE:QLTU" → "QLTU.TA", "TSE:6857" → "6857.T",
 * "NYSE:BRK.B" → "BRK-B". Returns null for unknown/ambiguous exchanges (crypto, FX,
 * unlisted EURONEXT, …).
 */
export function tvToYahoo(tvSymbol: string): string | null {
    const raw = tvSymbol.trim();
    if (!raw) return null;

    const idx = raw.indexOf(':');
    if (idx === -1) {
        // No exchange prefix — assume a bare US ticker; normalize class shares.
        return raw.replace(/\./g, '-');
    }

    const exchange = raw.slice(0, idx).toUpperCase();
    const base = raw.slice(idx + 1).trim();
    if (!base) return null;

    if (US_EXCHANGES.has(exchange)) {
        return base.replace(/\./g, '-'); // BRK.B → BRK-B
    }
    // For suffix exchanges, strip a trailing dot so LSE "BA." → "BA" → "BA.L" (not "BA..L").
    const suffixBase = base.replace(/\.$/, '');
    if (exchange === 'EURONEXT') {
        const suffix = EURONEXT_OVERRIDES[base.toUpperCase()];
        return suffix ? `${suffixBase}${suffix}` : null;
    }
    const suffix = PREFIX_TO_SUFFIX[exchange];
    return suffix ? `${suffixBase}${suffix}` : null;
}
