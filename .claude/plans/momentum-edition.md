# Plan: Smart Volume Radar — Momentum Edition (revised, post-discovery)

## Context
Add a **Stage 2 Momentum Breakout** scoring layer to the scanner (Intel / AMKR / MXL pattern). The existing tag system (SMA21 Touch / Pullback 15% / 1M Breakout) and entry-path system (green / pullback / sma21) keep working unchanged — momentum is an **additive orthogonal scoring layer**. Telegram and stored results are extended, not replaced.

**Project root:** `~/smart-volume-radar-engine`

## Discovery findings that shaped this plan
- `setup.ts` did not previously exist — we are creating it.
- `StockData` already has `sma50`, `sma200`, `ath`, `pctFromAth`, `monthsInConsolidation`. Phase 1 only adds the gaps.
- `fetchYahooChartAsOfDate()` already provides historical replay → backtest harness wraps it.
- `package.json` has 3 duplicate `replay-march-9-14` script keys (broken JSON-style duplicates) — fix opportunistically.
- Tests use `ts-jest` ESM, `tests/*.test.ts`, import from `../src/...js`.

---

## Tasks

### Phase 1: Types & New Indicators (foundation)

- [ ] **1.1 — Extend `StockData`** in `src/types/index.ts`:
  - `sma200Slope?: 'up' | 'flat' | 'down'`
  - `consecutiveGreenDays?: number`
  - `gapDay?: { date: string; level: number } | null`
  - `avwapFromGap?: number`
  - `projectedRvol?: number`
  - `daysSinceAth?: number` (already implied by `monthsInConsolidation * 21` — store explicitly)
  - `avgDailyVolume?: number` (rename clarity; reuse existing `avgVolume`)
  - `marketRegime?: 'bull' | 'bear'` (set on each stock for downstream simplicity)
  Verify: `npx tsc --noEmit` passes; existing consumers unaffected (all new fields optional).

- [ ] **1.2 — New helpers** in `src/utils/technicalAnalysis.ts`:
  - `calculateSMA200Slope(closes: number[]): 'up' | 'flat' | 'down' | undefined` — linear regression slope of last 20 SMA200 values; thresholds ±0.05% per bar.
  - `countConsecutiveGreenDays(closes: number[], window: number): number` — green = `close[i] > close[i-1]`.
  - `detectEarningsGap(opens: number[], highs: number[], dates: string[], lookback: number): { date, level } | null` — gap = `open[i] > high[i-1]` with `(open-prevHigh)/prevHigh ≥ 3%`.
  - `calculateAVWAP(highs, lows, closes, volumes, anchorIndex): number` — running ∑(typicalPrice·vol)/∑vol from anchor.
  Verify: dedicated unit tests in `tests/technicalAnalysis.test.ts`; known-input fixtures.

- [ ] **1.3 — Time-weighted intraday RVOL** in `src/services/rvolCalculator.ts`:
  Add pure helper `projectedRvol(currentVolume, avg63DayVolume, minutesElapsed): number`.
  ```
  minutesElapsed = clamp(minutesSinceNyseOpen, 1, 390)
  projected      = currentVolume / (minutesElapsed / 390)
  return         = projected / avg63DayVolume
  ```
  After-close (≥390 min): `projectedRvol === rvol`. Add `marketSessionMinutesElapsed(now: Date): number` (NYSE 09:30–16:00 ET, weekend → 390).
  Verify: Jest tests — at 30 min in, vol=1M, avg=10M → 1.30; at 390 min → equals raw RVOL.

- [ ] **1.4 — Wire `projectedRvol` into `parseYahooChartResult`** in `src/services/marketData.ts`. Compute `consecutiveGreenDays`, `sma200Slope`, `gapDay`, `avwapFromGap` (anchored to `gapDay.date`) and attach to returned `StockData`. Leave existing `rvol`/`tags`/etc. untouched.
  Verify: dry-run `tsx -e` that fetches AAPL and prints the new fields populated.

- [ ] **1.5 — Low-liquidity filter** in `src/services/marketData.ts` (post-parse): if `avgVolume < MIN_AVG_DAILY_VOLUME` (env, default 100_000), drop with `logger.warn`. Add to config in `src/config/index.ts`.
  Verify: unit test mocks two stocks (50k, 150k avg vol) → only 150k survives.

- [ ] **1.6 — Data freshness guard** in `src/services/marketData.ts::fetchYahooChartAsOfDate` (and live fetch): if last bar date is more than 1 trading day before expected date, log warn and return `null`. **Skip this guard when `process.env.BACKTEST_MODE === '1'`** — replay scripts intentionally use historical dates.
  Verify: stub Yahoo response with stale bar → ticker dropped in production mode; preserved in backtest mode.

