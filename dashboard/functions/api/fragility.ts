// dashboard/functions/api/fragility.ts
//
// Purple List fragility series (fragility_daily) — written daily by the
// Smart pipeline (main branch, fragilityD1Ingest.ts). Standalone per-day
// scalar series: no mergeSetup/enrich involvement. The table may not exist
// until the first Smart ingest — treat errors as an empty series.
import { buildFragilityQuery } from '../../src/query.js';

interface Env { DB: D1Database; }

interface FragilityRow {
  scan_date: string;
  score: number;
  /** Watch-tier score (wick10+dist20+disp10 z-mean) — model v2, PR #82. Part of the
   *  real 🟡 alert rule (core3>=1.0 OR climax>=1.5+nearHigh); not drawn as its own
   *  line (would clutter the chart) — surfaced in the tooltip instead. */
  core3: number | null;
  /** Contextual volume climax (euphoria-context, near a high) — model v2, PR #82.
   *  Same tooltip-only treatment as core3. */
  climax: number | null;
  /** Capitulation Score (מד המיצוי) — bottom-detection companion gauge, descriptive
   *  only (no threshold/alert tied to it). See explainer tab for our own validation. */
  capitulation: number | null;
  wick10_z: number | null;
  pct_above50_z: number | null;
  dist20_z: number | null;
  ext50_z: number | null;
  corr20_z: number | null;
  disp10_z: number | null;
  index_value: number | null;
  drawdown_pct: number | null;
  canary_count: number | null;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  try {
    const q = buildFragilityQuery({});
    const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<FragilityRow>();
    return Response.json(results ?? []);
  } catch {
    // fragility_daily not created yet — the panel simply stays hidden.
    return Response.json([]);
  }
};
