# Lean Radar Dashboard — Design (Cloudflare Pages + D1)

**Date:** 2026-06-30
**Status:** Awaiting user review of this spec.
**Builds on:** the Lean Radar (`stable` branch, `npm run start:lean`) and the
existing per-day signal data (`results/lean-{date}.json` + the reconstruction
script `scripts/reconstruct-lean.ts`).

## Goal

Replace the overwhelming 140-names/day Telegram text report as the *primary
surface* with an interactive web dashboard that shows **all** Lean Radar signals
in a sortable / filterable / searchable way. The Telegram push degrades to a thin
pointer ("today: N high-conviction, M total → link"). No signals are dropped —
the dashboard holds everything; the user controls focus by sorting/filtering.

Motivation: the pain was never "too many stocks" — it was the *medium*. A linear
Telegram feed is terrible for 140 rows; the same rows in a sortable table are
easy. A per-signal **quality score** (see Scoring) becomes a sortable column, so
the filtering-threshold debate dissolves into "where you stop scrolling."

## Scope

In scope (v1):
1. **D1 table** `lean_signals` — one row per (scan_date, ticker), all derived fields.
2. **Daily ingestion** — a GitHub Actions step writes the day's rows to D1 after the
   lean scan, via the D1 REST API (idempotent `INSERT OR REPLACE`).
3. **Seed** — backfill the 20 reconstructed trading days so history exists from day 1.
4. **Cloudflare Pages** app: a Pages Function API reading D1 + a static front-end.
5. **Four views:** sortable/filter/search table · daily summary cards · Score/RVOL
   distribution chart · click-to-deep-dive side panel (details + TradingView link).
6. **Access control:** Cloudflare Access (email allowlist) — private to Kobi + friend.
7. **RTL** Hebrew UI.

Out of scope (future): live intraday updates (daily batch only); embedding the
`radar-deep-dive` skill output in-panel (v1 links to TradingView only); the Smart
Radar (main branch) signals; mobile-native app; alerting/notifications from the
dashboard itself; editing/annotating signals.

## Architecture

```
GitHub Actions  (daily-scan-lean.yml, stable)
   └─ npm run start:lean            → results/lean-{date}.json (unchanged)
   └─ NEW step: ingest-to-d1        → POST rows to D1 REST API (INSERT OR REPLACE)
                                          │
                                          ▼
                                   Cloudflare D1  (lean_signals)
                                          ▲  seed once from reconstruct-lean.ts output
                                          │
Cloudflare Pages
   ├─ functions/api/signals.ts      → SELECT … FROM lean_signals WHERE scan_date BETWEEN ?
   ├─ functions/api/summary.ts      → per-day aggregate counts
   └─ static/  (index.html + app.js + chart) — table · cards · chart · deep-dive
                                          ▲
                                   Cloudflare Access (email allowlist)
```

Decoupled units, each independently testable:
- **Ingestion** (`scripts/ingest-d1.ts`): reads a `lean-{date}.json` snapshot, maps to
  rows, computes `score`, POSTs to D1. Pure data; no UI. Reused by the seed (loops over
  reconstructed days) and by the daily GHA step (single latest day).
- **API** (Pages Functions): thin SQL → JSON. No business logic beyond querying.
- **Front-end** (`static/`): renders JSON. No data computation except client-side
  sort/filter (cheap; ~140 rows/day, a few thousand over the window).

## Data model (D1)

```sql
CREATE TABLE lean_signals (
  scan_date   TEXT NOT NULL,          -- 'YYYY-MM-DD'
  ticker      TEXT NOT NULL,
  region      TEXT,                   -- US | TASE | Foreign
  sector      TEXT,
  signal      TEXT NOT NULL,          -- breakout|highVolume|pullback|nearBreakout|nearHighVol|nearPullback
  rvol        REAL,
  ath_pct     REAL,                   -- % from all-time high (negative)
  day_pct     REAL,                   -- bar gain %
  stage2      INTEGER,                -- 0/1 (price>sma50>sma200)
  dist_pivot  REAL,                   -- % below pivot (null unless near/at breakout)
  score       INTEGER,                -- confluence score (see Scoring)
  price       REAL,
  PRIMARY KEY (scan_date, ticker)
);
CREATE INDEX idx_lean_date  ON lean_signals(scan_date);
CREATE INDEX idx_lean_score ON lean_signals(score);
```

