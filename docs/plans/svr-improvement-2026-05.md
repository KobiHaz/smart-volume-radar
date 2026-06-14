# Plan: Smart Volume Radar — Full Improvement Roadmap

## Context
Two tracks of work merged into this plan:

**Track A — Original fixes (Phases 0–5):** The Smart Radar sends 155 alerts/day with
only 1 actionable. `llmSummary` is dead in production. The radar lacks agentic
deep-dives and criteria validation. Track A fixes these, introduces 2 Claude assets,
and runs a quality pass over the codebase.

**Track B — ChampionScan adoption (Phases 6–10):** A 2026-06-14 competitive analysis
of ChampionScan.com revealed it is CANSLIM-as-a-SaaS (IBD Trend Template + fundamental
acceleration filters). SVR's edge is RVOL + graduation; ChampionScan's edge is
market-relative strength + fundamental quality. Track B bolts the highest-signal
CANSLIM filters onto SVR's volume engine — creating signals that are both
volume-confirmed AND fundamentally sound.

**Branch:** `main` (Smart Radar). Lean Radar lives on `stable` and is already healthy.

---

## Tasks

### Phase 0: Cleanup & cabinet sync — *house-keeping, no code change*
- [ ] **0.1** Move `outputs/2026-05-*.md` from project → `~/cabinet/outputs/` (per global CLAUDE.md rule).
  - Files: 2026-05-10 normal radar quant review, 2026-05-10 lean radar quant review,
    2026-05-11 60d deep analysis, 2026-05-11 window comparison, 2026-05-22 anthropic research.
  - **Verify:** `ls ~/cabinet/outputs/ | grep smart-volume-radar` shows new files.
- [ ] **0.2** Update `~/cabinet/knowledge/reference/smart-volume-radar-architecture.md`
  with: 2-radar split (Smart on main, Lean on stable), TV watchlist split,
  Graduated detector, LaunchAgent flow.
  - **Verify:** doc mentions "Lean Radar" + "tv-breakouts-latest.txt" + "Graduated detector".
- [ ] **0.3** Create `~/cabinet/knowledge/reference/smart-volume-radar-criteria-empirical.md`
  with the 60d/1y findings: lowRiskEntry −25.6%, pivotBreakout +20.4%, Graduated +24.3%.
  - **Verify:** numbers match `outputs/2026-05-11-60d-deep-analysis.md`.
- [ ] **0.4** Create `~/cabinet/projects/smart-volume-radar/decisions-log.md` —
  start with entries for split TV watchlists (5/22) and llmSummary identified dead (5/22).
  - **Verify:** file exists, 2 entries with date + rationale + impact.
- [ ] **0.5** `git -C ~/cabinet commit -am "update: SVR architecture + criteria + decisions"` + push.
  - **Verify:** `git log` shows commit, push succeeded.

### Phase 1: Smart Radar spam fix — *the headline win, est. 30 min*
- [ ] **1.1** Cap `formatNotableSection` at top-5 per sub-section (distribution + no-vol).
  - File: `src/services/telegramBot.ts:543`.
  - **Verify:** unit test or quick `npm run preview-report` shows ≤10 lines in NOTABLE.
- [ ] **1.2** Skip stocks in NOTABLE when `championScore < 60` (low-quality filter).
  - File: `src/services/telegramBot.ts:543`.
  - **Verify:** preview-report shows distribution items only with score ≥60.
- [ ] **1.3** Skip NOTABLE entirely when `sectorMedianReturn63d < 0` (sector-wide noise).
  - File: `src/services/telegramBot.ts:543`.
  - **Verify:** preview-report on a day with weak A&D sector — A&D items absent.
