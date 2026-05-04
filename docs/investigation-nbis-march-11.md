# חקירה: NBIS לא הופיעה ברדאר ב־11.03.2026

## רקע

ביום רביעי 11.03.2026, בסוף יום המסחר, הסקריפט רץ כרגיל. NBIS עמדה בתנאי Green (RVOL≥2, |Δ%|≥2%) אך לא הופיעה ברשימת האותות.

## עובדות

- **NBIS** הייתה ב־watchlist באותו יום (אושר על ידי המשתמש)
- **RVOL:** 2.79 (לפי replay היסטורי מ־Yahoo)
- **שינוי מחיר:** +16.1%
- **תנאי Green:** RVOL≥2 ✓ | Δ%≥2% ✓
- **מקום 15 בסריקה בפועל:** DELG.TA (RVOL 2.08) — NBIS עם 2.79 אמורה הייתה להיות בערך מקום 7–8
- **NBIS אינה ב־`results/scan-2026-03-11.json`**

## סימולציה (check-day-ranking)

הרצת `npx tsx scripts/check-day-ranking.ts 2026-03-11` עם ה־watchlist הנוכחי והיסטוריה מ־Yahoo:

- **NBIS מקום 8** מתוך 15 Green — בתוך ה־Top 15, לא מקום 16
- **מסקנה:** NBIS לא הייתה המניה ה־16 שנחתכה; עם נתונים תקינים היא הייתה צריכה להיכנס

## סיבות אפשריות (בלי לוגים מ־11.03 אי אפשר לאשר)

1. **כישלון Fetch** — Yahoo או Twelve Data לא החזירו נתונים ל־NBIS בשעת הסריקה (rate limit, שגיאת תקשורת וכו')
2. **באג יישור volumes** — ב־`marketData.ts` מערך `volumes` נבנה בנפרד מ־`closes`; אי-יישור עלול לגרום ל־RVOL שגוי. נדון בהמשך.

## לוגים לעתיד

מרץ 2026: נוספו לוגים וקבצי debug:

- **`results/scan-debug-{date}.json`** — בכל סריקה: `failedTickers`, `greenSortedFull` (דירוג מלא לפני חיתוך ל־TOP_N), `greenCount`, `pullbackOnlyCount`, `sma21OnlyCount`
- **שימוש:** אם מניה "נעלמת" — לבדוק: האם ב־`failedTickers`? מה המקום ב־`greenSortedFull`?

## סקריפטים לחקירה

- **`scripts/check-day-ranking.ts [YYYY-MM-DD]`** — סימולציה של דירוג Green ביום נתון (נתונים היסטוריים מ־Yahoo)
- **`scripts/nbis-deep-diagnostic.ts`** — סיכום חקירה מעמיקה

## מה לא בוצע

- לא תוקן הבאג ביישור volumes (לפי בקשת המשתמש — קודם חקירה)
- אין לוגים מהרצה בפועל ב־11.03 (failedTickers, שגיאות)
