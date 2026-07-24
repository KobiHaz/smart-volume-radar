/**
 * Lean Radar Dashboard — app.js
 * Vanilla JS, no framework. RTL Hebrew UI.
 * Depends on: Chart.js (CDN), styles.css
 */

'use strict';

/* ─── Constants ──────────────────────────────────────────────────────────── */

const SIGNAL_META = {
  breakout:      { label: 'Breakout',     icon: '🎯', cls: 'breakout' },
  highVolume:    { label: 'High Volume',  icon: '🔥', cls: 'highVolume' },
  pullback:      { label: 'Pullback',     icon: '📉', cls: 'pullback' },
  creep:         { label: 'Creep',        icon: '🐢', cls: 'pullback' },
  nearBreakout:  { label: 'Near Break',   icon: '⏳', cls: 'near' },
  nearHighVol:   { label: 'Near HiVol',   icon: '⏳', cls: 'near' },
  nearPullback:  { label: 'Near Pull',    icon: '⏳', cls: 'near' },
  // Smart-Setup tiers (momentum-gated package, backfilled 2026-07-09)
  setupFull:     { label: 'Setup Full',   icon: '🎯', cls: 'breakout' },
  setupClose:    { label: 'Setup Close',  icon: '👀', cls: 'pullback' },
  setupRecovery: { label: 'Recovery',     icon: '🚀', cls: 'highVolume' },
};

/** Table column definitions: [key, hebrewLabel, cssClass] */
const COLS = [
  ['ticker',    'טיקר',      'col-ticker'],
  ['region',    'אזור',      'col-region'],
  ['sector',    'סקטור',     'col-sector'],
  ['signals',   'סיגנלים',   'col-signals'],
  ['rvol',      'RVOL',      'col-mono'],
  ['ath_pct',   'ATH%',      'col-mono'],
  ['day_pct',   'יום%',      'col-mono'],
  ['stage2',    'S2',        'col-mono'],
  ['rs',        'RS',        'col-mono'],
  ['score',     'Score',     'col-score'],
  ['price',     'מחיר',      'col-mono'],
];

const SCORE_BUCKETS = [-Infinity, 40, 55, 70, 85, Infinity];
const SCORE_LABELS  = ['<40', '40-55', '55-70', '70-85', '85+'];

/** Weekday labels, Sunday-first, Hebrew abbreviated */
const WEEKDAY_LABELS = ['אח', 'שנ', 'של', 'רב', 'חמ', 'שש', 'שב'];

/* ─── State ──────────────────────────────────────────────────────────────── */

/** @type {Array<object>} */
let allRows = [];
/** @type {Array<object>} */
let summaryDays = [];
/** @type {string|null} */
let selectedDate = null;
let sortKey = 'score';
let sortDir = -1; // -1 = descending
/** @type {Chart|null} */
let chart = null;
let fragChart = null;
/** Calendar view state: which month/year the popover is currently showing */
let calViewYear  = 0;
let calViewMonth = 0; // 0-11
/** Whether to include near-* rows (silent watchlist). Off by default. */
let showNear = false;

/* ─── DOM helpers ─────────────────────────────────────────────────────────── */

/**
 * @param {string} sel
 * @returns {HTMLElement}
 */
const $ = (sel) => document.querySelector(sel);

/**
 * @param {string} sel
 * @returns {NodeList}
 */
const $$ = (sel) => document.querySelectorAll(sel);

