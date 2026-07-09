// dashboard/functions/api/signals.ts
import {
  buildSignalsQuery,
  buildRecentDatesQuery,
  buildHistoryRowsQuery,
  buildSetupRowsQuery,
  buildRsDailyQuery,
} from '../../src/query.js';
import { enrichRows, type HistoryRow } from '../../src/enrich.js';
import { mergeSetupRows, type SetupRowD1, type RsDailyRow } from '../../src/mergeSetup.js';

interface Env { DB: D1Database; }

interface DayRow { scan_date: string; ticker: string; score: number; signal: string; signals: string; signal_count: number; rs?: number | null; [k: string]: unknown; }

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const q = buildSignalsQuery({ from, to });
  const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<DayRow>();
  let dayRows = (results ?? []) as DayRow[];

  // Read-time merge of the Smart pipeline's setup_signals + rs_daily tables.
  // They may not exist until the first Smart ingest runs — treat errors as empty.
  try {
    const sq = buildSetupRowsQuery({ from, to });
    const setup = await env.DB.prepare(sq.sql).bind(...sq.params).all<SetupRowD1>();
    const rq = buildRsDailyQuery({ from, to });
    const rs = await env.DB.prepare(rq.sql).bind(...rq.params).all<RsDailyRow>();
    dayRows = mergeSetupRows(dayRows, (setup.results ?? []) as SetupRowD1[], (rs.results ?? []) as RsDailyRow[]);
  } catch {
    // setup tables absent or query failed — lean rows alone are still correct.
  }

  if (dayRows.length === 0) return Response.json([]);

  try {
    // The dashboard's displayed rows are a single day; enrich against that day.
    const targetDate = dayRows.reduce((m, r) => (r.scan_date > m ? r.scan_date : m), dayRows[0].scan_date);

    const dq = buildRecentDatesQuery(targetDate, 12);
    const dates = await env.DB.prepare(dq.sql).bind(...dq.params).all<{ scan_date: string }>();
    const dateSeq = (dates.results ?? []).map((d) => d.scan_date);

    const hq = buildHistoryRowsQuery(dateSeq);
    const hist = await env.DB.prepare(hq.sql).bind(...hq.params).all<HistoryRow>();
    const historyRows = (hist.results ?? []) as HistoryRow[];

    return Response.json(enrichRows(dayRows, historyRows, dateSeq));
  } catch {
    // Resilient fallback: return un-enriched day rows if enrichment fails.
    return Response.json(dayRows);
  }
};
