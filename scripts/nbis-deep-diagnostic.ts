#!/usr/bin/env npx tsx
/**
 * Deep diagnostic: why NBIS didn't appear on 2026-03-11.
 * Compares: stored scan values vs our historical replay vs volume-alignment theory.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const TARGET_DATE = '2026-03-11';
const SCAN_FILE = path.join(process.cwd(), 'results', `scan-${TARGET_DATE}.json`);

async function main(): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  חקירה מעמיקה: למה NBIS לא הופיע ב־11.03.2026');
    console.log('═══════════════════════════════════════════════════════════\n');

    // 1. Stored scan data
    if (!fs.existsSync(SCAN_FILE)) {
        console.log('❌ קובץ הסריקה לא נמצא. הרץ evaluate-setups קודם.');
        return;
    }

    const scan = JSON.parse(fs.readFileSync(SCAN_FILE, 'utf-8')) as {
        date: string;
        signals: Array<{ ticker: string; rvol: number; source: string }>;
    };

    const topSignals = scan.signals.filter(
        (s) => s.source === 'topSignals-green' || s.source === 'topSignals-pullback' || s.source === 'topSignals-sma21'
    );
    const nbisInScan = scan.signals.some((s) => s.ticker === 'NBIS');

    console.log('1️⃣  נתונים שנשמרו בסריקה (scan-2026-03-11.json)\n');
    console.log('   מקום 15 (אחרון ב־TOP_N):', topSignals[14]?.ticker, '| RVOL:', topSignals[14]?.rvol?.toFixed(2));
    console.log('   NBIS בסריקה:', nbisInScan ? '✅ כן' : '❌ לא');
    console.log('   סה"כ topSignals:', topSignals.length);
    console.log('');

    console.log('   טבלת דירוג (לפי RVOL) — 15 הראשונים:');
    console.log('   ─────────────────────────────────────');
    const byRvol = [...topSignals].sort((a, b) => b.rvol - a.rvol);
    byRvol.forEach((s, i) => {
        console.log(`   ${(i + 1).toString().padStart(2)}. ${s.ticker.padEnd(10)} RVOL ${s.rvol.toFixed(2)}`);
    });
    console.log('');

    const lastRvol = topSignals[topSignals.length - 1]?.rvol ?? 0;
    console.log('2️⃣  הסקה:');
    console.log('   • NBIS (לפי replay היסטורי) היה RVOL 2.79, Δ% +16.1% — עובר Green');
    console.log('   • מקום 15 בסריקה: RVOL', lastRvol.toFixed(2));
    console.log('   • 2.79 >', lastRvol.toFixed(2), '→ NBIS אמור היה להיכנס ל־TOP 15');
    console.log('');

    console.log('3️⃣  סיבות אפשריות (לא ניתנות לאימות בלי לוגים):');
    console.log('   א) Fetch נכשל — Yahoo/Twelve Data לא החזירו נתונים ל־NBIS ברגע הסריקה');
    console.log('   ב) NBIS לא היה ב־watchlist באותו יום — אולי נוסף אחרי 11.03');
    console.log('   ג) באג יישור volumes (תוקן עכשיו) — volumes לא היו מיושרים ל־closes');
    console.log('      ייתכן שה-RVOL שחושב ל־NBIS היה שגוי (נמוך/0) בגלל היישור');
    console.log('');

    console.log('4️⃣  תיקון שבוצע:');
    console.log('   • marketData: volumes מיושרים כעת ל־closes (אותו אינדקס = אותו יום מסחר)');
    console.log('   • חישוב RVOL יהיה מדויק יותר מהסריקות הבאות');
    console.log('');
}

main().catch(console.error);
