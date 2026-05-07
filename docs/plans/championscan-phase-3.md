# Plan: ChampionScan Phase 3 — Fundamentals (Earnings Date + EPS/Rev Acceleration)

## Context

Phase 1+2 shipped technical layers. Phase 3 brings **fundamentals** — the
single biggest gap vs championscan.com and the biggest known driver of
institutional money. Two features from Finnhub (already integrated for news):

1. **Earnings date** — fetch the next earnings date per stock; warn when ≤7 days.
2. **EPS / Revenue acceleration** — quarter-over-quarter growth rate increasing.
   Accelerating fundamentals = the signature pattern of stocks before their
   biggest institutional moves (Minervini / IBD).

Both share the Finnhub API surface and same auth. Cached on disk to respect
the free-tier rate limit (60 calls/min, ~1k/day).

## Tasks

### Phase 1: Finnhub fundamentals service
- 🟩 Create `src/services/finnhubFundamentals.ts` exporting `fetchEarningsCalendar(ticker, fromDate, toDate)` and `fetchQuarterlyEarnings(ticker)`. Use existing `config.finnhubApiKey`. Wrap each call in try/catch returning `null` on failure (fail-soft). — **Verify:** unit test with mocked fetch returning Finnhub-shaped JSON; both functions parse correctly.
- 🟩 Add disk cache layer in same file: `getCachedEarnings(ticker)` reads `results/finnhub-cache/{ticker}.json` if present and < 7 days old; otherwise calls API and writes. — **Verify:** unit test stubs fs; second call within window does NOT call API.

### Phase 2: Type extensions + populate
- 🟩 Extend `StockData` types: `nextEarningsDate?: string`, `daysToEarnings?: number`, `epsAcceleration?: 'accelerating' | 'decelerating' | 'flat' | null`, `revAcceleration?: 'accelerating' | 'decelerating' | 'flat' | null`. — **Verify:** `npx tsc --noEmit` passes.
- 🟩 Add `enrichWithFundamentals(stocks)` function called from `index.ts` post-momentum, p-limit(3) for rate-limit safety. Caches per-ticker. — **Verify:** scan log shows `enriched ${n} stocks with fundamentals` and at least 5 have epsAcceleration populated.

### Phase 3: Acceleration computation logic
- 🟩 Pure helper `computeAcceleration(quarterly: Array<{actual, period}>): 'accelerating' | 'decelerating' | 'flat' | null`. Compares last two YoY growth rates (Q[t] vs Q[t-4], Q[t-1] vs Q[t-5]). 'accelerating' if latest > previous + 5%; 'decelerating' if latest < previous - 5%; 'flat' otherwise. — **Verify:** 4 unit tests covering each case + null when <5 quarters available.

### Phase 4: Champion Score v3 + Telegram
- 🟩 Add weights to `src/utils/championScore.ts`:
   - `epsAcceleration === 'accelerating'` → +5
   - `revAcceleration === 'accelerating'` → +3
   - `epsAcceleration === 'decelerating'` → -5
   - `daysToEarnings != null && daysToEarnings <= 7` → no score change but warning rendered.
   — **Verify:** new unit tests for each contributor.
- 🟩 Render in per-stock block:
   - `📅 Earnings in 3d ⚠️` line when daysToEarnings ≤ 7
   - `💰 EPS ▲ Acc | Rev ▲ Acc` line when at least one is set (▲=accelerating, ▼=decelerating, →=flat)
   — **Verify:** preview-report shows both lines for fixture stocks.

### Phase X: Verification (always last)
- 🟩 `npm test` passes (target: 245+ tests after Phase 3 additions).
- 🟩 `npm run lint` zero new errors.
- 🟩 `npx tsc --noEmit` clean.
- 🟩 Local dry-run touches Finnhub successfully (≥5 tickers populate fundamentals).
- 🟩 `.gitignore` excludes `results/finnhub-cache/` (we don't commit cache).
- 🟩 Commit + push, CI green.

## Dependencies

```
Phase 1 (service) ─┐
                   ├── Phase 2 (types + enrich) ── Phase 4 (score + Telegram) ── Phase X
Phase 3 (compute) ─┘
```

## Out of scope (Phase 4 candidates)

- Pattern detection (cup-handle, VCP, flat-base) — algorithmic, focused effort.
- Dynamic sector rank from sector ETFs.
- Portfolio tracker with P&L.

## Notes

- **Free-tier rate limit:** Finnhub free is 60 calls/min, ~1k/day. With 366
  watchlist tickers × 2 endpoints (earnings + fundamentals) = 732 calls per
  fresh-cache day. Cache TTL of 7 days means amortized ~105 calls/day. Safe.
- **API errors don't break the scan.** Every Finnhub call is wrapped in
  try/catch → `null`. The score gracefully ignores missing fields (no
  contribution rather than penalty).
- **Earnings warning is informational** — does NOT change the action label,
  just adds a warning line. (Could promote to a CAUTION action later.)