- [ ] **1.4** Add 🎓 **Graduated** section to top of Telegram (Close→Full event).
  - File: `src/services/telegramBot.ts:formatGraduationSection` (already exists at line 717 — just verify it's wired).
  - **Verify:** when a real graduation happens, section appears at top.
- [ ] **1.5** Use **`anthropic-skills:code-review-checklist`** on the diff before commit.
  - **Verify:** review notes saved to `outputs/2026-05-22-spam-fix-review.md`,
    no critical findings unresolved.
- [ ] **1.6** Commit + push + trigger GHA run for verification.
  - **Verify:** the night's Telegram shows ≤20 lines total instead of 155.

### Phase 2: llmSummary — kill the dead code, optionally build aiCommentary
- [ ] **2.1** Delete `src/services/llmSummary.ts` exports that are unused
  (`getReportSummary`, `getPerStockAnalyses`, `buildPrompt`).
  Keep `classifyTickersWithGroq` only (it's a utility, not dead).
  - **Verify:** `grep -rn "getReportSummary\|getPerStockAnalyses" src/` returns nothing.
- [ ] **2.2** Delete `src/agents/llmClient.ts` + `src/agents/types.ts` (newer abstraction, never used).
  - **Verify:** `grep -rn "from.*agents/llmClient" src/` returns nothing.
- [ ] **2.3** Remove `enableLlmSummary`, `LLM_PROVIDER`, `LLM_*` from `src/config/index.ts`
  except for the bits `classifyTickersWithGroq` still needs (Groq key).
  - **Verify:** `tsc --noEmit` passes.
- [ ] **2.4** Remove `ENABLE_LLM_SUMMARY` + `LLM_PROVIDER` + `GEMINI_API_KEY`
  from `.github/workflows/daily-scan.yml`.
  - **Verify:** GHA run completes without LLM warnings.
- [ ] **2.5** Use **`code-simplifier:code-simplifier`** subagent on the LLM cleanup.
  - **Verify:** subagent returns diff with no broken imports, no dead types.
- [ ] **2.6** Build `aiCommentary.ts` (Claude API `claude-sonnet-4-6` + prompt caching)
  for graduation-only commentary. ChampionScan's "plain-English reasoning" feature
  confirms this is a real UX differentiator — no longer a decision point, do it.
  - Wire to `monitorTracker.ts`: fire only on `status = graduated` events.
  - Prompt: 3-sentence thesis — what the setup is, why volume matters here, key risk.
  - **Verify:** graduation alert in Telegram includes a 3-sentence Claude commentary block.

### Phase 3: Custom skill `radar:deep-dive` — *per-stock thesis on demand, est. 2-3h*
- [ ] **3.1** Create `~/.claude/skills/radar-deep-dive/SKILL.md` with YAML frontmatter
  (description, when-to-use triggers). Skill file structure per Anthropic Skills docs.
  - **Verify:** Claude auto-invokes skill on prompt "deep dive on MNST".
- [ ] **3.2** Define tool interface inside the skill: `getStock(ticker)`,
  `getNews(ticker)`, `getEarnings(ticker)`, `getSector(ticker)`, `getMonitorHistory(ticker)`.
  - **Verify:** skill can invoke each without error.
- [ ] **3.3** Wire to existing radar fetchers (newsService, finnhubFundamentals, monitorTracker).
  - **Verify:** `getNews("AAPL")` returns Finnhub headlines.
- [ ] **3.4** Output template: 1-page thesis with bull case / bear case / current setup / recent news.
  - **Verify:** test on 3 tickers — output is consistent format, under 200 words.
- [ ] **3.5** Use **`anthropic-skills:clean-code`** for skill instructions readability.
  - **Verify:** SKILL.md scans clean — no jargon, each section purpose-stated.

### Phase 4: Subagent `radar-criteria-tester` — *validate before deploy, est. 3-4h*
- [ ] **4.1** Create `.claude/agents/radar-criteria-tester.md` with focused system prompt:
  "Given a proposed criterion change, run the lift analysis on 60-90 days of scan history
  and return side-by-side comparison + recommendation."
  - **Verify:** subagent file parses, shows in `Agent` tool's options.
- [ ] **4.2** Wire read-only access to `results/scan-*.json` + execute permission for
  `scripts/analyze-criteria-importance.ts`.
  - **Verify:** subagent can read scan files + spawn the analysis script.
- [ ] **4.3** Output format: lift before/after, hit-rate before/after, sector breakdown,
  risk warnings (e.g., "tested only in bull regime").
  - **Verify:** test on a known change (drop lowRiskEntry) — output matches our manual finding.
- [ ] **4.4** Use **`anthropic-skills:tdd-workflow`** patterns for the subagent's test cases.
  - **Verify:** subagent ships with 3 canonical test scenarios documented in its prompt.

### Phase 5: Quality pass — *codebase health, est. 2-3h*
- [ ] **5.1** Run **`anthropic-skills:code-review-checklist`** on `src/index.ts`,
  `src/services/marketData.ts`, `src/utils/setup.ts`, `src/utils/championScore.ts`.
  - **Verify:** findings written to `outputs/2026-05-22-svr-quality-review.md`.
- [ ] **5.2** Run **`code-simplifier:code-simplifier`** subagent on the same 4 files
  to remove duplication + dead code.
  - **Verify:** simplifier returns diff. PR-ready, no behavior change.
- [ ] **5.3** Run **`anthropic-skills:lint-and-validate`** project-wide.
  - **Verify:** `npx tsc --noEmit && npm run lint` exit 0.
- [ ] **5.4** Use **`engineering:tech-debt`** skill to identify + prioritize remaining issues.
  - **Verify:** prioritized list in `outputs/2026-05-22-svr-tech-debt-backlog.md`.
- [ ] **5.5** Use **`anthropic-skills:performance-profiling`** on the scan pipeline.
  - Question to answer: is the 1-minute scan time mostly Yahoo I/O or computation?
  - **Verify:** profile breakdown saved to outputs.

---

## Track B — ChampionScan Signal Quality Upgrades

> Source: ChampionScan competitive analysis, 2026-06-14.
> Key insight: ChampionScan = CANSLIM-as-SaaS. Their top signals are RS Percentile
> (market-relative strength) and Industry Group Rank. SVR has neither — only sector-level
> (12 buckets) and RVOL. Adding these makes SVR signals fundamentally qualified + volume-confirmed.
> SVR's RVOL + Graduation edge has no equivalent in ChampionScan — protect it.

### Phase 6: RS Percentile Score — *market-relative strength, est. 2h*

> IBD's most powerful filter. A stock with RVOL=4 and RS=92 is a market leader breaking out.
> A stock with RVOL=4 and RS=45 is a laggard spiking on noise. SVR can't distinguish these today.

- [ ] **6.1** Add `rsPercentile: number` (0–100) to `StockData` type in `src/types/`.
  - Formula: compare each stock's weighted return vs all 366 watchlist tickers.
  - Weights: 3M return × 40% + prior 3 quarters × 20% each (IBD standard).
  - Use Yahoo OHLC data already fetched — no new API needed.
  - File: `src/utils/technicalAnalysis.ts` (add `computeRsPercentile(stocks)`).
  - **Verify:** `console.log` the RS distribution — expect Semi/AI-Chain stocks clustering 85–98.
- [ ] **6.2** Gate Full BUY signals: require `rsPercentile >= 85`.
  - File: `src/utils/setup.ts` (wherever `evaluateMomentumSetup` gates Full tier).
  - **Verify:** re-run backtest `scripts/analyze-60d-coverage.ts` — expect A&D stocks filtered out.
- [ ] **6.3** Surface in Telegram: `📈 RS:92` added to per-stock line on Full + Recovery alerts.
  - File: `src/services/telegramBot.ts`.
  - **Verify:** preview-report shows `RS:` value on every BUY line.
- [ ] **6.4** Add `rsPercentile` to `scan-YYYY-MM-DD.json` snapshot for future backtesting.
  - File: `src/utils/snapshotWriter.ts`.
  - **Verify:** latest scan JSON has `rsPercentile` field on each stock object.

### Phase 7: Industry Group Ranking — *granular sector intelligence, est. 3h*

> SVR's 12 broad sectors hide real divergence inside groups. "Software" is -0.5% median
> but cybersecurity sub-group might be +15%. Finnhub provides `finnhubIndustry` (more
> granular). Targeting ~30–40 groups replaces the blunt sector gate with a precise one.

- [ ] **7.1** Pull `finnhubIndustry` from Finnhub for all 366 tickers during the daily scan.
  - File: `src/services/finnhubFundamentals.ts`.
  - Cache in `results/finnhub-cache/${TICKER}.json` (already exists).
  - **Verify:** sample 20 tickers — `finnhubIndustry` field populated and non-null.
- [ ] **7.2** Build industry group rank: group tickers by `finnhubIndustry`, compute
  `groupMedianReturn63d` per group, rank 1–N (1 = strongest).
  - File: `src/utils/sectorRank.ts` (extend existing `applySectorRanks`).
  - Add `industryGroup: string` + `groupRank: string` (e.g., `"#3/38"`) to `StockData`.
  - **Verify:** top 5 groups are recognizably AI/Semi/infra-related.
- [ ] **7.3** Replace the current 12-sector gate with group gate: suppress signals when
  `groupMedianReturn63d < 0`.
  - This replaces the blunt `sectorMedianReturn63d < 0` check from Phase 1.3.
  - **Verify:** backtest — A&D sub-groups disappear from BUY signals.
- [ ] **7.4** Display in Telegram: `#3/38 Semiconductors` on Full BUY lines.
  - **Verify:** preview-report shows group rank + name on every BUY alert.

### Phase 8: Quick Signal Quality Adds — *low effort, high trader UX value, est. 1h*

**8A — Breakout Age Counter ("Fresh 2d")**

> ChampionScan shows exact days since pivot. SVR has Fresh/Aging enum but no day count.
> Your empirical sweet spot is 2–4 weeks hold (+15.3%, 90% hit rate). Traders need to
> know if they're entering day 1 vs day 12.

- [ ] **8.1** Add `breakoutAgeDays: number` to `StockData` — trading days since `breakoutDate`.
  - File: `src/utils/technicalAnalysis.ts`.
  - **Verify:** field populated on all stocks with `breakoutStage !== 'Setup'`.
- [ ] **8.2** Auto-suppress BUY action → `PASS_TOO_LATE` when `breakoutAgeDays > 15`.
  - File: `src/utils/setup.ts` (action assignment block).
  - **Verify:** stocks with old breakouts show `PASS_TOO_LATE` not `BUY`.
- [ ] **8.3** Display in Telegram: `⏱️ Fresh 2d` or `⏱️ Aging 8d` on BUY lines.
  - **Verify:** preview-report shows age on every signal.

**8B — Market Health Status at top of Telegram**

> SVR has `marketRegime: 'bull' | 'bear'` but doesn't surface it. Every signal
> exists in market context. ChampionScan leads with a market health banner.

- [ ] **8.4** Compute 3-point market health score:
  - SPY above SMA200 → +1pt
  - SPY RVOL > 1.0 → +1pt
  - SPY 5-day return > 0 → +1pt
  - Express as: `🟢 Strong (3/3)` / `🟡 Neutral (2/3)` / `🔴 Weak (0-1/3)`
  - File: `src/services/marketData.ts` + `src/services/telegramBot.ts`.
- [ ] **8.5** Pin market health to the very top of every Telegram message — before any stock alerts.
  - **Verify:** Telegram shows market health header as first line of every report.

### Phase 9: Climax Top Detection — *sell signals, est. 2h*

> SVR is all entry, zero exit. ChampionScan's "Climax top warnings" close the trade
> lifecycle. This adds the first sell-side logic to SVR.

- [ ] **9.1** Add `detectClimax(stock: StockData): boolean` to `src/lean/signals.ts`.
  - IBD climax criteria (require ≥2 of 3):
    - Price >125% above lowest point of base (extended from base)
    - `(price / sma21) > 1.5` (far above 21-day MA)
    - `bigMoveToday = true` AND `pctFromAth > -5%` (making new highs on big day)
  - **Verify:** back-test against known blow-off tops (e.g., AI stocks late 2025).
- [ ] **9.2** Add new action: `CLIMAX_WARNING` to the action enum in `src/types/`.
  - Override action to `CLIMAX_WARNING` when `detectClimax = true`, even if other
    criteria say BUY.
  - **Verify:** `tsc --noEmit` passes.
- [ ] **9.3** Add `🔔 Climax Warnings` section to Telegram — placed after BUY signals,
  before NOTABLE. Format: `TICKER — ⚠️ Extended +180% from base. Tighten stop or reduce.`
  - File: `src/services/telegramBot.ts`.
  - **Verify:** preview-report with a known extended stock shows climax section.

### Phase 10: Fundamental Acceleration Composite — *CANSLIM's C+A, est. 1.5h*

> ChampionScan's "Trend Score" fires when EPS + Revenue + Margins simultaneously
> accelerate. SVR has `epsAcceleration` and `revAcceleration` as separate booleans
> but never combines them. Adding a composite gives a fundamentally-confirmed signal
> independent of price action.

- [ ] **10.1** Add `fundamentalStrength: boolean` to `StockData`:
  - `fundamentalStrength = epsAcceleration && revAcceleration`
  - Margins data unavailable from Finnhub free tier — skip for now.
  - File: `src/services/finnhubFundamentals.ts` (compute after fetching both).
  - **Verify:** sample 20 tickers — ~30–40% have `fundamentalStrength = true`.
- [ ] **10.2** Weight in `championScore`: add +10 points when `fundamentalStrength = true`.
  - File: `src/utils/championScore.ts`.
  - **Verify:** re-run score distribution — fundamentally-strong stocks gain 10pts.
- [ ] **10.3** Surface in Telegram on Full BUY alerts: `⚡ EPS+Rev↑` badge when true.
  - **Verify:** preview-report shows badge on qualifying stocks.

---

### Phase X: Verification (always last)
- [ ] **X.1** Full `tsc --noEmit && npm run lint && npm run test` passes on main.
- [ ] **X.2** GHA Smart Radar run completes successfully with new spam-fixed output.
- [ ] **X.3** Telegram message of the night ≤25 total lines (vs 155 today).
- [ ] **X.4** All cabinet docs committed + pushed.
- [ ] **X.5** Final `outputs/2026-05-22-svr-improvement-summary.md` with before/after metrics.

---

## Skill / Agent Cheat Sheet (used in this plan)

| Asset | When | Used in |
|---|---|---|
| `anthropic-skills:plan-writing` | Now (this doc) | This file |
| `anthropic-skills:code-review-checklist` | Pre-commit reviews | Phase 1.5, 5.1 |
| `anthropic-skills:clean-code` | Naming/structure | Phase 3.5 |
| `anthropic-skills:lint-and-validate` | After each phase | Phase 5.3, all Phase X |
| `anthropic-skills:tdd-workflow` | Subagent design | Phase 4.4 |
| `anthropic-skills:performance-profiling` | Scan timing | Phase 5.5 |
| `anthropic-skills:systematic-debugging` | If GHA breaks | (as needed) |
| `code-simplifier:code-simplifier` (subagent) | Dead code removal | Phase 2.5, 5.2 |
| `engineering:tech-debt` | Prioritization | Phase 5.4 |
| `engineering:code-review` | Alternative to checklist | (as needed) |
| `engineering:debug` | Bugs in production | (as needed) |
| `Plan` (subagent) | Architecture decisions | (as needed) |
| `explorer-agent` | Codebase exploration | Phase 5 prep |

---

## Risk Notes

**Track A:**
- Phase 1 is the highest-impact + lowest-risk. Do it first regardless of the rest.
- Phase 2 deletes code — must be careful that `classifyTickersWithGroq` still works
  (run `scan-now` after the delete to verify).
- Phase 2.6 (aiCommentary) requires adding `ANTHROPIC_API_KEY` to GHA secrets.
- Phase 3-4 add new Claude assets — they don't change radar behavior, so safe to merge
  even if not perfect.
- Phase 5 is a pure refactor — no behavior change expected, but the diff might be large.

**Track B:**
- Phase 6 (RS Percentile) requires a full-watchlist sort — run during the existing
  `fetchAllStocks` pass, not a separate step. Watch for p-limit concurrency issues.
- Phase 7 (Group Rank) replaces the 12-sector gate — run a backtest before deploying
  to confirm the group-level gate outperforms the sector-level gate.
- Phase 8 is low-risk (pure additions). Do it in a single PR with Phase 1.
- Phase 9 (Climax) introduces the first sell signal — validate against 3–5 known
  blow-off tops before shipping. Do NOT ship if detection rate is <80% on known cases.
- Phase 10 is additive only (+10pts to score, new badge) — zero breaking changes.
- **Do Track B phases in order 6 → 8 → 10 → 7 → 9.** RS Percentile first (highest
  impact), group rank second (needs more testing), climax last (most novel logic).

## Estimated Total: 18-24 hours, spread across 4-5 sessions.

---

## Progress

> **Reconciliation 2026-06-14:** Ground-truthed against actual code. The repo
> advanced through a "TD-14 → TD-26" series after this plan was written, shipping
> ~80% of it (often better than spec). Statuses below reflect VERIFIED code state,
> not the original plan assumptions. Verified by reading src/ + git log on `main`.

### Track A — Original Fixes
| Phase | Status | Evidence |
|---|---|---|
| 0. Cleanup + cabinet sync | ✅ done | `.claude` knowledge consolidated into repo (commit c66d3d6) |
| 1. Smart Radar spam fix | ✅ done | `NOTABLE_MAX_PER_BUCKET=5`, `NOTABLE_MIN_SCORE=60`, skip-neg-sector, graduation section all live in telegramBot.ts |
| 2.1–2.5 llmSummary cleanup | ✅ done | `src/agents/` gone, LLM env gone, only `classifyTickersWithGroq` kept |
| 2.6 aiCommentary (Claude API) | ⏸ blocked | Needs `ANTHROPIC_API_KEY` in GHA secrets + per-cron cost — Kobi's call |
| 3. radar:deep-dive skill | ✅ done | `radar-deep-dive` skill exists |
| 4. radar-criteria-tester subagent | ✅ done | `.claude/agents/radar-criteria-tester.md` exists |
| 5. Quality + simplification pass | ✅ ongoing | Continuous via TD-* series; `tsc`+`eslint` clean |

### Track B — ChampionScan Signal Quality Upgrades
| Phase | Status | Evidence / Note |
|---|---|---|
| 6. RS Percentile score | ✅ done | `applyRSPercentile` (SPY-relative alpha), gated in championScore, shown in Telegram — better than spec |
| 7. Industry Group Ranking | ❌ **REJECTED** (backtest 2026-06-14) | Sector gate (TD-10) blocks a −9.1%/39%-hit loser cohort; industry gate blocks only a +0.7%/51% coin-flip. 42% of alerts (Tel Aviv) can't resolve finnhubIndustry. Keep TD-10. |
| 8.1–8.3 Breakout age display | ✅ done | per-stock block shows `{daysSinceAth}d since ATH` + Stage label |
| 8.4–8.5 Market-health header | ✅ **shipped 2026-06-14** | `fetchMarketHealth` + 🩺 banner; tsc/lint/258 tests green; live render verified |
| 9. Climax Top detection | ❌ **REJECTED as a gate** (backtest 2026-06-14) | Flag as defined marks OUTPERFORMERS: +5.7%/60%-hit vs +0.8%/53% non-flagged. The NEW cohort beyond TD-13/25 is the *strongest* in the study (+7.8%/65%). Gating it would demote your best entries. Only viable as an info-only strength tag, never a sell signal. (Untestable for real bear-regime exhaustion: only 5 bear days in window.) |
| 10. Fundamental accel composite | ❌ not backtestable | No point-in-time fundamentals to reconstruct; can only ship flag-only/no-gate or skip |

### Shared
| Phase | Status |
|---|---|
| X. Full verification | ✅ green this session (tsc 0, eslint 0, 258/258 jest) |
