/**
 * Smart Volume Radar - Type Definitions
 * Core interfaces for stock data, news, and RVOL results
 */

/** Newlogic tags: independent signals per stock */
export type NewlogicTag = 'SMA21 Touch' | 'Pullback 15%' | '1M Breakout';

/**
 * Momentum-edition signal level (additive, orthogonal to NewlogicTag/entryPath).
 *   • 'full'      — Stage 2 momentum breakout (4 mandatory + ≥1 quality marker)
 *   • 'recovery'  — Bear-market recovery rally: above SMA50, SMA50 turning up,
 *                   pivot break, RVOL ≥ 2.5. SMA200 may still be down.
 *   • 'close'     — Watchlist (RVOL ≥ 1.5 + pivot or near-SMA21)
 *   • 'none'      — No signal
 */
export type MomentumLevel = 'full' | 'recovery' | 'close' | 'none';

/** Per-criterion booleans recorded for diagnostics + Telegram tooltip */
export interface MomentumCriteria {
    /** projectedRvol >= regime-aware threshold (2.0 bull / 3.0 bear) */
    rvolPass: boolean;
    /** price > SMA50 AND SMA50 > SMA200 AND SMA200 slope not declining */
    stage2: boolean;
    /** distance from SMA21 <= 8% */
    lowRiskEntry: boolean;
    /** lastPrice >= ath * 0.98 */
    pivotBreakout: boolean;
    /** daysSinceAth >= 15 (rested ≥ 3 weeks before breakout) */
    tightness: boolean;
    /** No earnings gap, OR price still >= AVWAP anchored at the gap */
    aboveGapAvwap: boolean;
    /** ≥12 green days in last 15 (independent flag — does not gate Full) */
    antsAccumulation: boolean;
    /** Today's priceChange ≥ 3% — explosive continuation breakout day. Quality marker. */
    bigMoveToday: boolean;
}

export interface MomentumResult {
    level: MomentumLevel;
    criteria: MomentumCriteria;
    /** Names of criteria that prevented Full (empty when level==='full', or when bypass granted Full) */
    failures: Array<keyof MomentumCriteria>;
    /** Threshold used for rvolPass (depends on regime) */
    rvolThreshold: number;
    /** True when Full was granted via the high-conviction bypass (RVOL≥3 + pivot + Stage 2 → ignore lowRiskEntry). */
    highConvictionBypass?: boolean;
}

/**
 * Raw stock data from market API
 */
export interface StockData {
    ticker: string;
    currentVolume: number;
    avgVolume: number;
    rvol: number;
    priceChange: number;
    lastPrice: number;
    sma50?: number;
    sma200?: number;
    sma21?: number;
    rsi?: number;
    sector?: string;
    /** All-time high (52w) from price history */
    ath?: number;
    /** Source of high: 5y = Yahoo 5-year history, 52w = Twelve Data 52-week high */
    athSource?: '5y' | '52w';
    /** Percentage distance from ATH (e.g. -15 = 15% below ATH) */
    pctFromAth?: number;
    /** Months since ATH was reached (approx consolidation duration) */
    monthsInConsolidation?: number;
    /** Last trading day low (for SMA21 Touch) — Yahoo only */
    lastDayLow?: number;
    /** Last trading day high (for SMA21 Touch) — Yahoo only */
    lastDayHigh?: number;
    /** Newlogic tags: SMA21 Touch, Pullback 15%, 1M Breakout */
    tags?: NewlogicTag[];
    /** How the stock entered topSignals: green (RVOL+price), pullback (Pullback 15%), or sma21 (SMA21 Touch) */
    entryPath?: 'green' | 'pullback' | 'sma21';

    // ─── Momentum Edition (additive) ────────────────────────────────────────
    /** Slope of SMA200 over last ~20 bars: 'up' / 'flat' / 'down' */
    sma200Slope?: 'up' | 'flat' | 'down';
    /** Slope of SMA50 over last ~10 bars: 'up' / 'flat' / 'down' (used by Recovery Rally tier) */
    sma50Slope?: 'up' | 'flat' | 'down';
    /** Trading days since last touch of 52w high */
    daysSinceAth?: number;
    /** Consecutive green-day count over last 15 bars (close[i] > close[i-1]) */
    consecutiveGreenDays?: number;
    /** Latest detected earnings/news gap day (open > prevHigh by ≥3%) within last 60 bars.
     *  `barsAgo` = trading days from gap to current bar (0 means gap is today). */
    gapDay?: { date: string; level: number; barsAgo: number } | null;
    /** Anchored VWAP from gapDay forward (price still above it = signal valid) */
    avwapFromGap?: number;
    /** Time-weighted RVOL: currentVolume / (minutesElapsed/390) / avg63DayVolume. Equals rvol after close. */
    projectedRvol?: number;
    /** Market regime at scan time (set from SPY) — affects RVOL threshold for Full */
    marketRegime?: 'bull' | 'bear';

