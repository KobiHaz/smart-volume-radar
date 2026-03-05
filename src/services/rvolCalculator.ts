/**
 * Smart Volume Radar - RVOL Calculator
 * Calculates Relative Volume and identifies high-volume signals
 */

import { StockData, RVOLConfig } from '../types/index.js';
import logger from '../utils/logger.js';
import { isFullSetup, isCloseSetup } from '../utils/setup.js';

export { formatRVOL, formatPriceChange } from '../utils/formatters.js';

/**
 * RVOL calculation results
 */
export interface RVOLCalcResult {
    topSignals: StockData[];
    volumeWithoutPrice: StockData[];
}

/**
 * Calculate RVOL and filter/rank stocks
 * Boosts stocks in consolidation setup (near SMA21, near ATH, 6mo-3y base)
 * @param stocks - Array of stock data
 * @param config - RVOL configuration
 * @returns Top signals and volume-without-price stocks
 */
export function calculateRVOL(stocks: StockData[], rvolConfig: RVOLConfig): RVOLCalcResult {
    const { minRVOL, topN, priceChangeThreshold } = rvolConfig;

    // Filter stocks with RVOL >= threshold
    const highRVOL = stocks.filter((s) => s.rvol >= minRVOL);

    logger.info(`Found ${highRVOL.length} stocks with RVOL >= ${minRVOL}`);

    // Sort by RVOL descending, with consolidation setup as tie-breaker (full > close > none)
    highRVOL.sort((a, b) => {
        const rvolDiff = b.rvol - a.rvol;
        if (Math.abs(rvolDiff) >= 0.5) return rvolDiff > 0 ? 1 : -1; // RVOL dominates
        const boostA = isFullSetup(a) ? 2 : isCloseSetup(a) ? 1 : 0;
        const boostB = isFullSetup(b) ? 2 : isCloseSetup(b) ? 1 : 0;
        return boostB - boostA || rvolDiff;
    });

    const fullCount = highRVOL.filter(isFullSetup).length;
    const closeCount = highRVOL.filter(isCloseSetup).length;
    if (fullCount > 0 || closeCount > 0) {
        logger.info(`Identified ${fullCount} full + ${closeCount} close consolidation setup(s)`);
    }

    // Top N signals
    const topSignals = highRVOL.slice(0, topN);

    // Volume without Price (high volume, low price change = silent accumulation/distribution)
    // This is a subset of highRVOL stocks where price didn't move much despite high volume
    const volumeWithoutPrice = highRVOL.filter(
        (s) => Math.abs(s.priceChange) < priceChangeThreshold
    );

    if (volumeWithoutPrice.length > 0) {
        logger.info(
            `Identified ${volumeWithoutPrice.length} "Volume w/o Price" stocks (|change| < ${priceChangeThreshold}%)`
        );
    }

    return { topSignals, volumeWithoutPrice };
}

/**
 * Determine if stock is bullish or bearish based on price change
 */
export function isBullish(stock: StockData): boolean {
    return stock.priceChange >= 0;
}
