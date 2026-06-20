const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTicker, findStock, leanBucketsFor, formatDeepDive } = require('../src/radarData.js');

test('normalizeTicker strips exchange prefix and TA/TW/T suffix, uppercases', () => {
  assert.equal(normalizeTicker('nvda'), 'NVDA');
  assert.equal(normalizeTicker('TASE:RMLI'), 'RMLI');
  assert.equal(normalizeTicker('DORL.TA'), 'DORL');
  assert.equal(normalizeTicker('6531.TW'), '6531');
  assert.equal(normalizeTicker(null), '');
});

test('findStock matches by normalized ticker', () => {
  const snap = { stocks: [{ ticker: 'NVDA' }, { ticker: 'DORL.TA' }] };
  assert.equal(findStock(snap, 'nvda').ticker, 'NVDA');
  assert.equal(findStock(snap, 'DORL').ticker, 'DORL.TA');
  assert.equal(findStock(snap, 'ZZZZ'), null);
  assert.equal(findStock(null, 'NVDA'), null);
});

test('leanBucketsFor lists buckets containing the ticker', () => {
  const lean = { detections: {
    highVolume: [{ ticker: 'CTRA' }],
    pullbacks: [{ ticker: 'DORL.TA' }],
    nearConsolidation: [{ ticker: 'NVDA' }],
  } };
  assert.deepEqual(leanBucketsFor(lean, 'NVDA'), ['nearConsolidation']);
  assert.deepEqual(leanBucketsFor(lean, 'DORL'), ['pullbacks']);
  assert.deepEqual(leanBucketsFor(null, 'NVDA'), []);
});

test('formatDeepDive includes key fields for a found stock', () => {
  const stock = {
    ticker: 'NVDA', lastPrice: 212.45, priceChange: 3.54, rvol: 0.9, pctFromAth: -9.88,
    action: 'PASS', breakoutStage: 'Pre-Pivot', championScore: 60, sector: 'AI - Chain', sectorRank: 2,
    momentum: { level: 'none', criteria: { rvolPass: false, stage2: true, lowRiskEntry: true,
      pivotBreakout: false, tightness: true, aboveGapAvwap: true, antsAccumulation: false, bigMoveToday: true } },
    tradePlan: { pivot: 235.74, buyZoneLow: 231.03, buyZoneHigh: 240.45, stopLoss: 203.79, riskPct: -4.08 },
    isHotStreak: true,
  };
  const out = formatDeepDive({ symbol: 'NVDA', stock, scanDate: '2026-06-15', leanBuckets: ['nearConsolidation'] });
  assert.match(out, /NVDA/);
  assert.match(out, /2026-06-15/);
  assert.match(out, /PASS/);
  assert.match(out, /Champion score: 60/);
  assert.match(out, /pivot 235\.74/);
  assert.match(out, /stage2/);            // a passing criterion is listed
  assert.match(out, /nearConsolidation/); // lean bucket shown
  assert.match(out, /hot-streak/);        // flag shown
});

test('formatDeepDive includes monitor status when entry present', () => {
  const stock = { ticker: 'NVDA', momentum: null, tradePlan: null };
  const out = formatDeepDive({ symbol: 'NVDA', stock, scanDate: '2026-06-15',
    monitorEntry: { status: 'graduated', firstAlertDate: '2026-05-01' } });
  assert.match(out, /Monitor: graduated/);
  assert.match(out, /since 2026-05-01/);
});

test('formatDeepDive returns a clean note when stock is missing', () => {
  const out = formatDeepDive({ symbol: 'ZZZZ', stock: null, scanDate: '2026-06-15' });
  assert.match(out, /ZZZZ/);
  assert.match(out, /not in latest radar snapshot/i);
  assert.match(out, /2026-06-15/);
});
