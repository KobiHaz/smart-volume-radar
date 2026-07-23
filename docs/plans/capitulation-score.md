# Plan: Capitulation Score (מד המיצוי) — second dashboard gauge

**Overall Progress:** `~65%` (Phases 0-2 + engine tests complete; Phase 3 dashboard is a separate PR on `stable`)

## Context

PRD: `~/cabinet/projects/smart-volume-radar/PRD-capitulation-score.md` (read that first — this file
is the execution breakdown only; section 11 there has the full analysis this plan's Phase 0
produced).

Kobi's friend runs a separate 20-ticker Python dashboard (`Purple_Dashboard`) that plots two
graphs: our Fragility Score (top-detection, already shipped as PR #82) and a second metric,
the Capitulation Score (bottom-detection — "has selling exhausted?"). We ship only the first.
The friend's own backtest found this second metric **underperforms baseline as a timing
signal** (+1.5% vs +8.6% forward 20d return on high-score days) — his dashboard shows it as
descriptive-only, no color, no trigger.

**Phase 0 result (2026-07-23):** our own backtest on our 10-ticker basket shows the *opposite*
headline number (outperformance: capScore≥1.0 → +9.86% vs +4.93% baseline) — but split-half
stability testing shows that edge is markedly weaker in the more recent half (~1.5× baseline
lift in H2 vs ~4.6× in H1), and recall/precision against real troughs tops out at 35%/29% —
well below the Fragility rule's validated 94%/92%. **Net effect: same practical conclusion as
the friend's, reached independently** — this ships as a descriptive-only gauge, nothing more.
Full numbers in the PRD, section 11.

**Branch:** engine work on `main` (this repo); dashboard work on `stable` (separate PR,
blocked on the engine PR's D1 column).

**Non-goal, explicitly — now confirmed by our own data, not just inherited:** no
alert/Telegram trigger, no color-coded "buy" tied to this score, no basket composition
change, no change to the existing Fragility dual-tier rules. Phase 1 below is scoped strictly
to display — no threshold/action logic anywhere in the implementation.

---

## Agent staffing (HR)

| Agent | Vault path | Tasks covered |
|-------|------------|----------------|
| backend-specialist | `agent-library/specialists/backend-specialist.md` | T1–T6, T8 |
| test-engineer | `agent-library/specialists/test-engineer.md` | T7 |

**Note on staffing reality:** every prior phase of this project (Fragility Score model v1/v2,
PR #76–#82) was implemented directly in-session rather than via separate subagent
invocations — the table above satisfies the routing requirement, but in practice `/execute`
on this plan will most likely run as direct Claude Code work, same as everything before it.
No `cto`/SOLUTIONING task is staffed separately: the one real design risk (does this metric
transfer to our basket at all) is a data question, not an architecture question — it's
resolved by T0 (the backtest), not by a persona.

---

## Tasks

### Phase 0: Validate before building — *the actual risk in this plan* — ✅ COMPLETE
- [x] **0.1** 🟩 Build a throwaway `scripts/tmp-capitulation-validate.ts` that computes the
  4 raw components (depth, panic-volume, washout, negmom) on our existing 10-ticker aligned
  series, same pattern used for validating `climax` earlier in this project.
  - **Verify:** ✅ ran against live Yahoo data (1108 aligned days, 2022-01-27→2026-07-22),
    printed all 4 components + combined score without error.
- [x] **0.2** 🟩 Backtest: for days where the combined score is "high", compute forward
  20-trading-day index return, and compare to the basket's average day.
  - **Verify:** ✅ result: capScore≥1.0 → +9.86% fwd20 vs +4.93% baseline (opposite direction
    from the friend's +1.5% vs +8.6%) — but split-half testing (H1 ~4.6× lift vs H2 ~1.5×
    lift) and recall/precision (35%/29% best case, vs the friend's own conclusion) both point
    to the same practical answer: not stable/precise enough to act on. Full numbers in PRD §11.
- [x] **0.3** 🟩 Delete `scripts/tmp-capitulation-validate.ts` once findings are captured —
  same cleanup discipline as every other tmp script this project has used.
  - **Verify:** ✅ `git status` shows no `tmp-` script left behind (only the pre-existing,
    unrelated `scripts/tmp-miss-forensics.ts`).
- [x] **0.4** 🟩 Report the backtest result to Kobi before proceeding to Phase 1.
  - **Verify:** ✅ Kobi replied "כן" (yes) — proceeding to Phase 1.

### Phase 1: Engine — component computation (display-only, no thresholds/alerts anywhere) — ✅ COMPLETE
- [x] **1.1** 🟩 Add a rolling-max-of-trailing-N helper to `src/utils/statistics.ts`.
  - **Verify:** ✅ `rollingMax` added, 3 unit tests passing (window-fill, too-short, null-propagation).
- [x] **1.2** 🟩 Compute the 4 raw components in `buildFragilityDays` using the formula
  validated in Phase 0: depth (`-(indexValue/runningPeak − 1)`, z-scored), panic-volume (60d
  vol-z on >1%-down days, averaged across basket, 10d trailing max, z-scored), washout (%
  below own 20d MA, z-scored), negmom (trailing 20d index return, sign-flipped, z-scored).
  - **Verify:** ✅ implemented in `src/services/purpleFragility.ts`, reusing the same
    volMean60/volStd60 baseline as `climax`.
- [x] **1.3** 🟩 Named as `capitulation` (combined score) + `capitulationZ: CapitulationComponents
  { depth, panicVolume, washout, negMom }` — avoids the `climax` name collision.
  - **Verify:** ✅ `grep -rn "panicVolume\|capitulationZ\|CapitulationComponents" src/` shows only new code.
- [x] **1.4** 🟩 Exposed on `FragilityDay` (`capitulation: number | null`,
  `capitulationZ: CapitulationComponents`) with min-3-of-4 null contract.
  - **Verify:** ✅ `npx tsc --noEmit` clean.
- [x] **1.5** 🟩 Confirmed zero interaction with existing alert logic.
  - **Verify:** ✅ full `tests/purpleFragility.test.ts` suite (21 tests) passes unmodified;
    full `npm test` — 365/365 (was 362, +3 new `rollingMax` tests).

### Phase 2: D1 ingest — ✅ COMPLETE
- [x] **2.1** 🟩 Added `capitulation REAL` column via the same self-migrating
  `ALTER TABLE ... ADD COLUMN` pattern as `core3`/`climax`. **Scope decision:** only the
  combined score is stored, not the 4 sub-components — the dashboard only plots one line
  (FR5), and storing all 5 would've forced `ROWS_PER_INSERT` down further for no current use;
  easy to add later via another migration if research needs the breakdown.
  - **Verify:** ✅ `FRAGILITY_COL_COUNT` 14→15, `ROWS_PER_INSERT` 7→6 (15×6=90≤100).
- [x] **2.2** 🟩 Included in batch insert params, positioned right after `climax`.
  - **Verify:** ✅ `fragilityD1Ingest.test.ts` extended (8/8 passing, incl. the param-order test).

### Phase 3: Dashboard (stable branch, separate PR)
- [ ] **3.1** 🟥 Add the new field(s) to the API response in
  `dashboard/functions/api/fragility.ts`.
  - **Verify:** `curl` against a local/preview deploy shows the new field(s) in the JSON.
- [ ] **3.2** 🟥 Add a second Chart.js line/graph in `dashboard/public/app.js`, explicitly
  labeled descriptive-only (no color-coding as a buy/action signal, per FR5/Non-Goals).
  - **Verify:** manual check in browser — second line renders, legend/label matches the
    "descriptive only" framing.
- [ ] **3.3** 🟥 Update the dashboard explainer tab (same pattern as PR #79's fragility
  explainer) to describe the Capitulation Score's 4 components and state plainly: this is
  descriptive only, our own validation found ~35% recall / ~29% precision against real
  troughs and an edge that weakens in more recent data — not the friend's "+1.5% vs +8.6%"
  number, which ran on a different basket.
  - **Verify:** explainer text present, matches PRD §11's actual numbers, not a generic
    "no trigger" disclaimer and not the friend's numbers.

### Phase 4: Tests
- [x] **4.1** 🟩 Engine unit tests for the 4 components + combined score, mirroring
  `tests/purpleFragility.test.ts` conventions — 5 new tests: min-3-of-4 gate, panicVolume's
  down-day gating (near/far comparison, same pattern as the `climax` near-high test),
  washout/negMom/depth directional correctness under a synthetic decline.
  - **Verify:** ✅ 26/26 in `purpleFragility.test.ts` (was 21).
- [x] **4.2** 🟩 D1 ingest tests extended for the `capitulation` column.
  - **Verify:** ✅ 8/8 in `fragilityD1Ingest.test.ts`.
- [ ] **4.3** 🟥 Dashboard tests extended for the new field(s) — **Phase 3 scope, not this PR.**

### Phase X: Final verification (engine half — this PR) — ✅ COMPLETE
- [x] `npx tsc --noEmit` clean
- [x] `npm run lint` clean
- [x] `npm test` — 370/370 passing (was 362 at the start of this plan)
- [x] Manual preview: `scripts/preview-fragility.ts` — capitulation score renders correctly
  in the per-day table, latest summary, and header line (today: capitulation=0.86, DD=-21.2%)
- [ ] Dashboard build/typecheck clean — **Phase 3, separate PR on `stable`**
- [ ] Cabinet PRD status updated from `analyzed` → `shipped` once BOTH PRs merge (engine +
  dashboard) — not yet, engine PR still needs to be opened/merged first
- [ ] [[radar-purple-fragility]] memory entry updated with the outcome — after merge

---

## Sync note

This plan's items are new (no prior open items to mirror from
`~/cabinet/projects/smart-volume-radar/decisions-log.md`). Once Phase 0 completes, log the
backtest decision there regardless of outcome (proceed / drop) — that's the actual product
decision this plan exists to support.
