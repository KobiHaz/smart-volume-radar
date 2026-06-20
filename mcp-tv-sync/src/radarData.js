'use strict';
const fs = require('fs');
const path = require('path');

const RADAR_RE = /^radar-\d{4}-\d{2}-\d{2}\.json$/; // excludes radar-reconstructed-*
const LEAN_RE = /^lean-\d{4}-\d{2}-\d{2}\.json$/;

function latestDatedFile(dir, re) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  const matches = files.filter((f) => re.test(f)).sort(); // YYYY-MM-DD sorts chronologically
  return matches.length ? path.join(dir, matches[matches.length - 1]) : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadLatestRadar(repoDir) {
  const f = latestDatedFile(path.join(repoDir, 'results'), RADAR_RE);
  return f ? readJson(f) : null;
}

function loadLatestLean(repoDir) {
  const f = latestDatedFile(path.join(repoDir, 'results'), LEAN_RE);
  return f ? readJson(f) : null;
}

/** Uppercase, strip a leading EXCHANGE: prefix and a trailing .TA/.TW/.T suffix. */
function normalizeTicker(s) {
  if (s == null) return '';
  let t = String(s).trim().toUpperCase();
  const colon = t.indexOf(':');
  if (colon >= 0) t = t.slice(colon + 1);
  return t.replace(/\.(TA|TW|T)$/, ''); // .TA=Tel Aviv, .TW=Taiwan, .T=Tokyo
}

function findStock(snapshot, symbol) {
  if (!snapshot || !Array.isArray(snapshot.stocks)) return null;
  const want = normalizeTicker(symbol);
  return snapshot.stocks.find((s) => normalizeTicker(s.ticker) === want) || null;
}

/** Names of the lean detection buckets that contain the ticker. */
function leanBucketsFor(lean, symbol) {
  if (!lean || !lean.detections) return [];
  const want = normalizeTicker(symbol);
  const out = [];
  for (const [bucket, arr] of Object.entries(lean.detections)) {
    if (Array.isArray(arr) && arr.some((e) => e && normalizeTicker(e.ticker) === want)) {
      out.push(bucket);
    }
  }
  return out;
}

function loadMonitorEntry(repoDir, symbol) {
  const m = readJson(path.join(repoDir, 'results', 'monitor-list.json'));
  if (!m || !Array.isArray(m.entries)) return null;
  const want = normalizeTicker(symbol);
  return m.entries.find((e) => e && normalizeTicker(e.ticker) === want) || null;
}

function fmtNum(n, digits = 2) {
  return typeof n === 'number' && isFinite(n) ? n.toFixed(digits) : '—';
}

/** Build a concise multi-line radar-state text block. Pure. */
function formatDeepDive({ symbol, stock, scanDate, leanBuckets = [], monitorEntry = null }) {
  if (!stock) {
    return `Radar state: ${symbol} not in latest radar snapshot` +
      (scanDate ? ` (${scanDate}).` : ' (no snapshot found).');
  }
  const lines = [];
  lines.push(`Radar state for ${stock.ticker} (snapshot ${scanDate || '?'}):`);
  lines.push(`• Price ${fmtNum(stock.lastPrice)} (${fmtNum(stock.priceChange)}% today) · RVOL ${fmtNum(stock.rvol)}x · ${fmtNum(stock.pctFromAth)}% from ATH`);
  lines.push(`• Action: ${stock.action ?? '—'} · Stage: ${stock.breakoutStage ?? '—'} · Champion score: ${stock.championScore ?? '—'}` +
    (stock.entryGrade ? ` · Entry grade: ${stock.entryGrade}` : ''));
  lines.push(`• Sector: ${stock.sector ?? '—'} (rank ${stock.sectorRank ?? '—'})`);
  const m = stock.momentum;
  if (m && m.criteria && typeof m.criteria === 'object' && !Array.isArray(m.criteria)) {
    const entries = Object.entries(m.criteria);
    const passed = entries.filter(([, v]) => v).map(([k]) => k);
    const failed = entries.filter(([, v]) => !v).map(([k]) => k);
    lines.push(`• Momentum: ${m.level ?? 'none'} — ${passed.length}/${entries.length} criteria`);
    lines.push(`   pass: ${passed.join(', ') || 'none'}`);
    lines.push(`   fail: ${failed.join(', ') || 'none'}`);
  }
  const tp = stock.tradePlan;
  if (tp) {
    lines.push(`• Trade plan: pivot ${fmtNum(tp.pivot)} · buy ${fmtNum(tp.buyZoneLow)}–${fmtNum(tp.buyZoneHigh)} · stop ${fmtNum(tp.stopLoss)} · risk ${fmtNum(tp.riskPct)}%`);
  }
  const flags = [];
  if (stock.isHotStreak) flags.push('hot-streak');
  if (stock.isFatigued) flags.push('fatigued');
  if (flags.length) lines.push(`• Flags: ${flags.join(', ')}`);
  if (leanBuckets.length) lines.push(`• Lean detections: ${leanBuckets.join(', ')}`);
  if (monitorEntry) {
    lines.push(`• Monitor: ${monitorEntry.status ?? 'tracked'}` +
      (monitorEntry.firstAlertDate ? ` since ${monitorEntry.firstAlertDate}` : ''));
  }
  return lines.join('\n');
}

module.exports = {
  loadLatestRadar, loadLatestLean, loadMonitorEntry,
  normalizeTicker, findStock, leanBucketsFor, formatDeepDive,
};