function showState(msg) {
  const el = $('#state-msg');
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/* ─── Signal badge helpers ────────────────────────────────────────────────── */

/**
 * Human-readable label for a signal key.
 * @param {string} name
 * @returns {string}
 */
function readableSignal(name) {
  return (SIGNAL_META[name] && SIGNAL_META[name].label) || name;
}

/**
 * Build badge HTML for a single signal name.
 * @param {string} name - signal key
 * @param {boolean} primary - true if this is the primary signal
 * @returns {string}
 */
function badgeHTML(name, primary) {
  const meta = SIGNAL_META[name] || { label: name, icon: '•', cls: 'near' };
  const cls = primary ? `badge badge--${meta.cls} badge--primary` : `badge badge--${meta.cls}`;
  return `<span class="${cls}" title="${meta.label}">${meta.icon} ${meta.label}</span>`;
}

/**
 * Render the full badge group for a row.
 * Includes graduation badge, streak chip, and ×N tooltip.
 * @param {object} row
 * @returns {string}
 */
function signalBadgesHTML(row) {
  const primary = (row.signal || '').trim();
  const allSigs = row.signals
    ? row.signals.split(',').map((s) => s.trim()).filter(Boolean)
    : (primary ? [primary] : []);

  // De-duplicate: primary first, then extras
  const extras = allSigs.filter((s) => s !== primary);
  const count = row.signal_count || allSigs.length;

  let html = '<span class="badges">';

  // Graduation badge first — highest priority
  if (row.graduated_from) {
    const fromLabel = readableSignal(row.graduated_from);
    html += `<span class="badge badge--grad" title="Graduated from ${fromLabel}">🎓 ← ${fromLabel}</span>`;
  }

  if (primary) html += badgeHTML(primary, true);
  for (const s of extras) html += badgeHTML(s, false);

  // ×N confluence tag with full signal list in title
  if (count > 1) {
    const sigList = allSigs.map(readableSignal).join(' · ');
    html += `<span class="conf-tag" title="${sigList}">×${count}</span>`;
  }

  // Streak chip (streak > 1 only)
  if (row.streak && row.streak > 1) {
    html += `<span class="streak-chip" title="${row.streak} ימים ברצף">📅 ${row.streak}d</span>`;
  }

  html += '</span>';
  return html;
}

/* ─── Score delta ─────────────────────────────────────────────────────────── */

/**
 * Render score delta indicator HTML.
 * @param {number|null|undefined} delta
 * @returns {string}
 */
function scoreDeltaHTML(delta) {
  if (delta === null || delta === undefined) {
    return '<span class="delta-new" title="סיגנל חדש היום">🆕</span>';
  }
  if (delta > 0)  return `<span class="delta-up" title="עלייה ב-${delta} נק׳">▲${delta}</span>`;
  if (delta < 0)  return `<span class="delta-down" title="ירידה ב-${Math.abs(delta)} נק׳">▼${Math.abs(delta)}</span>`;
  return '';
}

/* ─── Score color ─────────────────────────────────────────────────────────── */

/**
 * Returns a background-color CSS value for a score.
 * Uses dark-appropriate muted tones.
 * @param {number|null} s
 * @returns {string}
 */
function scoreBg(s) {
  if (s == null) return 'transparent';
  if (s >= 85)  return 'rgba(63,185,80,0.32)';
  if (s >= 70)  return 'rgba(63,185,80,0.18)';
  if (s >= 55)  return 'rgba(210,153,34,0.22)';
  return 'rgba(248,81,73,0.20)';
}

/**
 * Returns a foreground color for a score badge (used in card list).
 * @param {number|null} s
 * @returns {string}
 */
function scoreColor(s) {
  if (s == null) return '#8b95a5';
  if (s >= 70)  return '#3fb950';
  if (s >= 55)  return '#d29922';
  return '#f85149';
}

/* ─── Number formatting ───────────────────────────────────────────────────── */

/** @returns {string} */
function fmtPct(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

/** @returns {string} */
function fmtPctClass(v) {
  if (v == null) return 'num-neu';
  const n = Number(v);
  if (n > 0)  return 'num-up';
  if (n < 0)  return 'num-down';
  return 'num-neu';
}

/** @returns {string} */
function fmtRvol(v) {
  if (v == null) return '—';
  return Number(v).toFixed(1) + 'x';
}

/** @returns {string} */
function fmtPrice(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/* ─── Calendar popover ────────────────────────────────────────────────────── */

/**
 * Build a Set of dates that have data, and a Map of date → summary row.
 * Populated once summaryDays is loaded.
 * @type {Map<string, object>}
 */
let summaryByDate = new Map();

function buildSummaryIndex() {
  summaryByDate = new Map();
  for (const d of summaryDays) {
    summaryByDate.set(d.scan_date, d);
  }
}

/**
 * Render the calendar grid for calViewYear / calViewMonth.
 */
function renderCalendar() {
  const popover = $('#cal-popover');
  const grid    = $('#cal-grid');
  const label   = $('#cal-month-label');

  const monthNames = [
    'ינואר','פברואר','מרץ','אפריל','מאי','יוני',
    'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר',
  ];
  label.textContent = `${monthNames[calViewMonth]} ${calViewYear}`;

  // Render weekday header if not yet done (idempotent)
  const wdRow = popover.querySelector('.cal-weekdays');
  if (wdRow && !wdRow.children.length) {
    wdRow.innerHTML = WEEKDAY_LABELS.map(
      (d) => `<span class="cal-wd">${d}</span>`
    ).join('');
  }

  // First day of month (0=Sun)
  const firstDow = new Date(calViewYear, calViewMonth, 1).getDay();
  // Total days in month
  const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();

  let html = '';

  // Leading empty cells
  for (let i = 0; i < firstDow; i++) {
    html += '<div class="cal-day cal-day--empty" aria-hidden="true"></div>';
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const mm   = String(calViewMonth + 1).padStart(2, '0');
    const dd   = String(d).padStart(2, '0');
    const iso  = `${calViewYear}-${mm}-${dd}`;
    const summ = summaryByDate.get(iso);
    const hasData  = !!summ;
    const selected = iso === selectedDate;
    const has70    = hasData && (summ.score70 || 0) > 0;

    if (hasData) {
      html += `
        <div
          class="cal-day"
          data-has-data="true"
          data-date="${iso}"
          data-selected="${selected}"
          role="gridcell"
          tabindex="${selected ? '0' : '-1'}"
          aria-label="${iso}, ${summ.total} סיגנלים${has70 ? `, Score≥70: ${summ.score70}` : ''}"
          aria-pressed="${selected}"
        >
          <span>${d}</span>
          <span class="cal-day-count">${summ.total}</span>
          ${has70 ? '<span class="cal-day-dot" aria-hidden="true"></span>' : ''}
        </div>`;
    } else {
      html += `
        <div
          class="cal-day"
          data-has-data="false"
          aria-hidden="true"
          aria-label="${iso} — אין נתונים"
        ><span>${d}</span></div>`;
    }
  }

  grid.innerHTML = html;

  // Attach click handlers
  grid.querySelectorAll('.cal-day[data-has-data="true"]').forEach((cell) => {
    cell.addEventListener('click', () => {
      closeCalPopover();
      selectDay(cell.dataset.date);
    });
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        closeCalPopover();
        selectDay(cell.dataset.date);
      }
    });
  });
}

