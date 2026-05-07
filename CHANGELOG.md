# Changelog

## Unreleased

### Added
- **ChampionScan Phase 3 (2026-05-07):** Fundamentals via Finnhub.
  - New service `src/services/finnhubFundamentals.ts` — fetches earnings
    calendar (next ≤90 days) + quarterly EPS + quarterly revenue. On-disk
    cache at `results/finnhub-cache/{ticker}.json` with 7-day TTL.
  - New utility `src/utils/acceleration.ts` — `computeAcceleration()`
    classifies a quarterly series as `accelerating | decelerating | flat`
    using YoY growth-rate trajectory (Q[0]/Q[4] vs Q[1]/Q[5], 5pp threshold).
    Falls back to QoQ when 6th quarter missing.
  - `enrichWithFundamentals(stocks)` — p-limit(3), populates 4 fields:
    `nextEarningsDate`, `daysToEarnings`, `epsAcceleration`, `revAcceleration`.
    Wired in `index.ts` after RS percentile, before Champion Score.
  - **Champion Score v3** weights: +5 EPS accelerating, **-5** EPS decelerating,
    +3 Rev accelerating. Earnings date is informational (no score change).
  - Telegram block: `📅 Earnings in 5d ⚠️ elevated risk` line when ≤7 days,
    `💰 Fundamentals: EPS ▲ accelerating | Rev ▲ accelerating` when set.
  - `.gitignore` excludes `results/finnhub-cache/`.
- **ChampionScan Phase 2 (2026-05-07):** Volume quality, trend bands, RS percentile.
  - New indicators in `src/utils/technicalAnalysis.ts`: `calculateBollingerBands`,
    `calculateEMA`, `countAccumulationDistributionDays` (25-day lookback,
    above-avg-volume up/down days).
  - Fields populated on every `StockData`: `bbUpper/Mid/Lower`, `ema10`,
    `ema21Ema`, `accumulationDays`, `distributionDays`, `return63d`.
  - **RS percentile** vs SPY: new `src/utils/rsPercentile.ts` — alpha = stock
    return63d − SPY return63d, ranked 0-100 across the watchlist with tie
    handling. Wired in `index.ts` after fetch.
  - **Champion Score v2** weights: +5 accumDays≥3, **-10** distDays≥3, +5 RS≥80,
    +3 BB squeeze (band-width / price < 5%).
  - **New action `CAUTION_DISTRIBUTION`** — fires when distributionDays ≥ 4,
    overrides BUY/WATCH (institutional selling > technical setup).
  - Telegram block now shows: RS percentile next to score, A/D days line with
    Accumulation / Mixed / Distribution verdict, BB squeeze flag with band-width %.
- **Champion Score Layer (2026-05-06):** Continuous quality score 0-100 plus
  6-state action label (BUY / WATCH / CAUTION_EXTENDED / CAUTION_NO_VOL /
  PASS / PASS_TOO_LATE) and a per-stock trade plan (pivot, buy zone, stop loss,
  risk %, distance to entry, extension %). Inspired by championscan.com after
  research session 2026-05-06; weights derived from our own 2026-05-06
  criteria-importance analysis (86 days, train+test stable). New file
  `src/utils/championScore.ts` (pure & synchronous).
- **Telegram report (2026-05-06):** Now driven by action labels instead of
  momentum tiers. Sections: 🟢 BUY → ⚠️ CAUTION → 👀 WATCH. PASS / PASS_TOO_LATE
  filtered out (not actionable). Each block shows Champion Score, breakout
  stage (Breaking Out / Fresh / Aging / Pre-Pivot / Setup / Failed), and full
  trade plan (Buy zone $X-$Y, Pivot $Z, Stop $W, Risk -N%).
- **Momentum Edition:** Stage 2 Momentum Breakout scoring layer (Intel/AMKR/MXL pattern). 8 criteria — 4 mandatory (RVOL · Stage2 · Pivot · AVWAP) + 4 quality (LowRisk · Tightness · Ants · BigMove). Tiers: 🎯 Full / 🦅 Recovery (bull bounce, no SMA200 yet) / 👀 Watchlist. Regime-aware RVOL threshold (bull=2.0, bear=3.0). New helpers: `projectedRvol`, `calculateAVWAP`, `detectEarningsGap`, `calculateSMA200Slope`, `countConsecutiveGreenDays`. New file `src/utils/setup.ts` (the momentum brain).
- **Monitor follow-up tracking:** New scan-to-scan state machine in `src/services/monitorTracker.ts` + `src/utils/monitorStore.ts`. Surfaces graduations, manual-entry candidates, SMA21 pullbacks, expirations as a separate Telegram message. Persists to `results/monitor-list.json` (now committed daily so CI runs share state).
- **Newlogic tags:** Replaced legacy Setup (🎯/👀) with independent tags: SMA21 Touch, Pullback 15%, 1M Breakout. Tags travel with each stock; Silent Activity and Top Signals both receive tags.

### Changed
- **Telegram report (BREAKING):** Now driven exclusively by momentum tiers (Full / Recovery / Watchlist). The legacy 3-path entry filter (Green / Pullback / SMA21) and the Silent Activity Watchlist section are no longer in Telegram output. Each stock block shows the full 8-criteria checklist (✓/✗), distance metrics (SMA21, ATH, days since ATH), and trend stack (Price vs SMA50, SMA50 vs SMA200, SMA200 slope). Stocks group by tier — Full appears before Watchlist regardless of RVOL.
- **JSON history retained:** `scan-YYYY-MM-DD.json` still records the legacy 3-path + silent set so existing backtest scripts (`evaluate-setups`, `evaluate-retro-advanced`) keep working.
- **TOP_N default:** 15 → 999 (effectively unlimited — momentum filter caps the report length organically).
- **Weekly report:** Now lists all signals (no tag filter).

