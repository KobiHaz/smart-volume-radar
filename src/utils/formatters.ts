/**
 * Smart Volume Radar - Display Formatters
 * Consistent formatting for RVOL and price changes using config.formatPrecision.
 */

import { config } from '../config/index.js';

/** Format RVOL for display (e.g. "3.25x") */
export function formatRVOL(rvol: number): string {
    return `${rvol.toFixed(config.formatPrecision.rvol)}x`;
}

/** Format price change for display (e.g. "+5.42%" or "-2.31%") */
export function formatPriceChange(change: number): string {
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(config.formatPrecision.pct)}%`;
}
