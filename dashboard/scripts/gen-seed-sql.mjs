import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2] || path.resolve('../results');
const files = fs.readdirSync(dir).filter(f => /^dashboard-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const q = (v) => v == null ? 'NULL' : (typeof v === 'number' ? v : `'${String(v).replace(/'/g, "''")}'`);
const cols = '(scan_date,ticker,region,sector,signal,signals,signal_count,rvol,ath_pct,day_pct,stage2,dist_pivot,score,price)';
let out = [], total = 0;
for (const f of files) {
  const rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const vals = batch.map(r => `(${q(r.scanDate)},${q(r.ticker)},${q(r.region)},${q(r.sector)},${q(r.signal)},${q(r.signals.join(','))},${q(r.signalCount)},${q(r.rvol)},${q(r.athPct)},${q(r.dayPct)},${q(r.stage2)},${q(r.distPivot)},${q(r.score)},${q(r.price)})`).join(',');
    out.push(`INSERT OR REPLACE INTO lean_signals ${cols} VALUES ${vals};`);
    total += batch.length;
  }
}
fs.writeFileSync('seed.sql', out.join('\n'));
console.log(`Wrote seed.sql: ${total} rows from ${files.length} days, ${out.length} statements`);
