// dashboard/functions/api/summary.ts
import { buildSummaryQuery, buildSetupSummaryQuery } from '../../src/query.js';
import { mergeSummary, type SetupSummaryRow } from '../../src/mergeSetup.js';

interface Env { DB: D1Database; }

interface SummaryRow { scan_date: string; total?: number; setup_full?: number; setup_other?: number; rs90?: number; [k: string]: unknown; }

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const q = buildSummaryQuery({});
  const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<SummaryRow>();
  let rows = (results ?? []) as SummaryRow[];

  // Merge per-date counts from the Smart pipeline's setup_signals table.
  // Table may not exist until the first Smart ingest — treat errors as empty.
  try {
    const sq = buildSetupSummaryQuery();
    const setup = await env.DB.prepare(sq.sql).bind(...sq.params).all<SetupSummaryRow>();
    rows = mergeSummary(rows, (setup.results ?? []) as SetupSummaryRow[]);
  } catch {
    // no setup tables yet — lean summary alone is correct.
  }

  return Response.json(rows);
};
