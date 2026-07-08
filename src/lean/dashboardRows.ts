import fs from 'node:fs';
import path from 'node:path';
import type { StockData } from '../types/index.js';

const FOREIGN_SUFFIXES = [
  '.TW', '.KS', '.T', '.MI', '.PA', '.L', '.AS', '.SW', '.VI',
  '.SA', '.BK', '.HK', '.DE', '.CO', '.ST', '.HE', '.OL', '.MC', '.BR', '.TO',
];

export function regionOf(ticker: string): 'US' | 'TASE' | 'Foreign' {
  if (ticker.endsWith('.TA')) return 'TASE';
  if (FOREIGN_SUFFIXES.some((s) => ticker.endsWith(s))) return 'Foreign';
  return 'US';
}

export function isETFSector(sector: string | undefined | null): boolean {
  return /ETF/i.test(sector ?? '');
}

export type SignalKind =
  | 'breakout' | 'highVolume' | 'pullback' | 'creep'
  | 'nearBreakout' | 'nearHighVol' | 'nearPullback';

export interface Row {
  scanDate: string;     // 'YYYY-MM-DD'
  ticker: string;
  region: 'US' | 'TASE' | 'Foreign';
  sector: string;
  signal: SignalKind;         // PRIMARY = signals[0] (strongest BASE)
  signals: SignalKind[];      // ALL matched signals, ordered by BASE desc
  signalCount: number;        // signals.length
  rvol: number;
  athPct: number | null;
  dayPct: number;
  stage2: 0 | 1;
  distPivot: number | null;
  score: number;
  price: number;
}

const BASE: Record<SignalKind, number> = {
  pullback: 50, creep: 42, nearPullback: 38, highVolume: 30,
  nearHighVol: 18, breakout: 12, nearBreakout: 8,
};

/** Sort a set of signals by BASE descending (strongest first). */
function orderByBase(signals: SignalKind[]): SignalKind[] {
  return [...signals].sort((a, b) => BASE[b] - BASE[a]);
}

type ScoreInput = Omit<Row, 'score'>;

export function scoreRow(r: ScoreInput): number {
  const base = Math.max(...r.signals.map((sig) => BASE[sig]));
  let s = base;
  s += Math.min(r.rvol || 0, 6) * 5;
  if (r.stage2) s += 20;
  if (r.distPivot != null) s += Math.max(0, 10 - r.distPivot * 4);
  s += (r.signalCount - 1) * 12; // CONFLUENCE BONUS (+12 per extra signal)
  if (r.signals.includes('highVolume') && (r.dayPct || 0) < 0) s -= 25; // climax
  if ((r.rvol || 0) >= 8) s -= 15; // 2026-07-08 study: rvol>=8 = climax, +0.58% med21
  if (r.athPct != null && r.athPct < -30) s -= 20;
  if (isETFSector(r.sector)) s -= 12;
  return Math.round(s);
}

function isStage2(s: StockData): 0 | 1 {
  return s.lastPrice != null && s.sma50 != null && s.sma200 != null &&
    s.lastPrice > s.sma50 && s.sma50 > s.sma200 ? 1 : 0;
}

/** Build one Row for a ticker given ALL its matched signals + the stock object. */
function buildRow(
  scanDate: string, stock: StockData, signals: SignalKind[], distPivot: number | null,
): Row {
  const ordered = orderByBase(signals);
  const r: Omit<Row, 'score'> = {
    scanDate, ticker: stock.ticker.toUpperCase(), region: regionOf(stock.ticker),
    sector: stock.sector ?? 'Unknown', signal: ordered[0]!, signals: ordered,
    signalCount: ordered.length,
    rvol: stock.rvol ?? 0, athPct: stock.pctFromAth ?? null,
    dayPct: stock.priceChange ?? 0, stage2: isStage2(stock),
    distPivot, price: stock.lastPrice ?? 0,
  };
  return { ...r, score: scoreRow(r) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowsFromLeanResult(scanDate: string, result: any): Row[] {
  // Group every matched signal by ticker so each ticker yields ONE row.
  interface Acc { stock: StockData; signals: Set<SignalKind>; distPivot: number | null; }
  const byTicker = new Map<string, Acc>();

   
  const add = (stock: StockData, signal: SignalKind, distPivot: number | null) => {
    const key = stock.ticker.toUpperCase();
    const acc = byTicker.get(key);
    if (acc) {
      acc.signals.add(signal);
      // Carry distPivot from a consolidation entry when present.
      if (distPivot != null && acc.distPivot == null) acc.distPivot = distPivot;
    } else {
      byTicker.set(key, { stock, signals: new Set([signal]), distPivot });
    }
  };

   
  for (const e of result.consolidationBreakouts) add(e.stock, 'breakout', 0);
   
  for (const e of result.highVolume) add(e.stock, 'highVolume', null);
   
  for (const e of result.pullbacks) add(e.stock, 'pullback', null);
  // ?? [] — older snapshots/fixtures predate the creep tier.
  for (const e of result.creep ?? []) add(e.stock, 'creep', null);
   
  for (const e of result.nearConsolidation) add(e.stock, 'nearBreakout', e.signal.distanceToPivotPct);
   
  for (const e of result.nearVolume) add(e.stock, 'nearHighVol', null);
   
  for (const e of result.nearPullback) add(e.stock, 'nearPullback', null);

  const rows: Row[] = [];
  for (const acc of byTicker.values()) {
    rows.push(buildRow(scanDate, acc.stock, [...acc.signals], acc.distPivot));
  }
  return rows;
}

interface ReconRecord {
  sector: string; rvol: number; barGain: number; pctFromAth: number | null;
  lastPrice: number; isStage2: boolean; signals: SignalKind[]; distanceToPivotPct: number | null;
}

export function rowsFromReconstructed(recon: {
  signalsByDate: Record<string, Record<string, ReconRecord>>;
}): Row[] {
  const rows: Row[] = [];
  for (const [scanDate, day] of Object.entries(recon.signalsByDate)) {
    for (const [ticker, rec] of Object.entries(day)) {
      const ordered = orderByBase(rec.signals);
      const r: Omit<Row, 'score'> = {
        scanDate, ticker: ticker.toUpperCase(), region: regionOf(ticker),
        sector: rec.sector ?? 'Unknown', signal: ordered[0]!, signals: ordered,
        signalCount: ordered.length,
        rvol: rec.rvol ?? 0, athPct: rec.pctFromAth, dayPct: rec.barGain ?? 0,
        stage2: rec.isStage2 ? 1 : 0, distPivot: rec.distanceToPivotPct, price: rec.lastPrice ?? 0,
      };
      rows.push({ ...r, score: scoreRow(r) });
    }
  }
  return rows;
}

/** Write results/dashboard-{date}.json (Row[]) next to the lean snapshot. */
export function writeDashboardRows(scanDate: string, result: unknown, resultsDir: string): string {
  const rows = rowsFromLeanResult(scanDate, result as never);
  const file = path.join(resultsDir, `dashboard-${scanDate}.json`);
  fs.writeFileSync(file, JSON.stringify(rows));
  return file;
}