function openCalPopover() {
  const popover = $('#cal-popover');
  const btn     = $('#btn-date-picker');
  popover.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  // Ensure we're viewing the month of the selected date
  if (selectedDate) {
    const parts = selectedDate.split('-');
    calViewYear  = parseInt(parts[0], 10);
    calViewMonth = parseInt(parts[1], 10) - 1;
  }
  renderCalendar();
  // Focus the selected day or first data day in view
  const selected = popover.querySelector('.cal-day[data-selected="true"]');
  if (selected) selected.focus();
}

function closeCalPopover() {
  const popover = $('#cal-popover');
  const btn     = $('#btn-date-picker');
  popover.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
}

function toggleCalPopover() {
  const popover = $('#cal-popover');
  if (popover.hidden) {
    openCalPopover();
  } else {
    closeCalPopover();
  }
}

/**
 * Move to the adjacent data-day (offset = -1 for prev, +1 for next).
 * @param {number} offset
 */
function stepDay(offset) {
  if (!summaryDays.length) return;
  // summaryDays is newest-first per API contract
  const idx = summaryDays.findIndex((d) => d.scan_date === selectedDate);
  if (idx === -1) return;
  const next = idx - offset; // newest-first means subtract to go forward
  if (next < 0 || next >= summaryDays.length) return;
  selectDay(summaryDays[next].scan_date);
}

function updateNavButtons() {
  const idx = summaryDays.findIndex((d) => d.scan_date === selectedDate);
  const btnPrev = $('#btn-prev-day');
  const btnNext = $('#btn-next-day');
  // prev = older day = higher index (newest-first array)
  btnPrev.disabled = idx === -1 || idx >= summaryDays.length - 1;
  // next = newer day = lower index
  btnNext.disabled = idx <= 0;
}

/* ─── Summary cards ───────────────────────────────────────────────────────── */

function renderCards() {
  const s = summaryDays.find((d) => d.scan_date === selectedDate);
  const container = $('#cards');
  if (!s) { container.innerHTML = ''; return; }

  const defs = [
    ['סה"כ',     s.total,        ''],
    ['🎯 Setup Full', s.setup_full, 'stat-card--highlight'],
    ['👀 Setup/Rec', s.setup_other, ''],
    ['📈 Breakout', s.breakout,  ''],
    ['🔥 High Vol', s.high_volume, ''],
    ['📉 Pullback', s.pullback,  ''],
    ['🐢 Creep',  s.creep,       ''],
    ['⏳ Near',   s.near_all,    ''],
    ['RS≥90 🔥', s.rs90,         'stat-card--accent'],
    ['Score≥70', s.score70,      ''],
  ];

  container.innerHTML = defs.map(([lbl, val, extra]) => `
    <div class="stat-card ${extra}" role="listitem">
      <span class="stat-card-val">${val ?? 0}</span>
      <span class="stat-card-lbl">${lbl}</span>
    </div>`).join('');
}

/* ─── Chart ───────────────────────────────────────────────────────────────── */

function renderChart() {
  const counts = SCORE_LABELS.map(() => 0);
  for (const r of allRows) {
    const s = r.score;
    if (s == null) continue;
    for (let i = 0; i < SCORE_BUCKETS.length - 1; i++) {
      if (s >= SCORE_BUCKETS[i] && s < SCORE_BUCKETS[i + 1]) { counts[i]++; break; }
    }
  }

  if (chart) { chart.destroy(); chart = null; }

  const ctx = $('#dist-chart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: SCORE_LABELS,
      datasets: [{
        label: 'ציונים',
        data: counts,
        backgroundColor: [
          'rgba(248,81,73,0.55)',
          'rgba(210,153,34,0.55)',
          'rgba(210,153,34,0.70)',
          'rgba(63,185,80,0.55)',
          'rgba(63,185,80,0.80)',
        ],
        borderColor: 'transparent',
        borderRadius: 3,
      }],
    },
    options: {
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1b2130',
          borderColor: '#242c3a',
          borderWidth: 1,
          titleColor: '#e6edf3',
          bodyColor: '#8b95a5',
        },
      },
      scales: {
        x: {
          ticks: { color: '#8b95a5', font: { size: 10, family: 'ui-monospace, monospace' } },
          grid:  { color: '#242c3a' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#8b95a5', font: { size: 10 }, stepSize: 1 },
          grid:  { color: '#242c3a' },
        },
      },
    },
  });
}

/* ─── Purple Fragility chart ──────────────────────────────────────────────── */