    // ─── Phase 2 indicators (ChampionScan-inspired, added 2026-05-07) ──────
    /** Bollinger Band upper line (SMA20 + 2σ). */
    bbUpper?: number;
    /** Bollinger Band middle line (SMA20). */
    bbMid?: number;
    /** Bollinger Band lower line (SMA20 - 2σ). */
    bbLower?: number;
    /** Exponential Moving Average over 10 bars (faster than SMA10 for trend reactivity). */
    ema10?: number;
    /** Exponential Moving Average over 21 bars (parallels existing sma21, EMA-style). */
    ema21Ema?: number;
    /** Number of accumulation days (close-up + above-avg volume) in last 25 bars. */
    accumulationDays?: number;
    /** Number of distribution days (close-down + above-avg volume) in last 25 bars.
     *  ≥4 = institutional selling warning. */
    distributionDays?: number;
    /** Total return over the last 63 trading days (~3 months), as % (e.g. +12.5).
     *  Used as the input for relative-strength ranking. */
    return63d?: number;
    /** Total return over the last 21 trading days (~1 month), as % — used for
     *  short-window sector context. */
    return21d?: number;
    /** Relative-Strength percentile (0-100) vs other watchlist members over 63 trading
     *  days, using SPY-relative return (alpha). Populated post-fetch in `index.ts`. */
    rsPercentile?: number;
    /** Sector rank (1 = best) from `applySectorRanks` — populated in pipeline. */
    sectorRank?: number;
    /** Sector's 63-day median return (%) — used for Telegram render. */
    sectorMedianReturn63d?: number;
    /** Number of stocks in this sector that had valid return63d (sector sample size). */
    sectorTotalCount?: number;

    // ─── Phase 3: Fundamentals (Finnhub, added 2026-05-07) ─────────────────
    /** Next upcoming earnings date (YYYY-MM-DD). null if unknown / no upcoming. */
    nextEarningsDate?: string | null;
    /** Calendar days from today (scan date) to nextEarningsDate. */
    daysToEarnings?: number | null;
    /** EPS YoY growth-rate trajectory: accelerating / decelerating / flat / null. */
    epsAcceleration?: AccelerationTrend | null;
    /** Revenue YoY growth-rate trajectory. */
    revAcceleration?: AccelerationTrend | null;
    /** Computed momentum signal (set by evaluateMomentumSetup downstream of fetch) */
    momentum?: MomentumResult;

    // ─── Champion-Score Layer (additive, post-momentum) ─────────────────────
    /** Continuous quality score 0-100 (composite of stable predictors per
     *  2026-05-06 criteria-importance analysis). See `evaluateChampionScore`. */
    championScore?: number;
    /** Actionable label combining score + breakout stage + volume confirmation.
     *  Inspired by ChampionScan's 6-state vocabulary. */
    action?: ActionLabel;
    /** Trade-execution helpers — pivot, buy zone, stop, risk %. */
    tradePlan?: TradePlan;
    /** Where the stock sits in its breakout cycle (Setup → Fresh → Aging → ...) */
    breakoutStage?: BreakoutStage;
}

/**
 * Trajectory of a fundamental metric's YoY growth rate over the last two
 * quarters. 'accelerating' = latest YoY growth > prior YoY growth + threshold;
 * 'decelerating' = latest < prior - threshold; 'flat' otherwise; null when
 * not enough data.
 */
export type AccelerationTrend = 'accelerating' | 'decelerating' | 'flat';

