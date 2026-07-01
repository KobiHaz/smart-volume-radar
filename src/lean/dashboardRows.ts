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
