# SVR Backtest — Proposal A (Climax sell/avoid) & Proposal B (Industry-group gate)

**Date:** 2026-06-14
**Analyst:** radar-criteria-tester
**Data:** `results/monitor-list.json` — 365 alerts, firstAlertDate **2026-01-05 → 2026-06-01**
**Method:** for each alert, refetch Yahoo daily history, slice as-of `firstAlertDate`, recompute
indicators at that moment, measure fixed-window forward returns (+10td / +20td, index-based on each
ticker's own series). Yahoo paced at 5 concurrent. Scripts: `scripts/tmp-climax-backtest.ts`,
`scripts/tmp-industry-gate.ts`, `scripts/tmp-fetch-industries.ts`. CSVs in `results/tmp-*.csv`.

## ⚠️ Universal caveat — bull regime
The entire alert window is **90% bull** (SPY ≥ SMA200 on 47 of 52 trading days in 2026; only 5 bear
days). Climax/exhaustion signals are precisely the signals most likely to **flip sign in a bear/
distribution regime**. Every verdict below is conditional on bull conditions and is NOT validated for
a correction. Sample is also date-skewed: 281/365 alerts fired in Jan 2026.

---

## Proposal A — CLIMAX SELL/AVOID flag (Phase 9) — **REJECT**

### Rule tested (as specified)
Flag fires when **≥2 of 3** true, computed as-of `firstAlertDate`:
1. `lastPrice > 1.25 × (lowest close over prior 40 bars)` — base extension
2. `lastPrice / sma21 > 1.5` — extension above the 21-day SMA
3. `priceChange ≥ 3%` **AND** `pctFromAth > −5%` — big up-day near highs

### Result: the flag identifies OUTPERFORMERS, not losers
A climax/exhaustion flag is supposed to mark alerts that **underperform** (so you'd sell/avoid them).
It does the exact opposite. (n = analyzed 364/365.)

| Cohort | +10td median | +10td hit | +20td median | +20td hit | resolved median | resolved hit |
|---|---:|---:|---:|---:|---:|---:|
| **Climax-flagged** (n≈62) | **+5.0%** | **74%** | **+5.7%** | **60%** | **+5.1%** | **80%** |
| Non-flagged (n≈301) | −0.0% | 50% | +0.8% | 53% | +1.3% | 59% |
| All (n≈363) | +1.0% | 54% | +1.3% | 54% | +2.1% | 62% |

The flagged cohort beats non-flagged by **+4.9pp median / +24pp hit at +10td** and **+4.9pp / +7pp at
+20td**. As a *sell* signal it is sharply anti-predictive; as a *buy/strength* signal it is one of the
better flags in the dataset.

### Condition-count gradient is monotonic UP (+20td)
| Conditions met | n | median | hit |
|---|---:|---:|---:|
| 0 | 229 | +0.7% | 53% |
| 1 | 71 | +1.3% | 54% |
| 2 | 60 | **+5.7%** | 60% |
| 3 | 0 | — | — |

More climax conditions → **higher** forward return. The opposite of exhaustion.

### Why — design flaws + wrong thesis
- **Condition c2 (`price/sma21 > 1.5`) never fires** (n=0 across all 364 alerts). A 50% extension above
  SMA21 simply doesn't occur in this momentum-watchlist universe, so the flag can only reach "2 of 3"
  via c1+c3. Bucketed extension is itself **bullish, not bearish**: `<1.10` → +0.9% (n=290);
  `1.20–1.35` → +5.1% (n=19, 68% hit); `≥1.35` → +27.6% (n=3, 100% hit). Extension above SMA21 is a
  strength gradient here, not an exhaustion gradient.
- **c1 alone** (price > 1.25× base low): TRUE +4.9% (n=95) vs FALSE +0.5% (n=265) → pure momentum.
- **c3 alone** (big move near ATH): TRUE +1.7% vs FALSE +1.2% → barely separating.
- The thesis that "extended = exhausted = sell" does not hold in a bull regime for breakout alerts.
  Strength begets strength on these horizons (≤20td).

### Overlap with existing exhaustion proxies (the NEW-signal question)
Existing code already treats **RVOL≥10** as exhaustion (TD-25 — doesn't earn the quality dial) and
demotes on **distributionDays≥4** (TD-13). distributionDays recomputed with the *exact* production
logic (`countAccumulationDistributionDays`, 20-bar avg-volume threshold).

| Proxy | n | +20td median | hit |
|---|---:|---:|---:|
| RVOL≥10 (TD-25) | 3 | +2.3% | 67% |
| distributionDays≥4 (TD-13) | 219 | +0.7% | 53% |
| climax-flagged | 62 | +5.7% | 60% |

Of the 62 climax-flagged alerts, 19 are also caught by an existing proxy and **43 are NEW**
(climax-only, missed today). That NEW cohort is the **strongest** group in the whole study:
**+7.8% median / +8.1% mean / 65% hit at +20td** vs +0.8% for all non-flagged. So the flag does add
new signal beyond TD-25/TD-13 — but the new signal is *bullish*, confirming it must not be wired as a
sell/avoid filter.

### Where a real negative cohort lives: sector, not climax
The only genuinely bad slice inside the flagged set is **Aerospace & Defense** (flagged A&D: −6.4%
median, 36% hit, n=11) and **real estate** (−5.8%, 25% hit, n=4). That is the **existing A&D sector
gate** re-surfacing, not a climax effect. Semiconductors (+9.8%, n=26) and AI-Chain (+11.3%, 100%, n=4)
dominate the flagged cohort and are strongly positive.

### Verdict — A: **REJECT** as a sell/avoid filter
Do **not** ship a climax SELL/AVOID flag. As defined it is anti-predictive of underperformance (it
flags winners). Three numbers that justify it:
1. Climax-flagged +20td median **+5.7% vs +0.8%** non-flagged (it picks winners).
2. +10td hit-rate **74% vs 50%**.
3. NEW climax-only cohort (43 alerts) **+7.8% median / 65% hit** — strongest in the study.

**If you want to use this signal at all**, invert the framing: the c1 "price > 1.25× base-low" +
extension construct is a viable **strength/continuation tag** (info-only, never a gate), behaving like
the known dominant `pivotBreakout`. **Recommended production rule (optional, info-only):**
```
strengthTag = (lastPrice > 1.25 * baseLow40) && (lastPrice/sma21 > 1.15)
// display-only "🚀 Extended-leader"; do NOT gate, do NOT sell on it.
```
A true exhaustion/sell signal is **not testable in this dataset** — it would require bear-regime data,
which is 5 trading days here. Revisit after the next correction.

---

## Proposal B — INDUSTRY-GROUP gate (Phase 7) — **REJECT** (sector gate wins; data dependency fails)

### Rule tested
Replace/augment the broad **SECTOR** gate (TD-10: PASS if `sectorMedianReturn63d < 0`) with a finer
**finnhubIndustry** gate: PASS the alert if its industry-group median 63d return < 0. finnhubIndustry
fetched via Finnhub `/stock/profile2` (cached → `results/tmp-industry-map.json`).

### Data dependency is the headline finding
- **finnhubIndustry resolves for US tickers only.** 213/365 monitor tickers are US; the other **152
  (42%, mostly `.TA` Tel Aviv)** return `"You don't have access to this resource."` on this Finnhub
  plan tier. An industry-only gate would leave **42% of alerts ungated**.
- Finnhub free tier is **60 req/min** — required a paced fetcher (`tmp-fetch-industries.ts`) with
  retry; resolved 201/365 tickers (all US minus ~12 ETFs/no-industry).
- Comparison run on the **US-with-industry subset, n=197**, so both gates are scored on the same
  population.

### Methodology caveat (read before trusting the medians)
Production computes the group median over the **full daily watchlist universe**, which is **not
persisted** — saved `scan-*.json` only contains fired signals, not the universe + per-ticker
return63d. So group medians here are reconstructed from the **alert cohort** (alerts within a ±10-day
window), not the true universe. Results are **directional**, not an exact production replay.

### Result — sector gate isolates losers cleanly; industry gate does not (+20td)
| Variant | survivors n | survivor median | survivor hit | blocked n | **blocked median** | blocked hit |
|---|---:|---:|---:|---:|---:|---:|
| No gate | 197 | +3.5% | 58% | — | — | — |
| **SECTOR gate (TD-10)** | 159 | +4.5% | 63% | 38 | **−9.1%** | 39% |
| INDUSTRY gate | 140 | +5.0% | 61% | 57 | **+0.7%** | 51% |
| Both gates | 128 | +5.0% | 63% | — | — | — |

The whole point of a gate is that the **blocked** cohort should be the losers:
- **Sector gate blocks a −9.1% median / 39%-hit cohort** — genuine losers. Clean.
- **Industry gate blocks a +0.7% median / 51%-hit cohort** — essentially coin-flip. It discards ~50%
  winners while only marginally lifting survivors. At finer granularity, per-group samples shrink and
  the negative-median-63d signal becomes **noisy**.
- Combining both adds nothing over sector alone (+5.0% vs +4.5% survivor median, n drops 159→128).

### Verdict — B: **REJECT**
Do not replace or augment the sector gate with a finnhubIndustry gate. Three numbers:
1. Sector gate's blocked cohort **−9.1% median (39% hit)** vs industry gate's blocked cohort **+0.7%
   (51% hit)** — the finer gate fails to isolate losers.
2. Industry gate throws away more (57 blocked vs 38) for **no survivor-median lift** that beats the
   sector gate within noise.
3. finnhubIndustry covers **0/152 foreign alerts (42% of the book)** on this plan tier — the data
   dependency is unacceptable for a hard gate.

**Keep the current production rule unchanged:**
```
// TD-10 (championScore.ts ~L306): unchanged
if (stock.sectorMedianReturn63d != null && stock.sectorMedianReturn63d < 0) action = PASS;
```
If finer granularity is ever wanted, the cleaner lever is the **existing per-sector A&D evidence**
(A&D −6 to −10% median repeatedly) via the dynamic TD-15 blacklist — not a finnhubIndustry gate.

---

## Files
- Report: `outputs/2026-06-14-svr-climax-group-backtest.md`
- A data: `results/tmp-climax-backtest.csv` · script `scripts/tmp-climax-backtest.ts`
- B data: `results/tmp-industry-gate.csv`, `results/tmp-industry-map.json` ·
  scripts `scripts/tmp-industry-gate.ts`, `scripts/tmp-fetch-industries.ts`
- No production source files modified.
