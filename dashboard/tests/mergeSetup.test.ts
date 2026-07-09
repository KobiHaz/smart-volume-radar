import { mergeSetupRows, mergeSummary, type SetupRowD1, type RsDailyRow } from '../src/mergeSetup.js';

const lean = (over: Record<string, unknown> = {}) => ({
  scan_date: '2026-07-10',
  ticker: 'NVDA',
  region: 'US',
  sector: 'Semiconductor',
  signal: 'pullback',
  signals: 'pullback',
  signal_count: 1,
  score: 80,
  rs: null as number | null,
  ...over,
});

const setup = (over: Partial<SetupRowD1> = {}): SetupRowD1 => ({
  scan_date: '2026-07-10',
  ticker: 'NVDA',
  region: 'US',
  sector: 'Semiconductor',
  sig: 'setupClose',
  rvol: 2.1,
  ath_pct: -1.5,
  day_pct: 0.8,
  stage2: 1,
  score: 90,
  price: 500,
  rs: 92,
  ingested_at: 'setup-daily x',
  ...over,
});

describe('mergeSetupRows', () => {
  it('appends the setup signal to an existing lean row (+confluence, rs)', () => {
    const [r] = mergeSetupRows([lean()], [setup()], []);
    expect(r!.signals).toBe('pullback,setupClose');
    expect(r!.signal_count).toBe(2);
    expect(r!.score).toBe(92); // 80 + 12
    expect(r!.rs).toBe(92);
    expect(r!.signal).toBe('pullback'); // setupClose does NOT take primary
  });

  it('setupFull / setupRecovery take the primary badge', () => {
    const [full] = mergeSetupRows([lean()], [setup({ sig: 'setupFull' })], []);
    expect(full!.signal).toBe('setupFull');
    const [rec] = mergeSetupRows([lean()], [setup({ sig: 'setupRecovery' })], []);
    expect(rec!.signal).toBe('setupRecovery');
  });

  it('creates a standalone row when no lean row exists for the ticker/day', () => {
    const rows = mergeSetupRows([lean()], [setup({ ticker: 'ARM', sig: 'setupFull' })], []);
    expect(rows).toHaveLength(2);
    const arm = rows.find((r) => r.ticker === 'ARM')!;
    expect(arm.signal).toBe('setupFull');
    expect(arm.signals).toBe('setupFull');
    expect(arm.signal_count).toBe(1);
    expect(arm.score).toBe(90);
  });

  it('is idempotent for backfilled dates (setup sig already in signals)', () => {
    const backfilled = lean({ signals: 'pullback,setupClose', signal_count: 2, score: 92, rs: 92 });
    const [r] = mergeSetupRows([backfilled], [setup()], []);
    expect(r!.signal_count).toBe(2);
    expect(r!.score).toBe(92); // unchanged — no double confluence
  });

  it('fills rs on lean rows from rs_daily without overriding existing rs', () => {
    const rsRows: RsDailyRow[] = [
      { scan_date: '2026-07-10', ticker: 'NVDA', rs: 77 },
      { scan_date: '2026-07-10', ticker: 'AMD', rs: 88 },
    ];
    const rows = mergeSetupRows([lean(), lean({ ticker: 'AMD', rs: 55 })], [], rsRows);
    expect(rows.find((r) => r.ticker === 'NVDA')!.rs).toBe(77);
    expect(rows.find((r) => r.ticker === 'AMD')!.rs).toBe(55); // kept
  });

  it('does not mutate the input rows', () => {
    const input = lean();
    mergeSetupRows([input], [setup()], []);
    expect(input.signals).toBe('pullback');
    expect(input.score).toBe(80);
  });
});

describe('mergeSummary', () => {
  it('adds setup counts and setup-only rows to the day total', () => {
    const merged = mergeSummary(
      [{ scan_date: '2026-07-10', total: 50, setup_full: 0, setup_other: 0, rs90: 0 }],
      [{ scan_date: '2026-07-10', setup_full: 2, setup_other: 5, setup_new: 4, rs90: 3 }],
    );
    expect(merged[0]).toMatchObject({ total: 54, setup_full: 2, setup_other: 5, rs90: 3 });
  });

  it('leaves dates without setup rows untouched (backfilled dates)', () => {
    const merged = mergeSummary(
      [{ scan_date: '2026-06-18', total: 90, setup_full: 8, setup_other: 12, rs90: 40 }],
      [{ scan_date: '2026-07-10', setup_full: 1, setup_other: 2, setup_new: 3, rs90: 1 }],
    );
    expect(merged[0]).toMatchObject({ total: 90, setup_full: 8, setup_other: 12, rs90: 40 });
  });
});