/**
 * Load the Purple List fragility series (written daily by the Smart pipeline)
 * and render it as a line chart with the 1.0 warning threshold. The series is
 * global (not per selected day) — loaded once at boot. Hidden when empty.
 */
async function loadFragility() {
  let rows = [];
  try {
    const resp = await fetch('/api/fragility');
    if (resp.ok) rows = await resp.json();
  } catch { /* keep panel hidden */ }
  if (!Array.isArray(rows) || rows.length === 0) return;
  $('#fragility-wrap').hidden = false;
  renderFragilityChart(rows);
}

function renderFragilityChart(rows) {
  if (fragChart) { fragChart.destroy(); fragChart = null; }
  const labels = rows.map((r) => r.scan_date.slice(5)); // MM-DD
  const scores = rows.map((r) => r.score);
  const capitulation = rows.map((r) => r.capitulation ?? null);
  const hasCapitulation = capitulation.some((v) => v != null);
  const threshold = rows.map(() => 1.0);

  const ctx = $('#fragility-chart').getContext('2d');
  fragChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Fragility (אופוריה)',
          data: scores,
          borderColor: 'rgba(163,113,247,0.95)',
          backgroundColor: 'rgba(163,113,247,0.12)',
          borderWidth: 1.6,
          pointRadius: 0,
          pointHitRadius: 6,
          tension: 0.25,
          fill: false,
        },
        // Capitulation Score (מד המיצוי) — bottom-detection companion, descriptive
        // only. No threshold line for it: our own validation (see explainer tab)
        // found no reliable action level, unlike the Fragility score's 1.0.
        {
          label: 'Capitulation (מיצוי)',
          data: capitulation,
          borderColor: 'rgba(88,196,220,0.95)',
          backgroundColor: 'rgba(88,196,220,0.10)',
          borderWidth: 1.6,
          pointRadius: 0,
          pointHitRadius: 6,
          tension: 0.25,
          fill: false,
          hidden: !hasCapitulation,
        },
        // Reference line only — the real 🔴 alert also requires the basket to be
        // near its own running high (indexNearHigh, not persisted per-day here),
        // so a score crossing 1.0 on this chart isn't identical to a real alert
        // having fired. See the tooltip / explainer tab for the full rule.
        {
          label: 'סף 1.0 (ייחוס — לא הכלל המלא)',
          data: threshold,
          borderColor: 'rgba(248,81,73,0.7)',
          borderWidth: 1,
          borderDash: [5, 4],
          pointRadius: 0,
          pointHitRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: '#8b95a5',
            font: { size: 10 },
            boxWidth: 12,
            filter: (item) => item.text !== 'סף 1.0 (ייחוס — לא הכלל המלא)',
          },
        },
        tooltip: {
          backgroundColor: '#1b2130',
          borderColor: '#242c3a',
          borderWidth: 1,
          titleColor: '#e6edf3',
          bodyColor: '#8b95a5',
          filter: (item) => item.datasetIndex === 0 || item.datasetIndex === 1,
          callbacks: {
            title: (items) => (items[0] ? rows[items[0].dataIndex].scan_date : ''),
            label: (item) => {
              const r = rows[item.dataIndex];
              const z = (v) => (v == null ? '—' : v.toFixed(1));
              if (item.datasetIndex === 1) {
                return r.capitulation == null
                  ? 'Capitulation: —'
                  : `Capitulation: ${r.capitulation.toFixed(2)} (תיאורי בלבד, לא טריגר)`;
              }
              return [
                `ציון: ${r.score.toFixed(2)}  |  core3: ${z(r.core3)}  |  climax: ${z(r.climax)}`,
                `DD: ${r.drawdown_pct == null ? '—' : r.drawdown_pct.toFixed(1) + '%'}` +
                  (r.canary_count != null ? ` | Canary: ${r.canary_count}` : ''),
                `wick ${z(r.wick10_z)} | %>50 ${z(r.pct_above50_z)} | dist ${z(r.dist20_z)}`,
                `ext ${z(r.ext50_z)} | corr ${z(r.corr20_z)} | disp ${z(r.disp10_z)}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#8b95a5',
            font: { size: 9, family: 'ui-monospace, monospace' },
            maxTicksLimit: 12,
            maxRotation: 0,
          },
          grid: { color: '#242c3a' },
        },
        y: {
          ticks: { color: '#8b95a5', font: { size: 10 } },
          grid: { color: '#242c3a' },
        },
      },
    },
  });
}

/* ─── Filtering / sorting ─────────────────────────────────────────────────── */

/**
 * Returns true if the row's primary signal is a "near" (silent watchlist) tier.
 * @param {object} r
 * @returns {boolean}
 */
function isNearRow(r) {
  return (r.signal || '').startsWith('near');
}

/** Count of rows hidden ONLY by the near-tier default filter (set by visibleRows). */
let hiddenNearCount = 0;
/** Count of near-tier rows currently visible (set by visibleRows) — drives the collapse label. */
let shownNearCount = 0;

function visibleRows() {
  const q    = ($('#search').value || '').trim().toUpperCase();
  const reg  = $('#f-region').value;
  const sig  = $('#f-signal').value;
  const s2   = $('#f-stage2').checked;
  const grad = $('#f-grad').checked;

  hiddenNearCount = 0;

  const filtered = allRows.filter((r) => {
    if (q    && !(r.ticker || '').toUpperCase().includes(q)) return false;
    if (reg  && r.region !== reg)   return false;
    // Match against the FULL signals list, not just the primary — merged rows
    // (e.g. "pullback,setupClose") must be findable by any of their signals.
    if (sig && r.signal !== sig &&
        !(r.signals || '').split(',').map((s) => s.trim()).includes(sig)) return false;
    if (s2   && r.stage2 !== 1)     return false;
    if (grad && !r.graduated_from)  return false;

    // Near-tier filter: hide near-* rows unless showNear is on OR the user
    // explicitly selected a near signal from the dropdown. Counted after the
    // other filters so the "show more" button reports how many rows it reveals.
    const nearExplicit = sig.startsWith('near');
    if (!showNear && !nearExplicit && isNearRow(r)) {
      hiddenNearCount++;
      return false;
    }
    return true;
  });

  shownNearCount = filtered.filter(isNearRow).length;

  return filtered.sort((a, b) => {
    let x = a[sortKey], y = b[sortKey];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string') x = x.toLowerCase();
    if (typeof y === 'string') y = y.toLowerCase();
    return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
  });
}

/* ─── Table head ──────────────────────────────────────────────────────────── */

function renderHead() {
  const head = $('#grid-head');
  head.innerHTML = '<tr>' + COLS.map(([k, lbl]) => {
    const sorted = sortKey === k;
    const arrow  = sorted ? (sortDir < 0 ? ' ↓' : ' ↑') : '';
    const aSort  = sorted ? (sortDir < 0 ? 'descending' : 'ascending') : 'none';
    return `<th data-k="${k}" scope="col" aria-sort="${aSort}">${lbl}${arrow}</th>`;
  }).join('') + '</tr>';

  head.querySelectorAll('th').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (sortKey === k) sortDir *= -1;
      else { sortKey = k; sortDir = -1; }
      renderTable();
    });
  });
}

/* ─── Table body ──────────────────────────────────────────────────────────── */

function renderTable() {
  renderHead();

  const vr = visibleRows();
  const total = allRows.length;
  $('#row-count').textContent = vr.length === total
    ? `${vr.length} שורות`
    : `${vr.length} מוצגות מתוך ${total}`;
  showState(vr.length === 0 && !hiddenNearCount ? 'אין תוצאות לסינון הנוכחי' : null);
  renderShowMore();

  /* — desktop table — */
  const tbody = $('#grid-body');
  tbody.innerHTML = vr.map((r, i) => {
    const conf = (r.signal_count > 1) || false;
    const grad = !!r.graduated_from;

    const tds = COLS.map(([k, , cls]) => {
      let inner = '';
      let extraCls = cls;

      switch (k) {
        case 'ticker':
          inner = r.ticker || '';
          break;
        case 'region':
          inner = r.region || '';
          break;
        case 'sector':
          inner = (r.sector || '').slice(0, 22); // truncate long sector names
          break;
        case 'signals':
          inner = signalBadgesHTML(r);
          break;
        case 'rvol':
          inner = fmtRvol(r.rvol);
          break;
        case 'ath_pct':
          inner = `<span class="${fmtPctClass(r.ath_pct)}">${fmtPct(r.ath_pct)}</span>`;
          break;
        case 'day_pct':
          inner = `<span class="${fmtPctClass(r.day_pct)}">${fmtPct(r.day_pct)}</span>`;
          break;
        case 'stage2':
          inner = r.stage2 ? '<span class="num-up" title="Stage 2">✓</span>' : '';
          break;
        case 'rs': {
          // RS percentile — the ranking metric that survived the 2y score study.
          if (r.rs == null) return `<td class="${cls}" data-v="-1">—</td>`;
          const flame = r.rs >= 90 ? ' 🔥' : '';
          return `<td class="${cls}" data-v="${r.rs}"><span class="${r.rs >= 90 ? 'num-up' : ''}">${r.rs}${flame}</span></td>`;
        }
        case 'score': {
          const bg    = scoreBg(r.score);
          const delta = scoreDeltaHTML(r.score_delta);
          return `<td class="${cls}" style="background:${bg}" data-v="${r.score ?? -1}">${r.score ?? '—'}${delta}</td>`;
        }
        case 'price':
          inner = fmtPrice(r.price);
          break;
        default:
          inner = r[k] ?? '';
      }
      return `<td class="${extraCls}">${inner}</td>`;
    }).join('');

    // grad wins over conf for the data attribute — CSS uses data-grad first
    return `<tr data-i="${i}" data-conf="${conf}" data-grad="${grad}" tabindex="0" role="row">${tds}</tr>`;
  }).join('');

  /* attach row click handlers */
  tbody.querySelectorAll('tr').forEach((tr) => {
    const idx = parseInt(tr.dataset.i, 10);
    tr.addEventListener('click', () => openDeepDive(vr[idx]));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openDeepDive(vr[idx]); });
  });

  /* — mobile card list — */
  const cardList = $('#card-list');
  cardList.innerHTML = vr.map((r, i) => {
    const conf  = (r.signal_count > 1) || false;
    const grad  = !!r.graduated_from;
    const sc    = r.score ?? null;
    const scBg  = scoreBg(sc);
    const scClr = scoreColor(sc);
    const delta = scoreDeltaHTML(r.score_delta);
    return `
      <div
        class="signal-card"
        data-i="${i}"
        data-conf="${conf}"
        data-grad="${grad}"
        tabindex="0"
        role="button"
        aria-label="${r.ticker}, ציון ${sc ?? '—'}"
      >
        <div class="sc-top">
          <span class="sc-ticker">${r.ticker || ''}</span>
          <span class="sc-score-badge" style="background:${scBg};color:${scClr}">Score ${sc ?? '—'}${delta}</span>
        </div>
        <div class="sc-badges">${signalBadgesHTML(r)}</div>
        <div class="sc-grid">
          <div class="sc-kv"><span class="sc-k">RVOL</span><span class="sc-v">${fmtRvol(r.rvol)}</span></div>
          <div class="sc-kv"><span class="sc-k">יום%</span><span class="sc-v ${fmtPctClass(r.day_pct)}">${fmtPct(r.day_pct)}</span></div>
          <div class="sc-kv"><span class="sc-k">ATH%</span><span class="sc-v ${fmtPctClass(r.ath_pct)}">${fmtPct(r.ath_pct)}</span></div>
          <div class="sc-kv"><span class="sc-k">מחיר</span><span class="sc-v">${fmtPrice(r.price)}</span></div>
          <div class="sc-kv"><span class="sc-k">RS</span><span class="sc-v ${(r.rs ?? 0) >= 90 ? 'num-up' : ''}">${r.rs != null ? r.rs + (r.rs >= 90 ? ' 🔥' : '') : '—'}</span></div>
          <div class="sc-kv"><span class="sc-k">S2</span><span class="sc-v ${r.stage2 ? 'num-up' : ''}">${r.stage2 ? '✓' : '—'}</span></div>
        </div>
      </div>`;
  }).join('');

  cardList.querySelectorAll('.signal-card').forEach((card) => {
    const idx = parseInt(card.dataset.i, 10);
    card.addEventListener('click', () => openDeepDive(vr[idx]));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openDeepDive(vr[idx]); });
  });
}

/* ─── Show-more (near tier) ───────────────────────────────────────────────── */

/**
 * Render the near-tier toggle button under the table. While near rows are
 * hidden it offers to load them; once loaded it flips to a collapse action
 * (kept in sync with the #f-near checkbox). Hidden when a near signal is
 * explicitly selected in the dropdown (nothing to toggle) or no near rows
 * exist for the current filters.
 */
function renderShowMore() {
  const wrap = $('#show-more-wrap');
  const btn  = $('#btn-show-more');
  if (!wrap || !btn) return;

  if (hiddenNearCount > 0) {
    btn.textContent = `⏳ טען עוד ${hiddenNearCount} ניירות — רשימת מעקב שקטה (Near)`;
    wrap.hidden = false;
  } else if (showNear && shownNearCount > 0) {
    btn.textContent = `🔼 הסתר ${shownNearCount} ניירות — רשימת מעקב שקטה (Near)`;
    wrap.hidden = false;
  } else {
    wrap.hidden = true;
  }
}

/* ─── Deep-dive panel ─────────────────────────────────────────────────────── */

/** BASE points per signal kind — client-side mirror of dashboardRows.scoreRow
 *  (lean kinds) and the setup-backfill scoring (setup kinds). */
const SCORE_BASE = {
  pullback: 50, creep: 42, nearPullback: 38, highVolume: 30,
  nearHighVol: 18, breakout: 12, nearBreakout: 8,
  setupFull: 60, setupRecovery: 55, setupClose: 40,
};

/**
 * Itemized score breakdown for the deep-dive. Mirrors the server formulas;
 * any drift (regime bonus, historic formula versions) lands in a residual
 * line so the items always sum to the actual score.
 * @returns {Array<[string, number]>}
 */
function scoreBreakdown(r) {
  const sigs = (r.signals || r.signal || '').split(',').map((s) => s.trim()).filter(Boolean);
  const isSetupOnly = sigs.length > 0 && sigs.every((s) => s.startsWith('setup'));
  const items = [];
  const rvolTerm = Math.min(r.rvol || 0, 6) * 5;

  if (isSetupOnly) {
    // Setup-backfill rows: BASE + min(RVOL,6)*5 + Stage2 + RS>=90 bonus.
    const base = Math.max(...sigs.map((s) => SCORE_BASE[s] ?? 0));
    items.push([`בסיס ${readableSignal(sigs[0])}`, base]);
    items.push(['RVOL ×5 (עד 30)', Math.round(rvolTerm)]);
    if (r.stage2) items.push(['Stage 2', 20]);
    if ((r.rs ?? 0) >= 90) items.push(['RS ≥ 90 🔥', 10]);
  } else {
    const leanSigs = sigs.filter((s) => !s.startsWith('setup'));
    const base = Math.max(...leanSigs.map((s) => SCORE_BASE[s] ?? 0), 0);
    const strongest = leanSigs.find((s) => (SCORE_BASE[s] ?? 0) === base) || leanSigs[0] || '';
    items.push([`בסיס ${readableSignal(strongest)}`, base]);
    items.push(['RVOL ×5 (עד 30)', Math.round(rvolTerm)]);
    if (r.stage2) items.push(['Stage 2', 20]);
    if (r.dist_pivot != null) {
      const piv = Math.max(0, 10 - r.dist_pivot * 4);
      if (piv > 0) items.push(['קרבה לפיבוט', Math.round(piv)]);
    }
    if (sigs.length > 1) items.push([`קונפלואנס ×${sigs.length}`, (sigs.length - 1) * 12]);
    if (leanSigs.includes('highVolume') && (r.day_pct || 0) < 0) items.push(['ווליום על ירידה (climax)', -25]);
    if ((r.rvol || 0) >= 8) items.push(['RVOL ≥ 8 (אזהרת climax)', -15]);
    if (r.ath_pct != null && r.ath_pct < -30) items.push(['עמוק מתחת לשיא (>30%-)', -20]);
    if (/ETF/i.test(r.sector || '')) items.push(['ETF', -12]);
  }

  const sum = items.reduce((a, [, v]) => a + v, 0);
  const resid = Math.round((r.score ?? sum) - sum);
  if (resid !== 0) items.push(['אחר (רג\'ים / עיגול)', resid]);
  return items;
}

function scoreBreakdownHTML(r) {
  if (r.score == null) return '';
  const rows = scoreBreakdown(r).map(([label, pts]) => {
    const cls = pts >= 0 ? 'num-up' : 'num-down';
    const sign = pts >= 0 ? '+' : '';
    return `<div class="dd-kv"><div class="dd-k">${label}</div><div class="dd-v ${cls}">${sign}${pts}</div></div>`;
  }).join('');
  return `
    <div class="dd-sub" style="margin-top:14px">פירוק הציון (${r.score})</div>
    <div class="dd-grid">${rows}</div>`;
}

function openDeepDive(r) {
  const tvSymbol = (r.ticker || '').replace(/\./g, '-');
  const tvUrl    = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`;

  // Graduation banner
  const gradBanner = r.graduated_from
    ? `<div class="dd-grad-banner" role="note" aria-label="Graduation">
        🎓 Graduated from: ${readableSignal(r.graduated_from)}
       </div>`
    : '';

  // Score delta for deep-dive
  const deltaHtml = scoreDeltaHTML(r.score_delta);

  // Streak note
  const streakNote = (r.streak && r.streak > 1)
    ? `<span class="streak-chip" title="${r.streak} ימים ברצף">📅 ${r.streak}d ברצף</span>`
    : '';

  const pairs = [
    ['Score',  `${r.score ?? '—'}${deltaHtml ? ' ' + deltaHtml.replace(/class="delta-/g, 'class="delta-') : ''}`],
    ['RS',     r.rs != null ? `${r.rs}${r.rs >= 90 ? ' 🔥' : ''}` : '—'],
    ['RVOL',   fmtRvol(r.rvol)],
    ['ATH%',   fmtPct(r.ath_pct)],
    ['יום%',   fmtPct(r.day_pct)],
    ['לפיבוט', r.dist_pivot != null ? fmtPct(r.dist_pivot) : '—'],
    ['מחיר',   fmtPrice(r.price)],
    ['Stage2', r.stage2 ? '✓ כן' : '✗ לא'],
    ['אזור',   r.region || '—'],
  ];

  if (r.streak && r.streak > 1) {
    pairs.push(['Streak', `${r.streak} ימים`]);
  }

  if (r.graduated_from) {
    pairs.push(['Graduated', readableSignal(r.graduated_from)]);
  }

  const gridHTML = pairs.map(([k, v]) => `
    <div class="dd-kv">
      <div class="dd-k">${k}</div>
      <div class="dd-v">${v}</div>
    </div>`).join('');

  $('#deepdive-inner').innerHTML = `
    <button class="btn-close" id="btn-close-dd" aria-label="סגור פאנל">✕</button>
    ${gradBanner}
    <div class="dd-ticker">${r.ticker || ''} ${streakNote}</div>
    <div class="dd-sub">${r.sector || ''} · ${r.region || ''}</div>
    <div class="dd-badges">${signalBadgesHTML(r)}</div>
    <div class="dd-grid">${gridHTML}</div>
    ${scoreBreakdownHTML(r)}
    <a class="dd-tv-link" href="${tvUrl}" target="_blank" rel="noopener noreferrer">
      פתח ב-TradingView ↗
    </a>`;

  const panel   = $('#deepdive');
  const overlay = $('#deepdive-overlay');
  panel.hidden   = false;
  overlay.hidden = false;
  overlay.removeAttribute('aria-hidden');

  // move focus into panel
  panel.querySelector('#btn-close-dd').addEventListener('click', closeDeepDive);
  overlay.addEventListener('click', closeDeepDive, { once: true });

  // trap Escape
  panel._escHandler = (e) => { if (e.key === 'Escape') closeDeepDive(); };
  document.addEventListener('keydown', panel._escHandler);
}

function closeDeepDive() {
  const panel   = $('#deepdive');
  const overlay = $('#deepdive-overlay');
  panel.hidden   = true;
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  if (panel._escHandler) {
    document.removeEventListener('keydown', panel._escHandler);
    panel._escHandler = null;
  }
}

/* ─── Day selection ───────────────────────────────────────────────────────── */

async function selectDay(date) {
  if (date === selectedDate) return;
  selectedDate = date;

  // Update date picker button label
  $('#selected-date').textContent = date || '—';

  // Update nav button states
  updateNavButtons();

  showState('טוען…');
  try {
    const url = date ? `/api/signals?from=${date}&to=${date}` : '/api/signals';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    allRows = await resp.json();
  } catch (err) {
    showState(`שגיאה בטעינת נתונים: ${err.message}`);
    allRows = [];
  }

  renderCards();
  renderChart();
  renderTable();
  updateHeaderMeta();
}

/* ─── Header meta ─────────────────────────────────────────────────────────── */

/** Format an ISO run timestamp for display in Israel time, e.g. "23:15 07.07". */
function fmtRunTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('hour')}:${g('minute')} ${g('day')}.${g('month')}`;
}

function updateHeaderMeta() {
  const s = summaryDays.find((d) => d.scan_date === selectedDate);
  if (!s) { $('#header-meta').textContent = ''; return; }
  const run = fmtRunTime(s.last_run);
  const runPart = run ? ` · ריצה אחרונה: ${run}` : '';
  $('#header-meta').textContent = `${s.total} סיגנלים · Score≥70: ${s.score70 ?? 0}${runPart}`;
}

/* ─── Tab switching ───────────────────────────────────────────────────────── */

/**
 * Switch between the signals view and the explainer view.
 * @param {'signals'|'explainer'} name
 */
function switchTab(name) {
  const tabs  = ['signals', 'explainer'];
  for (const t of tabs) {
    const btn  = $(`#tab-${t}`);
    const view = $(`#view-${t}`);
    const active = t === name;
    btn.classList.toggle('header-tab--active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    view.hidden = !active;
  }
}

/* ─── Boot ────────────────────────────────────────────────────────────────── */

async function boot() {
  // Wire filter controls
  ['#search', '#f-region', '#f-signal', '#f-stage2', '#f-grad'].forEach((sel) =>
    $(sel).addEventListener('input', renderTable)
  );

  // Near-tier watchlist toggle
  $('#f-near').addEventListener('change', () => {
    showNear = $('#f-near').checked;
    renderTable();
  });

  // Near-tier toggle button — load/collapse, kept in sync with the checkbox
  $('#btn-show-more').addEventListener('click', () => {
    showNear = !showNear;
    $('#f-near').checked = showNear;
    renderTable();
  });

  // Tab navigation: signals ↔ explainer
  $('#tab-signals').addEventListener('click', () => switchTab('signals'));
  $('#tab-explainer').addEventListener('click', () => switchTab('explainer'));

  // Calendar popover — open/close
  $('#btn-date-picker').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCalPopover();
  });

  // Month navigation
  $('#cal-prev-month').addEventListener('click', () => {
    calViewMonth--;
    if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
    renderCalendar();
  });

  $('#cal-next-month').addEventListener('click', () => {
    calViewMonth++;
    if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
    renderCalendar();
  });

  // Prev/next day arrows
  $('#btn-prev-day').addEventListener('click', () => stepDay(-1));
  $('#btn-next-day').addEventListener('click', () => stepDay(1));

  // Close popover on outside click
  document.addEventListener('click', (e) => {
    const popover = $('#cal-popover');
    const group   = $('.date-picker-group');
    if (!popover.hidden && !group.contains(e.target)) {
      closeCalPopover();
    }
  });

  // Close popover on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const popover = $('#cal-popover');
      if (!popover.hidden) {
        closeCalPopover();
        $('#btn-date-picker').focus();
      }
    }
  });

  showState('טוען נתוני היסטוריה…');

  try {
    const resp = await fetch('/api/summary');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    summaryDays = await resp.json();
  } catch (err) {
    showState(`שגיאה בטעינת סיכום: ${err.message}`);
    return;
  }

  if (!summaryDays.length) {
    showState('אין נתונים זמינים');
    return;
  }

  buildSummaryIndex();

  // Initialize calendar view month to the latest data day
  const latestDate = summaryDays[0].scan_date;
  const parts = latestDate.split('-');
  calViewYear  = parseInt(parts[0], 10);
  calViewMonth = parseInt(parts[1], 10) - 1;

  // Select most recent day (index 0 = newest first per API contract)
  await selectDay(latestDate);

  // Fragility series is global (not per-day) — load once, after the main view.
  loadFragility();
}

boot();