### Added 
- **Signal results persistence & weekly setup evaluation:** Save scan results as artifacts, evaluate full setup (🎯) performance, send summary to Telegram on Sundays
- **Jules run-issues auto-fix:** When daily scan has invalid tickers or fetch failures, writes `.scan-issues.json` and invokes Jules to fix (extend TICKER_REGEX, improve fetch). Jules opens `fix/daily-scan-run-issues-*` PR; merge triggers re-run via existing verify-and-merge flow
- **Run issues in Telegram:** Invalid tickers and failed-fetch list appear at top of first message for visibility
- **Jules improvements:** `docs/standards-for-ci.md` — SSoT export for CI (derived from Maestro vault)
- **Jules improvements:** `agents.md` extended with Jules context (scopes, guardrails, forbidden patterns)
- **Jules improvements:** `jules-fix-on-failure.yml` prompt now references `docs/standards-for-ci.md`, asks for PR summary
- **Jules improvements:** `jules-pr-labels.yml` — auto-label PRs from `fix/daily-scan-*` and `chore/standards-*` with `jules`, `jules/fix-daily`, `jules/standards`
- **Maestro:** Jules agent routing (`03-agents/specialists/jules.md`, trigger matrix row 39)
- `docs/jules-scheduled-task-setup.md` — instructions for creating weekly standards sweep (manual)

### Changed
- **refactor:** Extracted setup criteria (`isFullSetup`, `isCloseSetup`) to `src/utils/setup.ts`
- **refactor:** Extracted RVOL/price formatters to `src/utils/formatters.ts` (config-aware)
- **refactor:** rvolCalculator, telegramBot, llmSummary, marketData use shared setup and formatter utilities

### Added
- **Jules auto-fix:** On daily scan failure, `jules-fix-on-failure.yml` invokes Jules to analyze, fix, version bump, and open a PR. Merge triggers re-run via `re-run-scan-after-fix.yml`
- `agents.md` — setup hints for Jules and other AI agents

### Changed
- **perf:** O(1) sector lookup via `Map` (was `tickers.find()` per signal)
- **refactor:** `loadIsraeliNames` → `getIsraeliNames` with lazy-init getter
- **refactor:** Split `formatDailyReport` into `formatFailedSection`, `formatReportHeader`, `formatSingleStockBlock`, `formatVolumeWithoutPriceSection`
- **refactor:** Extract `buildLlmSummaryMessage` from `sendDailyReport`

### Fixed
- **Standards:** `scripts/send-legend.ts` — replaced `console.log`/`console.error` with `logger` (was documented but not applied)

- **LLM:** Configurable model (`LLM_MODEL`); Gemini default to `gemini-2.0-flash` (was invalid `gemini-3-flash-preview`)
- **LLM:** Escape output in Telegram HTML (security)
- **Config:** NaN guards for numeric env vars (`parseFloatEnv`/`parseIntEnv`)

### Added
- `LLM_SIGNALS_ONLY` — analyze only main signal stocks when true
- CI: `npm audit --audit-level=high` step
- daily-scan: optional `GEMINI_API_KEY`, `TWELVE_DATA_API_KEY`, `ENABLE_LLM_SUMMARY`, `LLM_PROVIDER`
- Clearer LLM skip logs when API key missing

### Added (March 2026)

- Config: twelveDataApiKey, forceScan, debug (replacing direct process.env)
- API response types in marketData, newsService (typed Yahoo/Twelve Data responses)
- Twelve Data throttling: p-limit(2) for RSI/SMA fetches
- Telegram failure notification in daily-scan workflow
- Tests: technicalAnalysis, errorHandler, marketData
- Coverage threshold 55% in jest.config

### Removed

- Dead code: withRetry, safeJsonParse from errorHandler
- Dead type: ScanResults from types
- Unused config: batchSize, batchDelayMs, maxRetries, retryDelayMs

### Security

- **Input validation:** Ticker symbols validated with regex; invalid tickers skipped with warning
- **URL encoding:** `encodeURIComponent()` for all tickers and Google Sheet ID in URLs
- **XSS prevention:** `escapeHtml()` for sector, headline, source, URL in Telegram HTML; only https URLs in news links
- **Google Sheet ID:** Format validation (20–60 alphanumeric/dash/underscore) before fetch
- **Dependencies:** Removed 3 vulnerabilities via `npm audit fix`; removed unused `yahoo-finance2`, `rss-parser`

### Added

- `.env.example` — template for all env vars
- `.github/workflows/ci.yml` — lint, build, test on push/PR
- `src/utils/escapeHtml.ts` — HTML entity escaping for Telegram
- `validateTicker()` and `validateGoogleSheetId()` in config
- Test: invalid ticker skip, invalid sheet ID format
- `concurrency` and `timeout-minutes` in daily-scan workflow
- Build step: copy `israeliNames.json` to `dist/config/`

### Changed

- `marketData`, `newsService`, `telegramBot` — explicit types, null-safety, Boolean() for setup predicates; lint 0 warnings
- `scripts/send-legend.ts` — uses `logger` instead of `console.log`
- `newsService` — cache `israeliNames.json` in memory (no per-stock file read)
- `package.json` — build copies JSON to dist