- [ ] **1.7 — SPY market regime** in `src/services/marketData.ts`:
  - `fetchMarketRegime(asOfDate?: string): Promise<'bull' | 'bear'>` — fetches SPY chart, returns `'bear'` when last close < SMA200, else `'bull'`.
  - In `index.ts`, call once per scan; pipe into each stock as `marketRegime`.
  Verify: integration test — stub SPY below SMA200 → all stocks have `marketRegime = 'bear'`.

### Phase 2: Setup Brain — `src/utils/setup.ts` (NEW FILE)

- [ ] **2.1 — Create `src/utils/setup.ts`** exporting:
  ```ts
  export type MomentumLevel = 'full' | 'close' | 'none';
  export interface MomentumCriteria {
    rvolPass: boolean;          // projectedRvol >= threshold (regime-aware)
    stage2: boolean;            // price>SMA50 && SMA50>SMA200 && slope!='down'
    lowRiskEntry: boolean;      // dist(price, SMA21) <= 8%
    pivotBreakout: boolean;     // price >= ath * 0.98
    tightness: boolean;         // daysSinceAth >= 15
    aboveGapAvwap: boolean;     // no gap, OR price >= avwapFromGap
    antsAccumulation: boolean;  // ≥12 green days in last 15
  }
  export interface MomentumResult {
    level: MomentumLevel;
    criteria: MomentumCriteria;
    failures: Array<keyof MomentumCriteria>;
  }
  export function evaluateMomentumSetup(s: StockData, opts?: { regime?: 'bull'|'bear' }): MomentumResult;
  ```
  - Full = all 5 main criteria + `aboveGapAvwap` true. RVOL threshold = 2.0 in bull, 3.0 in bear.
  - Close = `projectedRvol >= 1.5 && (pivotBreakout || lowRiskEntry)`.
  - `failures` lists which criteria blocked Full (for debug + Telegram tooltip).
  Verify: pure function, no I/O — directly testable.

- [ ] **2.2 — Wire `evaluateMomentumSetup` into the pipeline** in `src/index.ts`:
  - After `calculateRVOL`, run `evaluateMomentumSetup` on every stock that made `topSignals` OR `volumeWithoutPrice`.
  - Attach result as `momentum?: MomentumResult` on `StockData` (extend type in 1.1).
  Verify: dry-run scan — `topSignals[0].momentum` is populated.

### Phase 3: Reporting

- [ ] **3.1 — Telegram block enhancement** in `src/services/telegramBot.ts::formatSingleStockBlock`:
  Add a single line **above** the existing entry-path label:
  ```
  🎯 <b>FULL MOMENTUM</b>     (when momentum.level === 'full')
  👀 <b>MOMENTUM WATCHLIST</b> (when momentum.level === 'close')
  ```
  Hide line when `level === 'none'`. Existing tag/path output unchanged.
  Verify: snapshot test in `tests/telegramFormatter.test.ts` for one Full and one Close fixture.

- [ ] **3.2 — Header regime badge** in `formatReportHeader`: append `🐂 Bull` or `🐻 Bear` based on `marketRegime`.
  Verify: snapshot test.

- [ ] **3.3 — LLM prompt update** in `src/services/llmSummary.ts::SYSTEM_PROMPT`: add Stage 2 / VCP / AVWAP vocabulary so summaries reference momentum tags. Keep one-sentence Hebrew rule. Keep `formatStockForLlm` extension to include momentum level if present.
  Verify: dry-run produces sentences referencing actual momentum tags, not generic.

- [ ] **3.4 — Persist momentum in stored results** in `src/utils/writeScanResults.ts` and `src/types/index.ts::StoredSignal`:
  - Add optional `momentumLevel?: 'full' | 'close'` (omit when 'none').
  - Existing `source` field stays.
  Verify: scan-YYYY-MM-DD.json contains `momentumLevel` for stocks that scored.

### Phase 4: Tests (Jest)

