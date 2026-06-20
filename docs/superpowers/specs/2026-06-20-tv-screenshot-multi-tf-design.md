# tv_screenshot multi-timeframe — Design

**Date:** 2026-06-20
**Status:** Approved for planning (user delegated "as you see fit").
**Builds on:** v3 `tv_screenshot` (`2026-06-18-tv-screenshot-design.md`) + the chart-only crop.

## Goal

Let `tv_screenshot` capture one symbol across several timeframes in a single call,
returning one chart image per timeframe, so trend (higher TF) and entry (lower TF)
can be read together.

## Scope

In scope:
1. New optional `intervals` (string array) param on `tv_screenshot`.
2. Script `--intervals "1D,1W,..."` mode: loop, capture one chart-only PNG per
   interval, print a unified `{mode,symbol,shots:[{interval,path}]}` JSON.
3. MCP returns one image+caption content block per shot.
4. A max-timeframes cap (4) so one call can't spawn unbounded browser work.

Out of scope: per-interval different symbols, montage/stitching into one image,
saving to a folder (that's roadmap item B), news/fundamentals (item D).

## Architecture

Unchanged philosophy: script owns Playwright; MCP shells out. The script's
screenshot output is **unified to always use a `shots` array** (one entry for the
single-interval/default case, N entries for `--intervals`). This removes the v3
single-shape `{interval,path}` output; only the MCP consumed it, and the MCP is
updated in the same change.

```
tv_screenshot({ symbol, interval?, intervals? })
   ▼  buildScreenshotArgs:
        intervals[] -> ['--screenshot', SYM, '--intervals', '1D,1W']
        else interval -> ['--screenshot', SYM, '--interval', '1W']
        else          -> ['--screenshot', SYM]
   ▼  script runScreenshot: resolve interval list →
        for each: navigate /chart/?symbol=&interval= → chart-only clip → temp PNG
        print {mode:'screenshot', symbol, shots:[{interval|null, path}, ...]}
   ▼  MCP image handler: for each shot read PNG → image block + caption; unlink each
   ▼  Claude receives N chart images
```

## Interval resolution (script)

`runScreenshot` builds an ordered, de-duplicated interval list:
- if `--intervals` set: split CSV, trim, drop empties, map each via `tvInterval`,
  cap to the first 4.
- else if `--interval` set: single `[tvInterval(x)]`.
- else: `[null]` (saved-layout default timeframe; URL omits `&interval=`).

For each entry it navigates, waits for render, chart-only clips, screenshots to a
temp PNG, and records `{interval: <original friendly string or null>, path}`.

## MCP changes (`mcp-tv-sync`)

- `buildScreenshotArgs({symbol, interval, intervals})`: symbol required (trimmed,
  throws if empty). If `intervals` is a non-empty array → normalize (String,
  trim, drop empties) and emit `--intervals "csv"`; throw if it normalizes empty.
  Else if `interval` set → `--interval`. Pure; unit-tested.
- `index.js` image branch: read `parsed.shots` (array). For each shot with a
  readable PNG, push `{type:'image',...}` + a `{type:'text'}` caption
  (`<symbol> @ <interval|default>`). Unlink each file after read. isError if
  timeout, parse fail, `parsed.error`, or zero readable shots.
- `tools.js`: add `intervals` (array of strings) to the `tv_screenshot` schema
  alongside the existing `interval`.

## Error handling
- Empty symbol → arg-builder throws.
- `intervals` present but all-empty after normalize → arg-builder throws.
- One interval fails to render but others succeed → return the readable shots;
  only isError if **none** are readable.
- Cap: more than 4 intervals → silently use the first 4 and the script logs the
  drop to stderr (no silent unbounded work; the drop is visible in logs).

## Testing
- **Unit (`buildScreenshotArgs`):** intervals array → `--intervals` CSV; intervals
  beats interval when both passed; single interval still works; no-interval still
  works; empty symbol throws; all-empty intervals throws.
- **Integration (manual):** `tv_screenshot({symbol:"NVDA", intervals:["1D","1W"]})`
  → two NVDA chart images (daily + weekly), both chart-only with the saved layout.
