#!/usr/bin/env npx tsx
/**
 * Analyze History — produces a comprehensive report on the rebuilt 30-day data.
 *
 * Reads:
 *   results/scan-YYYY-MM-DD.json (one per trading day)
 *   results/monitor-list.json    (lifecycle state)
 *
 * Outputs (to stderr):
 *   • Alert flow (Full/Recovery/Watchlist daily distribution + market regime)
 *   • Resolution rates (graduated / manual-entry / sma21-pullback / monitoring)
 *   • Time-to-resolution distributions
 *   • Returns from first alert to most-recent day (per level + per resolution)
 *   • Top winners + bottom losers
 *   • Geographic + sector breakdown
 *   • Signal quality: Full vs Watchlist, with-bypass vs without
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScanResultDay, MonitorState, MonitorEntry, MonitorStatus } from '../src/types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'results');

function loadAllScans(): ScanResultDay[] {
    const files = fs
        .readdirSync(RESULTS_DIR)
        .filter((n) => /^scan-\d{4}-\d{2}-\d{2}\.json$/.test(n))
        .sort();
    return files.map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8')) as ScanResultDay);
}

function loadMonitor(): MonitorState {
    const p = path.join(RESULTS_DIR, 'monitor-list.json');
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as MonitorState;
}

function fmt(n: number, digits = 1): string {
    return n.toFixed(digits);
}
function fmtPct(n: number | null | undefined, digits = 1): string {
    if (n == null || !Number.isFinite(n)) return '   —';
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(digits)}%`;
}
function median(arr: number[]): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
}
function avg(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function tradingDaysBetween(fromIso: string, toIso: string): number {
    const from = new Date(fromIso + 'T00:00:00Z');
    const to = new Date(toIso + 'T00:00:00Z');
    let days = 0;
    const cur = new Date(from);
    while (cur < to) {
        const d = cur.getUTCDay();
        if (d >= 1 && d <= 5) days++;
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
}

function tickerRegion(ticker: string): 'US' | 'IL' | 'EU' | 'Asia' | 'Other' {
    if (ticker.endsWith('.TA')) return 'IL';
    if (ticker.endsWith('.L') || ticker.endsWith('.PA') || ticker.endsWith('.DE') || ticker.endsWith('.AS') ||
        ticker.endsWith('.MI') || ticker.endsWith('.MC') || ticker.endsWith('.SW') || ticker.endsWith('.OL') ||
        ticker.endsWith('.HM') || ticker.endsWith('.VI'))
        return 'EU';
    if (ticker.endsWith('.T') || ticker.endsWith('.TW') || ticker.endsWith('.HK') || ticker.endsWith('.KS') ||
        ticker.endsWith('.SS') || ticker.endsWith('.SH'))
        return 'Asia';
    if (/^\d{4,6}\./.test(ticker)) return 'Asia';
    return 'US';
}

function main(): void {
    const scans = loadAllScans();
    const monitor = loadMonitor();
    if (scans.length === 0) {
        process.stderr.write('No scan-*.json files found in results/.\n');
        process.exit(1);
    }
    const firstDate = scans[0]!.date;
    const lastDate = scans[scans.length - 1]!.date;
    const lastScan = scans[scans.length - 1]!;

    // Build a lookup: ticker → most-recent-known close (from latest scan it appears in)
    const lastPriceByTicker = new Map<string, number>();
    for (const scan of scans) {
        for (const s of scan.stocks) {
            lastPriceByTicker.set(s.ticker.toUpperCase(), s.lastPrice);
        }
    }

    const out: string[] = [];
    const w = (s: string): void => { out.push(s); };

    w(`\n========================================================`);
    w(`📊 SMART VOLUME RADAR — 30-DAY HISTORY ANALYSIS`);
    w(`========================================================`);
    w(`Window:  ${firstDate} → ${lastDate}  (${scans.length} trading days)`);
    w(`Watchlist size: ${lastScan.watchlistTotal} tickers`);
    w(``);

    // ─── 1. MARKET REGIME ──────────────────────────────────────
    const bull = scans.filter((s) => s.marketRegime === 'bull').length;
    const bear = scans.filter((s) => s.marketRegime === 'bear').length;
    w(`🧭 MARKET REGIME`);
    w(`────────────────`);
    w(`Bull days: ${bull}  (${fmt((bull / scans.length) * 100)}%)`);
    w(`Bear days: ${bear}  (${fmt((bear / scans.length) * 100)}%)`);
    w(``);

    // ─── 2. ALERT FLOW ─────────────────────────────────────────
    const totals = { full: 0, recovery: 0, watchlist: 0, none: 0 };
    for (const scan of scans) {
        totals.full += scan.summary.full;
        totals.recovery += scan.summary.recovery;
        totals.watchlist += scan.summary.watchlist;
        totals.none += scan.summary.none;
    }
    const totalAlerts = totals.full + totals.recovery + totals.watchlist;
    w(`📈 ALERT FLOW (${scans.length} days)`);
    w(`────────────────`);
    w(`🎯 Full:      ${totals.full.toString().padStart(4)}  (avg ${fmt(totals.full / scans.length)} /day)`);
    w(`🦅 Recovery:  ${totals.recovery.toString().padStart(4)}  (avg ${fmt(totals.recovery / scans.length)} /day)`);
    w(`👀 Watchlist: ${totals.watchlist.toString().padStart(4)}  (avg ${fmt(totals.watchlist / scans.length)} /day)`);
    w(`Total signals: ${totalAlerts}  | Stocks scanned/day: ${fmt(totals.none / scans.length + totalAlerts / scans.length)}`);
    w(``);

    // Daily distribution (mini histogram)
    w(`Daily breakdown:`);
    w(`Date         🎯  🦅  👀   Regime`);
    for (const scan of scans) {
        w(
            `${scan.date}  ${scan.summary.full.toString().padStart(2)}  ${scan.summary.recovery.toString().padStart(2)}  ` +
            `${scan.summary.watchlist.toString().padStart(2)}   ${scan.marketRegime}`
        );
    }
    w(``);

    // ─── 3. RESOLUTION RATES ───────────────────────────────────
    const statusCounts: Record<MonitorStatus, number> = {
        monitoring: 0, graduated: 0, 'manual-entry': 0, 'sma21-pullback': 0, expired: 0, stopped: 0,
    };
    for (const e of monitor.entries) statusCounts[e.status]++;
    const totalMon = monitor.entries.length;
    w(`🎯 MONITOR RESOLUTIONS  (${totalMon} entries total)`);
    w(`────────────────────────`);
    const resolved = totalMon - statusCounts.monitoring;
    w(`👀 Still monitoring:   ${statusCounts.monitoring.toString().padStart(3)}  (${fmt((statusCounts.monitoring / totalMon) * 100)}%)`);
    w(`🎓 Graduated→Full:    ${statusCounts.graduated.toString().padStart(3)}  (${fmt((statusCounts.graduated / totalMon) * 100)}%)`);
    w(`🟢 Manual-entry:       ${statusCounts['manual-entry'].toString().padStart(3)}  (${fmt((statusCounts['manual-entry'] / totalMon) * 100)}%)`);
    w(`📐 SMA21-pullback:    ${statusCounts['sma21-pullback'].toString().padStart(3)}  (${fmt((statusCounts['sma21-pullback'] / totalMon) * 100)}%)`);
    w(`🗑️ Expired:            ${statusCounts.expired.toString().padStart(3)}  (${fmt((statusCounts.expired / totalMon) * 100)}%)`);
    w(`Resolution rate (any non-monitoring): ${fmt((resolved / totalMon) * 100)}%`);
    w(``);

    // ─── 4. TIME TO RESOLUTION ─────────────────────────────────
    const ttResolution = (key: MonitorStatus) => {
        const days = monitor.entries
            .filter((e) => e.status === key && e.resolvedDate)
            .map((e) => tradingDaysBetween(e.firstAlertDate, e.resolvedDate!));
        return { n: days.length, avg: avg(days), med: median(days), max: Math.max(0, ...days) };
    };
    const tGrad = ttResolution('graduated');
    const tMan = ttResolution('manual-entry');
    const tPull = ttResolution('sma21-pullback');
    w(`⏱️  TIME TO RESOLUTION (trading days)`);
    w(`──────────────────────────────────`);
    w(`Status          N    Avg   Med   Max`);
    w(`graduated      ${tGrad.n.toString().padStart(3)}   ${fmt(tGrad.avg).padStart(4)}  ${fmt(tGrad.med).padStart(4)}  ${tGrad.max.toString().padStart(3)}`);
    w(`manual-entry   ${tMan.n.toString().padStart(3)}   ${fmt(tMan.avg).padStart(4)}  ${fmt(tMan.med).padStart(4)}  ${tMan.max.toString().padStart(3)}`);
    w(`sma21-pullback ${tPull.n.toString().padStart(3)}   ${fmt(tPull.avg).padStart(4)}  ${fmt(tPull.med).padStart(4)}  ${tPull.max.toString().padStart(3)}`);
    w(``);

    // ─── 5. RETURNS FROM ALERT → TODAY ─────────────────────────
    const returnFromAlert = (e: MonitorEntry): number | null => {
        const cur = lastPriceByTicker.get(e.ticker.toUpperCase());
        if (!cur || e.firstAlertPrice <= 0) return null;
        return ((cur - e.firstAlertPrice) / e.firstAlertPrice) * 100;
    };

    w(`💰 RETURNS  (from FIRST alert price → ${lastDate} close)`);
    w(`──────────────────────────────────────────`);
    const byLevel = (lvl: 'full' | 'recovery' | 'close'): { n: number; rets: number[] } => {
        const ret: number[] = [];
        for (const e of monitor.entries) {
            if (e.firstAlertLevel === lvl) {
                const r = returnFromAlert(e);
                if (r != null) ret.push(r);
            }
        }
        return { n: ret.length, rets: ret };
    };
    const fullRet = byLevel('full');
    const recRet = byLevel('recovery');
    const wlRet = byLevel('close');
    const printLevel = (label: string, x: { n: number; rets: number[] }): void => {
        if (x.n === 0) {
            w(`${label.padEnd(15)}  N=0`);
            return;
        }
        const hit = (x.rets.filter((r) => r > 0).length / x.n) * 100;
        const sorted = [...x.rets].sort((a, b) => a - b);
        w(
            `${label.padEnd(15)}  N=${x.n.toString().padStart(3)}  ` +
            `Avg ${fmtPct(avg(x.rets)).padStart(7)}  Med ${fmtPct(median(x.rets)).padStart(7)}  ` +
            `Hit ${fmt(hit).padStart(5)}%  Min ${fmtPct(sorted[0]).padStart(7)}  Max ${fmtPct(sorted[sorted.length - 1]).padStart(7)}`
        );
    };
    printLevel('🎯 Full', fullRet);
    printLevel('🦅 Recovery', recRet);
    printLevel('👀 Watchlist', wlRet);
    w(``);

    // By resolution status
    w(`Returns by RESOLUTION status (alert → today):`);
    const byStatus = (status: MonitorStatus): { n: number; rets: number[] } => {
        const ret: number[] = [];
        for (const e of monitor.entries) {
            if (e.status === status) {
                const r = returnFromAlert(e);
                if (r != null) ret.push(r);
            }
        }
        return { n: ret.length, rets: ret };
    };
    printLevel('graduated', byStatus('graduated'));
    printLevel('manual-entry', byStatus('manual-entry'));
    printLevel('sma21-pullback', byStatus('sma21-pullback'));
    printLevel('still monitoring', byStatus('monitoring'));
    w(``);

    // ─── 6. TOP/BOTTOM PERFORMERS ──────────────────────────────
    const allWithReturn = monitor.entries
        .map((e) => ({ entry: e, ret: returnFromAlert(e) }))
        .filter((x): x is { entry: MonitorEntry; ret: number } => x.ret != null && Number.isFinite(x.ret));
    const sorted = [...allWithReturn].sort((a, b) => b.ret - a.ret);

    w(`🏆 TOP 15 WINNERS  (alert → ${lastDate})`);
    w(`Ticker        FirstLv  AlertDate    Status            $Alert →  $Now      Return`);
    for (const x of sorted.slice(0, 15)) {
        const e = x.entry;
        const cur = lastPriceByTicker.get(e.ticker.toUpperCase()) ?? 0;
        const lvE = e.firstAlertLevel === 'full' ? '🎯' : e.firstAlertLevel === 'recovery' ? '🦅' : '👀';
        w(
            `${e.ticker.padEnd(13)} ${lvE}       ${e.firstAlertDate}   ${e.status.padEnd(16)}  ` +
            `${e.firstAlertPrice.toFixed(2).padStart(8)} → ${cur.toFixed(2).padStart(8)}  ${fmtPct(x.ret).padStart(7)}`
        );
    }
    w(``);

    w(`💸 BOTTOM 15 LOSERS  (alert → ${lastDate})`);
    w(`Ticker        FirstLv  AlertDate    Status            $Alert →  $Now      Return`);
    for (const x of sorted.slice(-15).reverse()) {
        const e = x.entry;
        const cur = lastPriceByTicker.get(e.ticker.toUpperCase()) ?? 0;
        const lvE = e.firstAlertLevel === 'full' ? '🎯' : e.firstAlertLevel === 'recovery' ? '🦅' : '👀';
        w(
            `${e.ticker.padEnd(13)} ${lvE}       ${e.firstAlertDate}   ${e.status.padEnd(16)}  ` +
            `${e.firstAlertPrice.toFixed(2).padStart(8)} → ${cur.toFixed(2).padStart(8)}  ${fmtPct(x.ret).padStart(7)}`
        );
    }
    w(``);

    // ─── 7. GEOGRAPHIC + SECTOR BREAKDOWN ─────────────────────
    const regionStats = new Map<string, { n: number; rets: number[] }>();
    const sectorStats = new Map<string, { n: number; rets: number[] }>();
    for (const x of allWithReturn) {
        const region = tickerRegion(x.entry.ticker);
        if (!regionStats.has(region)) regionStats.set(region, { n: 0, rets: [] });
        regionStats.get(region)!.n++;
        regionStats.get(region)!.rets.push(x.ret);
        const sec = x.entry.sector ?? 'Unknown';
        if (!sectorStats.has(sec)) sectorStats.set(sec, { n: 0, rets: [] });
        sectorStats.get(sec)!.n++;
        sectorStats.get(sec)!.rets.push(x.ret);
    }
    w(`🌍 BY REGION`);
    w(`Region   N    AvgRet    MedRet   Hit%`);
    for (const [reg, st] of [...regionStats.entries()].sort((a, b) => b[1].n - a[1].n)) {
        const hit = (st.rets.filter((r) => r > 0).length / st.n) * 100;
        w(`${reg.padEnd(7)} ${st.n.toString().padStart(3)}  ${fmtPct(avg(st.rets)).padStart(7)}   ${fmtPct(median(st.rets)).padStart(7)}  ${fmt(hit).padStart(5)}%`);
    }
    w(``);

    w(`🏭 BY SECTOR  (top 10 by alert count)`);
    w(`Sector                          N    AvgRet    MedRet   Hit%`);
    const sectorsSorted = [...sectorStats.entries()].sort((a, b) => b[1].n - a[1].n);
    for (const [sec, st] of sectorsSorted.slice(0, 10)) {
        const hit = (st.rets.filter((r) => r > 0).length / st.n) * 100;
        w(
            `${sec.slice(0, 30).padEnd(30)}  ${st.n.toString().padStart(3)}  ${fmtPct(avg(st.rets)).padStart(7)}   ` +
            `${fmtPct(median(st.rets)).padStart(7)}  ${fmt(hit).padStart(5)}%`
        );
    }
    w(``);

    // ─── 8. SIGNAL QUALITY ─────────────────────────────────────
    w(`🔬 SIGNAL QUALITY: Full vs Watchlist`);
    if (fullRet.n > 0 && wlRet.n > 0) {
        w(`Full     avg ${fmtPct(avg(fullRet.rets))}  hit ${fmt((fullRet.rets.filter((r) => r > 0).length / fullRet.n) * 100)}%`);
        w(`Watchlist avg ${fmtPct(avg(wlRet.rets))}  hit ${fmt((wlRet.rets.filter((r) => r > 0).length / wlRet.n) * 100)}%`);
        const diff = avg(fullRet.rets) - avg(wlRet.rets);
        w(`Δ (Full − Watchlist): ${fmtPct(diff)} avg return advantage for Full`);
    }
    w(``);

    // High-conviction bypass quality (across all scans we'd need to look)
    // For simplicity: count how many monitor entries had Full and bypass would be from scan
    let fullBypass = 0, fullPristine = 0;
    let bypassRets: number[] = [], pristineRets: number[] = [];
    for (const e of monitor.entries) {
        if (e.firstAlertLevel !== 'full') continue;
        // Find the scan day matching firstAlertDate to check bypass
        const scanThatDay = scans.find((s) => s.date === e.firstAlertDate);
        if (!scanThatDay) continue;
        const stockSnap = scanThatDay.stocks.find((st) => st.ticker.toUpperCase() === e.ticker.toUpperCase());
        if (!stockSnap || stockSnap.level !== 'full') continue;
        const r = returnFromAlert(e);
        if (r == null) continue;
        if (stockSnap.highConvictionBypass) {
            fullBypass++;
            bypassRets.push(r);
        } else {
            fullPristine++;
            pristineRets.push(r);
        }
    }
    if (fullPristine + fullBypass > 0) {
        w(`Full alerts breakdown — pristine vs high-conviction bypass:`);
        w(`Pristine entry  N=${fullPristine.toString().padStart(3)}  avg ${fmtPct(avg(pristineRets))}  med ${fmtPct(median(pristineRets))}`);
        w(`HCV bypass      N=${fullBypass.toString().padStart(3)}  avg ${fmtPct(avg(bypassRets))}  med ${fmtPct(median(bypassRets))}`);
    }
    w(``);

    // ─── 9. KEY OBSERVATIONS (auto-generated) ─────────────────
    w(`💡 AUTOMATIC OBSERVATIONS`);
    const fullHit = fullRet.n > 0 ? (fullRet.rets.filter((r) => r > 0).length / fullRet.n) * 100 : 0;
    const wlHit = wlRet.n > 0 ? (wlRet.rets.filter((r) => r > 0).length / wlRet.n) * 100 : 0;
    if (fullHit > 70) w(`  ✅ Full alerts have a high hit rate (${fmt(fullHit)}%) — system reliable for Full.`);
    else if (fullHit < 50) w(`  ⚠️ Full alerts hit rate is below 50% (${fmt(fullHit)}%) — consider tightening criteria.`);
    if (avg(fullRet.rets) > avg(wlRet.rets) + 5) {
        w(`  ✅ Full beats Watchlist by ${fmt(avg(fullRet.rets) - avg(wlRet.rets))}% — tier ranking working.`);
    } else if (avg(fullRet.rets) < avg(wlRet.rets)) {
        w(`  ⚠️ Watchlist actually outperforms Full — tier inversion! Investigate.`);
    }
    if (statusCounts.expired > totalMon * 0.3) {
        w(`  ⚠️ ${fmt((statusCounts.expired / totalMon) * 100)}% of monitors expired — many alerts go nowhere.`);
    }
    const inProgress = statusCounts.monitoring;
    if (inProgress > totalMon * 0.6) {
        w(`  ℹ️  ${fmt((inProgress / totalMon) * 100)}% still in monitoring — more time needed for full picture.`);
    }
    w(``);

    process.stderr.write(out.join('\n') + '\n');
}

main();