/**
 * Six-state action label that pairs with the continuous Champion Score.
 * The action is what to DO; the score is HOW GOOD the setup is.
 *  - BUY              — actionable now: at pivot + score ≥ 70 + volume confirmed
 *  - WATCH            — qualifying setup, waiting for the breakout
 *  - CAUTION_EXTENDED — past pivot ≤10%, risky entry without strong volume
 *  - CAUTION_NO_VOL   — at pivot but RVOL doesn't confirm institutional interest
 *  - PASS_TOO_LATE    — extended >10% past pivot, missed it
 *  - PASS             — score below threshold or trend broken
 */
export type ActionLabel =
    | 'BUY'
    | 'WATCH'
    | 'CAUTION_EXTENDED'
    | 'CAUTION_NO_VOL'
    | 'CAUTION_DISTRIBUTION'
    | 'PASS_TOO_LATE'
    | 'PASS';

/** Where the stock is in its breakout cycle. */
export type BreakoutStage =
    | 'Breaking Out'  // Today set a new ATH AND price ≥ pivot
    | 'Fresh'         // 1-3 trading days since first piercing the pivot
    | 'Aging'         // 4-10 trading days since pivot break, still above
    | 'Setup'         // In a base / consolidation, not yet at pivot
    | 'Failed'        // Was at pivot but pulled back significantly
    | 'Pre-Pivot';    // Approaching pivot but not there yet

/**
 * Trade execution plan derived from technical levels — pivot, buy zone,
 * stop loss, and risk %. Parallel to ChampionScan's "Buy Near / Stop / Risk".
 */
export interface TradePlan {
    /** Reference pivot — typically 52w high / ATH. */
    pivot: number;
    /** Suggested entry zone: pivot ± 2%. */
    buyZoneLow: number;
    buyZoneHigh: number;
    /** Stop loss — currently SMA21 × 0.95 (5% below SMA21), null when SMA21 missing. */
    stopLoss: number | null;
    /** Risk % from current price to stop. Negative number (e.g. -5.2%). */
    riskPct: number | null;
    /** Distance from current price to pivot, as % (positive = below, negative = above). */
    distanceToEntryPct: number;
    /** Extension % past pivot, 0 if not past. */
    extensionPct: number;
}

/**
 * News article from Finnhub
 */
export interface NewsItem {
    headline: string;
    url: string;
    source: string;
    publishedAt: Date;
}

/**
 * RVOL result with news enrichment
 */
export interface RVOLResult extends StockData {
    news: NewsItem[];
    isVolumeWithoutPrice: boolean;
}

/**
 * Configuration for RVOL calculation
 */
export interface RVOLConfig {
    minRVOL: number;
    topN: number;
    priceChangeThreshold: number;
}

/**
 * Daily scan results
 */
export interface ScanResults {
    date: string;
    totalScanned: number;
    signalsFound: number;
    topSignals: RVOLResult[];
    volumeWithoutPrice: StockData[];
    executionTimeMs: number;
}

/** Per-stock entry for stored results */
export interface StoredSignal {
    ticker: string;
    lastPrice: number;
    rvol: number;
    tags: NewlogicTag[];
    source: 'topSignals-green' | 'topSignals-pullback' | 'topSignals-sma21' | 'volumeWithoutPrice';
    /** Momentum-edition: 'full' / 'recovery' / 'close' when triggered, omitted otherwise (back-compat with old result files) */
    momentumLevel?: 'full' | 'recovery' | 'close';
}

/** Daily scan output for persistence and evaluation (legacy — being phased out). */
export interface StoredScanResult {
    date: string; // YYYY-MM-DD
    signals: StoredSignal[];
}

/**
 * NEW SCHEMA — full per-stock snapshot for ALL stocks scanned (not just signals).
 * Saved as `results/scan-YYYY-MM-DD.json`. Enables retroactive debugging of
 * "why didn't X fire?" without re-fetching from Yahoo.
 */
export interface ScanStockSnapshot {
    // ─── Identification ──────────────────────────────────────────────
    ticker: string;
    sector?: string;

    // ─── Verdict ─────────────────────────────────────────────────────
    /** Final classification by evaluateMomentumSetup */
    level: MomentumLevel;
    /** True when Full was granted via the high-conviction bypass (not pristine entry) */
    highConvictionBypass?: boolean;

    // ─── Price + Volume ──────────────────────────────────────────────
    lastPrice: number;
    /** % change vs previous close */
    priceChange: number;
    currentVolume: number;
    /** 63-day average volume (used by RVOL) */
    avgVolume: number;
    rvol: number;
    /** Time-weighted intraday RVOL (=== rvol after market close) */
    projectedRvol: number;