Add `tests/setup.test.ts`:
- [ ] **4.1 — Intel scenario:** price=52, ath=51.5, projectedRvol=3.0, sma50>sma200 with slope='up', distFromSMA21=4%, daysSinceAth=22 → `level === 'full'`, no failures.
- [ ] **4.2 — Overextended:** distFromSMA21=15% (everything else perfect) → `level === 'close'` (RVOL+pivot still pass), `failures` includes `'lowRiskEntry'`.
- [ ] **4.3 — Fake breakout:** projectedRvol=0.8 (everything else perfect) → `level === 'none'`, `failures` includes `'rvolPass'`.
- [ ] **4.4 — Bear regime:** projectedRvol=2.5, SPY regime=bear → `level !== 'full'` (threshold 3.0); same with regime=bull → `level === 'full'`.
- [ ] **4.5 — Ants:** 13 green days in 15, projectedRvol=1.3 → `criteria.antsAccumulation === true` (independent flag, doesn't make Full).
- [ ] **4.6 — Below gap AVWAP:** gapDay set, lastPrice < avwapFromGap → `criteria.aboveGapAvwap === false`, `level !== 'full'` even when other 5 pass.
- [ ] **4.7 — Stale data:** `fetchYahooChartAsOfDate` returns ticker with last bar date 5 days stale → `null` (production mode).

Add **known-winners regression** in `tests/setup.intel.fixture.test.ts`:
- [ ] **4.8 — Real INTC fixture:** load `tests/fixtures/intc-2024-08-26.json` (real Yahoo response, asOf=breakout date) → `evaluateMomentumSetup` returns `level === 'full'`. Same for AMKR + MXL on their respective breakout dates.
  *(I will fetch and commit these fixtures as part of this task — one HTTP call each, archived as JSON so tests are deterministic.)*

Verify all: `npm run test` green; coverage on `setup.ts` ≥ 90%.

### Phase 5: Backtest Harness

- [ ] **5.1 — `scripts/backtest-momentum.ts`** (NEW):
  Two modes via `--mode` flag:
  - `winners` — reads `tests/fixtures/momentum-winners.json` (`[{ticker, breakoutDate, expectedLevel}]`), runs `fetchYahooChartAsOfDate` + `evaluateMomentumSetup`, reports hit/miss table.
  - `walk-forward` — for each trading day in last N days (default 90), replay watchlist via `fetchYahooChartAsOfDate`, find Full Setups, then for each look forward 10 and 20 trading days via Yahoo and compute `(priceFwd - priceThen) / priceThen`. Output: count, hit-rate (%>0), median return, max drawdown.
  Add `BACKTEST_MODE=1` env so freshness guard (1.6) is bypassed.
  Verify: `BACKTEST_MODE=1 npx tsx scripts/backtest-momentum.ts --mode winners` prints a table.

- [ ] **5.2 — Add `npm run backtest-momentum` and `backtest-momentum-walkforward` to `package.json`** (and clean up the duplicate `replay-march-9-14` keys while editing).
  Verify: `npm run backtest-momentum -- --mode winners` works.

### Phase 6: Verification (always last)

- [ ] **6.1 — Type check:** `npx tsc --noEmit` — zero errors.
- [ ] **6.2 — Full Jest:** `npm run test` — all green, coverage maintained.
- [ ] **6.3 — Lint:** `npm run lint` — no new warnings on touched files.
- [ ] **6.4 — Dry-run scan:** `FORCE_SCAN=true npm run start` against today's watchlist with Telegram disabled (or test chat). Inspect 3 outputs:
  - One Full Momentum ticker — verify all 5 criteria actually met.
  - One Momentum Watchlist — verify exactly the close conditions.
  - One non-momentum signal — verify badge absent.
- [ ] **6.5 — Telegram smoke test:** send to a non-prod chat. Confirm `🎯 FULL MOMENTUM` / `👀 MOMENTUM WATCHLIST` badge renders, regime badge in header, no escaping issues, existing entry-path tags still present.
- [ ] **6.6 — Winners backtest:** `npm run backtest-momentum -- --mode winners` — INTC, AMKR, MXL all return `level === 'full'` on their breakout dates.
- [ ] **6.7 — Walk-forward backtest (the real validator):** `npm run backtest-momentum -- --mode walk-forward` over the last 90 days. Decision gate:
  - Hit-rate (10-day fwd return > 0) **≥ 55%** → ship.
  - 50–55% → ship but flag thresholds for tuning.
  - **< 50%** → STOP. Revisit thresholds (RVOL, distFromSMA21, daysSinceAth) before merging.

---

## Out of Scope
- Real-time WebSocket streaming.
- Position sizing / risk per trade.
- Sector RS ranking beyond static map.
- Replacing the existing entry-path/tag system.

## Rollback
Each phase commits independently. Setup is additive — to revert behavior: remove the `momentum` field consumption from `telegramBot.ts` and `writeScanResults.ts`. Pipeline keeps working.

## Execution rhythm
After each phase I will:
1. Report what changed (files + key diffs).
2. Run the verification step listed for that phase.
3. Wait for your "next" before starting the following phase, unless you say "go all the way".
