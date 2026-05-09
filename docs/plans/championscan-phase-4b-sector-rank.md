# Plan: ChampionScan Phase 4B — Dynamic Sector Rank

## Context

Currently sectors are static labels from the Google Sheet. ChampionScan
shows live sector rank with rolling returns ("#1 Semiconductors +42%").
Goal: rank sectors by median 21d/63d return across the watchlist, surface
the rank in the per-stock block, give a small score boost for stocks in
top-3 sectors. No new API — uses existing `return63d` already populated.

## Tasks

### Phase 1: Sector ranking utility (`src/utils/sectorRank.ts`)
- 🟩 Pure function `computeSectorRanks(stocks)` returns `Map<sector, { rank, count, median63d, median21d }>`. Groups by `stock.sector`, computes median `return63d` per sector with ≥3 stocks, ranks descending. — **Verify:** unit tests on synthetic 3-sector fixture: top sector gets rank 1, sectors with <3 stocks excluded.
- 🟩 Compute `return21d` in `parseYahooChartResult` (we have `return63d`; add a sibling for the 1-month window). — **Verify:** dry-run fetch shows `stock.return21d` populated.

### Phase 2: Wire into pipeline
- 🟩 In `src/index.ts` after `applyRSPercentile`: call `computeSectorRanks(stocks)` once. Mutate each stock with `sectorRank?: number`, `sectorMedianReturn63d?: number`, `sectorTotalCount?: number`. Log top-5 sectors. — **Verify:** scan log shows "🏭 Top sectors: Semiconductor #1 +18.3% (n=34) | AI - Chain #2 +12.1% (n=12) | ...".
- 🟩 Add 3 new fields to `StockData` types. — **Verify:** `tsc --noEmit` clean.

### Phase 3: Champion Score v4 + Telegram render
- 🟩 Add weight: `+5` when `sectorRank ≤ 3` AND `sectorTotalCount ≥ 5` (avoid tiny sectors gaming the bonus). — **Verify:** unit test in `tests/championScore.test.ts`.
- 🟩 Telegram per-stock block: replace plain `(Semiconductor)` with `(Semiconductor #1 +18%)`. Header gets a "Top sectors today" line listing top 3. — **Verify:** preview-report shows new format for fixture stocks; snapshot test passes.

### Phase X: Verification (always last)
- 🟩 `npm test` passes (target ≥280 tests).
- 🟩 `npx tsc --noEmit` clean.
- 🟩 `npm run lint` zero new errors.
- 🟩 Local scan dry-run shows ≥3 ranked sectors.
- 🟩 Commit + push to `main`, CI green.

## Dependencies

```
Phase 1 → Phase 2 → Phase 3 → Phase X
```

## Out of scope
- Sector ETF integration (XLK / XLF / etc.) — premature; aggregate-of-watchlist works.
- Rotation alerts (sector moving up/down ranks week-over-week) — separate feature.
- Industry-group level (sub-sector) ranking — same logic but more granular, defer.