    // ─── Indicators ──────────────────────────────────────────────────
    sma21?: number;
    sma50?: number;
    sma200?: number;
    sma200Slope?: 'up' | 'flat' | 'down';
    sma50Slope?: 'up' | 'flat' | 'down';
    rsi?: number;
    /** 52w high (close basis) */
    ath?: number;
    /** % distance from ATH (negative when below) */
    pctFromAth?: number;
    /** Trading days since last touch of the prior cycle high */
    daysSinceAth?: number;
    /** Consecutive green-day count over last 15 bars */
    consecutiveGreenDays?: number;

    // ─── Gap data (optional, when detected) ──────────────────────────
    gapDay?: { date: string; level: number; barsAgo: number } | null;
    /** Anchored VWAP from the gap day forward */
    avwapFromGap?: number;

    // ─── Decision detail (for debugging "why?") ──────────────────────
    momentum: MomentumResult;
}

export interface ScanResultDay {
    date: string; // YYYY-MM-DD
    /** Wall-clock time the scan took (informational) */
    scanTimeMs?: number;
    /** SPY-derived market regime at scan time */
    marketRegime: 'bull' | 'bear';

    // Watchlist coverage
    watchlistTotal: number;
    fetchedSuccessfully: number;
    failedTickers: string[];

    /** Quick counts by level (for at-a-glance review) */
    summary: {
        full: number;
        recovery: number;
        watchlist: number;
        none: number;
    };

    /** Per-stock snapshots — INCLUDING level='none' for retro debugging */
    stocks: ScanStockSnapshot[];
}

/**
 * Monitor list — tracks tickers from FIRST alert through resolution.
 * State machine:
 *   monitoring (initial) →
 *      graduated     (later fired Full → BUY signal)
 *      manual-entry  (clean breakout: pivot+RVOL+green day)
 *      sma21-pullback (clean pullback to SMA21 with low RVOL)
 *      expired       (30 trading days without resolution)
 *      stopped       (entered + stopped out — for tracking only, doesn't re-add)
 */
export type MonitorStatus = 'monitoring' | 'graduated' | 'manual-entry' | 'sma21-pullback' | 'expired' | 'stopped';

export interface MonitorEvent {
    /** Date of the event (YYYY-MM-DD) */
    date: string;
    /** Brief description: e.g. "alert-Full", "alert-Watchlist", "graduated", "expired" */
    type: string;
    /** Price at the event */
    price: number;
    /** RVOL at the event (when relevant) */
    rvol?: number;
    /** Free-form note */
    note?: string;
}

export interface MonitorEntry {
    ticker: string;
    /** Date of FIRST alert that put this ticker into the monitor list */
    firstAlertDate: string;
    /** Level of FIRST alert: full / recovery / close */
    firstAlertLevel: 'full' | 'recovery' | 'close';
    /** Price at first alert (for return tracking) */
    firstAlertPrice: number;
    /** RVOL at first alert */
    firstAlertRvol: number;
    /** Last date this entry was checked / refreshed */
    lastChecked: string;
    /** Current status (state machine) */
    status: MonitorStatus;
    /** Date status changed to non-'monitoring' (graduated/manual-entry/etc.) */
    resolvedDate?: string;
    /** Price at resolution (for "if I had entered then" tracking) */
    resolvedPrice?: number;
    /** Brief reason for resolution */
    resolvedReason?: string;
    /** Sector for grouping in Telegram report */
    sector?: string;
    /** Audit trail of significant events on this monitor */
    events: MonitorEvent[];
}

export interface MonitorState {
    /** Last full update date (YYYY-MM-DD) */
    lastUpdated: string;
    /** All entries — both active and resolved (kept for history) */
    entries: MonitorEntry[];
}

/**
 * API response from Finnhub news endpoint
 */
export interface FinnhubNewsResponse {
    category: string;
    datetime: number;
    headline: string;
    id: number;
    image: string;
    related: string;
    source: string;
    summary: string;
    url: string;
}

/**
 * Market status for checking if market is open
 */
export interface MarketStatus {
    isOpen: boolean;
    exchange: string;
    currentTime: Date;
    message?: string;
}

/**
 * Telegram API Error response
 */
export interface TelegramApiError {
    ok: boolean;
    error_code: number;
    description: string;
}