Volume: ~140 rows/day; ~35k rows/year — trivial for D1.

## Scoring (documented — the dashboard surfaces it, it is not a hard filter)

```
base   = {breakout:50, pullback:40, highVolume:35, nearBreakout:25, nearHighVol:15, nearPullback:10}[signal]
score  = base
       + min(rvol, 6) * 5                    # volume, up to +30
       + (stage2 ? 20 : 0)                    # trend health (price>sma50>sma200)
       + (dist_pivot != null ? max(0, 10 - dist_pivot*4) : 0)   # proximity to pivot
       - (signal=='highVolume' && day_pct<0 ? 25 : 0)           # climax/distribution penalty
       - (ath_pct < -30 ? 20 : 0)                               # broken-trend penalty
       - (isETF(sector) ? 12 : 0)                               # de-prioritize ETFs
```
Rationale established during the 20-day backtest: trend-health gates and a
climax penalty stop a high-RVOL down-day (e.g. RENK.VI 12x at −52% from ATH)
from topping a purely additive ranking. Score is a **column**, not a cutoff.

## Views (v1)

1. **Signals table** — columns: Date, Ticker, Region, Sector, Signal, RVOL, ATH%,
   Day%, Stage2, DistPivot%, Score, Price. Sort any column; filter by
   Region/Signal/Stage2; free-text ticker search; conditional color on Score & RVOL.
   Default sort: latest date, Score desc.
2. **Daily summary cards** — per selected day: Total, Breakout, HighVol, Pullback,
   Near, and count at Score≥70 / ≥65. Quick "how strong was today" read.
3. **Distribution chart** — Score histogram + RVOL histogram (Chart.js) for the
   selected day/range; spotlights breakout-cluster days.
4. **Deep-dive panel** — click a row → side panel with the ticker's full fields +
   a TradingView link. (Future: inline `radar-deep-dive` thesis.)

## Telegram integration (thin pointer)

The lean report formatter (`src/lean/format.ts`) is **not** removed in v1, but the
GHA job additionally sends a one-line summary with the dashboard link. Deciding
whether to fully replace the long report is deferred until the dashboard has been
lived-in (avoids losing the push entirely before the dashboard is trusted).

## Decisions (defaults — confirm during review)

1. **Access:** Cloudflare Access, email allowlist (Kobi + friend). Free, secure,
   no app-level auth code.
2. **Ingestion auth:** a Cloudflare API token scoped to D1, stored in GHA secrets
   (`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `D1_DATABASE_ID`). Kobi creates the token.
3. **Repo location:** new `dashboard/` workspace in the radar repo (Cloudflare Pages
   project), so ingestion + schema live next to the radar code that produces the data.

## Rollout

1. Create D1 DB + apply schema.
2. Build `scripts/ingest-d1.ts`; seed from `reconstruct-lean.ts` 20-day output.
3. Build Pages app (API + static views); wire Cloudflare Access.
4. Add the ingestion step to `daily-scan-lean.yml`; add the thin Telegram pointer.
5. Live with it; later decide whether to trim the full Telegram report.

## Testing

- **Ingestion:** unit test the snapshot→rows mapping + score; integration test a
  dry-run against a local/preview D1 (`wrangler d1 execute --local`).
- **API:** test query params (date range, empty range) return correct JSON shapes.
- **Front-end:** sort/filter/search behavior on a fixture dataset; chart renders.
- **Idempotency:** re-running ingestion for the same date does not duplicate rows.
