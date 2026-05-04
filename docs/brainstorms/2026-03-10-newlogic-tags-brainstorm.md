# Brainstorm: Newlogic Tagging System for Daily Report

**Date:** 2026-03-10  
**Sources:** Newlogic.pdf, image (How it will look in the report), 2026-03-08 analyst spec

---

## What We're Building

A refined logic for the Smart Volume Radar daily report that:

1. **Keeps entry criteria** — RVOL ≥ 2 AND daily price movement ≥ 2% (matches current Top Signals filter)
2. **Adds independent tags** — Each stock can receive zero or more tags when additional conditions are met:
   - **SMA21 Touch** — Price touched SMA21 during the day (Low ≤ SMA21 ≤ High)
   - **Pullback 15%** — Stock pulled back ≥15% from its last high (52w or swing)
   - **1M Breakout** — Broke out of consolidation under ~1 month

Tags are **independent**: a stock can have any combination (e.g. SMA21 Touch + Pullback 15%, or only 1M Breakout).

---

## Current vs Newlogic

| Aspect | Current System | Newlogic |
|--------|----------------|----------|
| Entry | RVOL ≥ 2, Top Signals = \|priceChange\| ≥ 2% | Same |
| Classification | Setup (Full / Close) — combined 3–4 conditions | Tags — independent per condition |
| SMA21 | nearSMA21: close within 3% of SMA21 | Touch: Low ≤ SMA21 ≤ High (intraday) |
| Pullback | nearAth: within 20% of 52w high | Pullback 15%: drawdown ≥ 15% from high |
| Base | inConsolidation: 6–36 month base | 1M Breakout: &lt;1 month consolidation, then breakout |

---

## Key Definitions (from Newlogic.pdf)

### 1. Entry (unchanged)
- RVOL ≥ 2
- \|priceChange\| ≥ 2%

### 2. SMA21 Touch
- **Formula:** Low ≤ SMA21 ≤ High (today's candle)
- **Meaning:** Intraday range touched the 21-day moving average  
- **Data:** Requires daily `high` and `low`; Yahoo Chart returns these

### 3. Pullback 15%
- **Formula:** `drawdownFromHigh = ((lastClose - PeriodHigh) / PeriodHigh) × 100`
- **Condition:** `drawdownFromHigh ≤ -15%`
- **PeriodHigh:** 52-week high (or last swing high for stricter definition)

### 4. 1M Breakout
- **Consolidation:** Stock traded in a range for ~21 trading days (1 month)
- **Breakout:** `lastClose > rangeHigh` where range = high/low of that 21-day window
- **Stricter variant:** Verify stock stayed within range before breakout

---

## Why This Approach

- **Clearer signal** — Each tag conveys one concrete behavior; no combined score ambiguity
- **Actionable** — SMA21 Touch = support test, Pullback 15% = dip, 1M Breakout = fresh breakout
- **Simpler mental model** — "This stock has X and Y" vs "Close Setup"
- **Aligned with Newlogic spec** — Matches the documented intent and the image structure (entry + tags)

---

## Approaches

### A. Replace Setup with Tags (recommended)

Remove Full/Close Setup entirely; show only the three tags where applicable.

**Pros:** Single source of truth, no overlap, report matches Newlogic doc  
**Cons:** Breaks existing weekly report (which filters by `setupType === 'full'`); migration needed

### B. Tags Alongside Setup

Keep Full/Close emoji and add tags on each row (e.g. `🎯 SMA21 • Pullback 15%`).

**Pros:** Backward compatible; users see both  
**Cons:** More visual noise; two classification systems to maintain

### C. Configurable Mode

Env var or config to choose: `Setup mode` (current) vs `Tags mode` (Newlogic).

**Pros:** Gradual rollout, A/B comparison  
**Cons:** More code paths; higher maintenance

---

## Recommendation

**Approach A (Replace Setup with Tags)** — Simpler long-term, matches Newlogic. Requires:
- New `StoredSignal` shape (tags array instead of setupType) or mapping for weekly report
- Decision on weekly report filter (e.g. "has at least one tag" or new criterion)

---

## Open Questions

*(None)*

---

## Resolved Questions

1. **Relationship to Setup:** Replace existing Setup entirely with tags.
2. **Weekly report:** For the beginning, list all signals (no tag-based filter).
3. **PeriodHigh for Pullback:** Use 52-week high (simpler).
4. **Silent Activity:** Yes — add tags to volume-without-price stocks as well.
