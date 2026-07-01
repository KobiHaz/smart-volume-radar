const COLS = [
  ['ticker','טיקר'],['region','אזור'],['sector','סקטור'],['signal','סיגנל'],
  ['rvol','RVOL'],['ath_pct','ATH%'],['day_pct','יום%'],['stage2','S2'],
  ['dist_pivot','לפיבוט%'],['score','Score'],['price','מחיר'],
];
let rows = [], sortKey = 'score', sortDir = -1;

const $ = (s) => document.querySelector(s);
const num = (v) => (v == null ? '' : (typeof v === 'number' ? v : v));

async function load() {
  rows = await (await fetch('/api/signals')).json();
  const summary = await (await fetch('/api/summary')).json();
  renderCards(summary[0]);
  renderChart(rows);
  renderHead();
  renderBody();
}

function renderCards(s) {
  if (!s) return;
  const cards = [
    ['Total', s.total], ['📈 Breakout', s.breakout], ['🔥 HighVol', s.high_volume],
    ['📉 Pullback', s.pullback], ['⏳ Near', s.near_all], ['Score≥70', s.score70],
  ];
  $('#cards').innerHTML = cards.map(([l, v]) => `<div class="card"><span class="big">${v ?? 0}</span><small>${l}</small></div>`).join('');
  $('#day-picker').textContent = `📅 ${s.scan_date}`;
}

function renderChart(data) {
  const buckets = [0, 40, 55, 70, 85, 200];
  const labels = ['<40','40-55','55-70','70-85','85+'];
  const counts = labels.map(() => 0);
  for (const r of data) {
    for (let i = 0; i < buckets.length - 1; i++) {
      if (r.score >= buckets[i] && r.score < buckets[i + 1]) { counts[i]++; break; }
    }
  }
  if (window._chart) window._chart.destroy();
  window._chart = new Chart($('#dist-chart'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'התפלגות Score', data: counts, backgroundColor: '#1F3864' }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });
}

function renderHead() {
  $('#grid thead').innerHTML = '<tr>' + COLS.map(([k, label]) =>
    `<th data-k="${k}">${label}${sortKey === k ? (sortDir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('') + '</tr>';
  $('#grid thead').querySelectorAll('th').forEach((th) => th.onclick = () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; }
    renderHead(); renderBody();
  });
}

function visibleRows() {
  const q = $('#search').value.trim().toUpperCase();
  const reg = $('#f-region').value, sig = $('#f-signal').value, s2 = $('#f-stage2').checked;
  return rows.filter((r) =>
    (!q || r.ticker.includes(q)) && (!reg || r.region === reg) &&
    (!sig || r.signal === sig) && (!s2 || r.stage2 === 1))
    .sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      if (x == null) return 1; if (y == null) return -1;
      return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
    });
}

function scoreColor(s) { return s >= 85 ? '#63BE7B' : s >= 70 ? '#A9D08E' : s >= 55 ? '#FFEB84' : '#F8C9C9'; }

function renderBody() {
  $('#grid tbody').innerHTML = visibleRows().map((r) => '<tr>' + COLS.map(([k]) => {
    let v = r[k];
    if (k === 'stage2') v = v ? '✓' : '';
    else if (k === 'rvol') v = v != null ? v.toFixed(1) + 'x' : '';
    else if (k === 'ath_pct' || k === 'day_pct' || k === 'dist_pivot') v = v != null ? v.toFixed(1) + '%' : '';
    const style = k === 'score' ? ` style="background:${scoreColor(r.score)}"` : '';
    return `<td${style}>${v ?? ''}</td>`;
  }).join('') + '</tr>').join('');
  $('#grid tbody').querySelectorAll('tr').forEach((tr, i) => tr.onclick = () => deepDive(visibleRows()[i]));
}

function deepDive(r) {
  const tv = `https://www.tradingview.com/symbols/${r.ticker.replace('.', '-')}/`;
  $('#deepdive').hidden = false;
  $('#deepdive').innerHTML = `
    <button onclick="document.getElementById('deepdive').hidden=true">✕</button>
    <h2>${r.ticker}</h2>
    <p>${r.sector} · ${r.region}</p>
    <ul>
      <li>סיגנל: ${r.signal}</li><li>Score: <b>${r.score}</b></li>
      <li>RVOL: ${r.rvol?.toFixed(1)}x</li><li>ATH: ${r.ath_pct?.toFixed(1)}%</li>
      <li>יום: ${r.day_pct?.toFixed(1)}%</li><li>Stage2: ${r.stage2 ? '✓' : '✗'}</li>
      <li>מחיר: ${r.price}</li>
    </ul>
    <a href="${tv}" target="_blank">פתח ב-TradingView ↗</a>`;
}

['#search', '#f-region', '#f-signal', '#f-stage2'].forEach((s) =>
  $(s).addEventListener('input', renderBody));
load();
