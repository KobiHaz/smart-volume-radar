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
