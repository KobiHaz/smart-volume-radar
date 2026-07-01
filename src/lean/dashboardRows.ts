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
  | 'breakout' | 'highVolume' | 'pullback'
  | 'nearBreakout' | 'nearHighVol' | 'nearPullback';

export interface Row {
  scanDate: string;     // 'YYYY-MM-DD'
  ticker: string;
  region: 'US' | 'TASE' | 'Foreign';
  sector: string;
  signal: SignalKind;
  rvol: number;
  athPct: number | null;
  dayPct: number;
  stage2: 0 | 1;
  distPivot: number | null;
  score: number;
  price: number;
}

const BASE: Record<SignalKind, number> = {
  breakout: 50, pullback: 40, highVolume: 35,
  nearBreakout: 25, nearHighVol: 15, nearPullback: 10,
};

type ScoreInput = Omit<Row, 'score'>;

export function scoreRow(r: ScoreInput): number {
  let s = BASE[r.signal];
  s += Math.min(r.rvol || 0, 6) * 5;
  if (r.stage2) s += 20;
  if (r.distPivot != null) s += Math.max(0, 10 - r.distPivot * 4);
  if (r.signal === 'highVolume' && (r.dayPct || 0) < 0) s -= 25;
  if (r.athPct != null && r.athPct < -30) s -= 20;
  if (isETFSector(r.sector)) s -= 12;
  return Math.round(s);
}

function isStage2(s: StockData): 0 | 1 {
  return s.lastPrice != null && s.sma50 != null && s.sma200 != null &&
    s.lastPrice > s.sma50 && s.sma50 > s.sma200 ? 1 : 0;
}

function buildRow(
  scanDate: string, stock: StockData, signal: SignalKind, distPivot: number | null,
): Row {
  const r: Omit<Row, 'score'> = {
    scanDate, ticker: stock.ticker.toUpperCase(), region: regionOf(stock.ticker),
    sector: stock.sector ?? 'Unknown', signal,
    rvol: stock.rvol ?? 0, athPct: stock.pctFromAth ?? null,
    dayPct: stock.priceChange ?? 0, stage2: isStage2(stock),
    distPivot, price: stock.lastPrice ?? 0,
  };
  return { ...r, score: scoreRow(r) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowsFromLeanResult(scanDate: string, result: any): Row[] {
  const rows: Row[] = [];
  for (const e of result.consolidationBreakouts) rows.push(buildRow(scanDate, e.stock, 'breakout', 0));
  for (const e of result.highVolume) rows.push(buildRow(scanDate, e.stock, 'highVolume', null));
  for (const e of result.pullbacks) rows.push(buildRow(scanDate, e.stock, 'pullback', null));
  for (const e of result.nearConsolidation) rows.push(buildRow(scanDate, e.stock, 'nearBreakout', e.signal.distanceToPivotPct));
  for (const e of result.nearVolume) rows.push(buildRow(scanDate, e.stock, 'nearHighVol', null));
  for (const e of result.nearPullback) rows.push(buildRow(scanDate, e.stock, 'nearPullback', null));
  return rows;
}
