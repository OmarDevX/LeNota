> **Latest source: LeNota 0.33.3 (2026-10-17).** LaTeX paste/typing conversion and AI-backup resilience fixes are documented in [RELIABILITY_FIXES.md](RELIABILITY_FIXES.md). Rebuild the app or APK; already installed binaries do not change.

> **Free PC ↔ phone sync:** select Supabase in Account & sync. Read
> [SYNC_SETUP.md](SYNC_SETUP.md) to create a Free project, run the included
> [setup SQL](supabase/setup.sql), and sign in on both devices. No paid server,
> domain, or Python hosting is needed for this route.

# Current update: complete long Ask tables (r11 / gemini-r6)

Close LeNota, extract over your existing LeNota-master directory, replacing
source files, then run `bash RUN_SMOOTH_APP.sh`. Confirm `gemini-r6` and `perf-r4`
in the header. All scrolling, graph, PDF, and previous drawing fixes remain.

The worker and frontend now support tables with up to 200 data rows per block.
Numeric table cells are accepted. Longer requested tables can use consecutive
table blocks. No rows or columns are silently cut off during table conversion.
See ASK_TABLE_FIX.md for details and verification.

---

## Earlier revision notes

# Current update: expanding note containers (r10 / perf-r4)

Close LeNota, extract over your existing LeNota-master directory, replacing
source files, then run `bash RUN_SMOOTH_APP.sh`. Confirm `perf-r4` in the header.

Long Ask replies start at their beginning. Typing beyond the visible bottom or
horizontal edge follows the caret through the canvas pan system, keeping paper,
notes, shapes, and ink aligned. Native scrolling of hidden layout ancestors is
blocked on screen. Code and table scrollbars remain available.

See CONTAINER_SCROLL_FIX.md for details, validation, and testing limits.
The graph, duplicate-drawing, PDF, and prior performance fixes are retained.

---

## Earlier revision notes

# Current update: graph requests and drawing ghosts (r9)

Close LeNota, extract over the existing LeNota-master directory, then run
`bash RUN_SMOOTH_APP.sh`. Confirm `gemini-r5` and `perf-r3` in the header.

Ask now supports real graph cards and one bounded regeneration of rejected
JSON. Rebased vector roots no longer force compositor textures; finished pen
previews clear before paint when the committed stroke appears. Resolution and
stroke geometry are retained. See GRAPH_AND_DRAWING_FIX.md for validation and
native testing limits. If driver ghosts persist, use
`LENOTA_SAFE_RENDERER=1 bash RUN_SMOOTH_APP.sh`.

---

## Earlier revision notes (superseded where described above)

# Panning and scrolling correction (perf-r2)

This revision targets viewport movement. It retains PDF resolution, all stroke
geometry, the complete editable scene, the AI routes, and the perf-r1 changes.

Run:
1. Close LeNota.
2. Extract this ZIP over your existing LeNota-master project directory, replacing
   its source files. Reusing this directory keeps node_modules and Cargo target
   caches for a quicker rebuild. The ZIP also contains the complete source if
   you prefer a fresh extraction.
3. Run `bash RUN_SMOOTH_APP.sh` from the updated LeNota-master directory.
4. Confirm `perf-r2` in the header, then open the same note.

What changed:
- The two 8000x8000 SVG roots now use viewport-sized bounds with padding. Small
  pans reuse the same bounds and move the existing parent transform; the SVG
  layout/viewBox changes only near an edge, on resize, or on zoom. Only these
  bounded surfaces receive compositor hints; the entire workspace is not
  promoted to one giant GPU layer.
- The grid/ruling is a separate CSS-gradient layer. Ordinary panning moves its
  periodic phase with a transform instead of changing inherited CSS variables
  on the ancestor of every note and SVG. Colors, spacing, and phase are retained.
  Large custom spacing uses a bounded fallback without an oversized GPU layer.
- Unrelated React renders preserve an in-flight viewport instead of resetting
  it to the previous saved viewport. Starting a drag cancels an old wheel timer;
  resizing refreshes the cached wheel geometry.
- Drawing paths stay mounted and editable. Visual selection captures temporarily
  expand the clipping region; printing restores the original unclipped SVG
  roots. Both restore the normal small surfaces afterward.

Verification:
- TypeScript and production frontend build passed; 135 frontend tests passed.
- 8 new viewport tests cover zoom, resizing, fractional/negative movement, bounds
  reuse, paper alignment, capture expansion, print restoration, and viewport
  state continuity.
- SVG raster comparisons were identical across 10 views at zoom 0.35, 0.5, 1,
  1.75, and 2.5, including negative canvas positions, pressure ink, selection,
  rotated shapes, arrows, and non-scaling strokes.
- For a 1360x760 viewport at zoom 1, one padded SVG root is 3,145,728 square units
  rather than 64,000,000. This describes the SVG area, not a measured FPS gain.
- The native backend, AI worker, stroke algorithms, managed image loading, and
  release launcher are unchanged from r7.
- Native WebKit performance and the Rust release build were not measured here;
  native smoothness still needs confirmation on your machine.

---

# Smoothness update (perf-r1)

This update keeps the current features, pen geometry, image resolution, AI routes,
and autosave timing. It removes repeated work in the existing canvas paths.

## Run the optimized build

1. Close all running LeNota windows.
2. Extract this ZIP into a fresh directory.
3. In LeNota-master, run `bash RUN_SMOOTH_APP.sh`.
4. Confirm `perf-r1` in the header (the PDF fix remains pdf-r2).
5. Open your existing notebook and PDF note normally.

The launcher installs missing JavaScript dependencies with npm ci, builds the
production frontend and native release binary without installers, and runs that
binary. Internet is needed for dependency installation and any uncached Cargo
packages. It uses your existing Fedora Rust/Tauri/Python prerequisites. The first
release build takes longer than a development build; later builds are incremental.
The existing RUN_UPDATED_APP.sh remains available for development/live reload.

## Changes

- Unchanged note editors and committed ink skip React rendering; event callbacks
  still use the current selection and document state.
- Undo/redo retains immutable canvas data instead of cloning every old stroke.
  An active stroke is copied when taking a snapshot. The 80-entry undo limit is
  unchanged; existing edits replace their data instead of modifying it in place.
- Saving caches JSON fragments for unchanged notes, strokes, and shapes using
  weak references. The stored JSON format and publication/autosave timing are
  unchanged. Growing live strokes always serialize their current points.
- AI-history checks skip empty history and unrelated notes, and reuse the rendered
  text of unchanged note content. Deleted or replaced answers are still pruned.
- Managed images share a read/blob across duplicate views. At most three reads
  run simultaneously; removed queued images are skipped and the last viewer
  releases the blob. Image decoding is asynchronous, with the same PNG bytes.

## Verification and limits

- TypeScript check and production frontend build passed.
- 110 existing editor/layout/math/pen tests and 24 performance/image tests passed.
- Rendering comparisons produced identical SVG for pressure ink, normal ink,
  highlighters, dots, selection, both themes, and moved/restyled strokes.
- Saving comparisons produced byte-for-byte identical JSON across edits, new
  strokes, deletions, background changes, and a growing live stroke.
- Undo isolation, latest event handlers, image read limits, sharing, retry, and
  disposal passed. Three real PDF-rendered PNGs decoded with the correct
  dimensions and pixels using the pooled attachment source.
- Release launcher smoke checks passed with mocked build tools, including build
  failure handling, Cargo workspace output paths, and paths containing spaces.
- The AI worker, Rust sources, stroke rendering algorithms, stylesheet, and app
  autosave code are unchanged. Cargo/a native WebView were unavailable here;
  the native release build and app FPS were not measured.

Synthetic benchmark in this environment: 500 strokes, 75,000 points, 4.09 MB JSON.
Median undo capture: 39.9 ms before, below 0.01 ms after.
Median repeated serialization, including materializing the output bytes:
22.4 ms before, 1.6 ms after. These are individual JavaScript operation timings,
not an overall app speedup or a guarantee of native frame rate.

To repeat the checks from apps/desktop:
  npm run test:performance
  npm run test:math
  node --experimental-strip-types benchmarks/canvas-performance.mts

---

# PDF page image correction (pdf-r2)

The imported PDF page entries were present, but their local asset URLs failed
to display. Managed images now read the saved attachment by its ID through the
existing native attachment API, then display a temporary image blob. Blob URLs
are allowed by the image CSP and are released when the image view is removed;
they are never stored in the note. A failed read or decode shows an error and
Retry button instead of only a filename.

Run this update:
1. Close all LeNota windows and extract into a fresh directory.
2. In LeNota-master, run `bash RUN_UPDATED_APP.sh` to rebuild and launch.
3. Confirm `pdf-r2` in the build badge.
4. Open the existing note. Imported pages with saved attachments will use the
   corrected loading path automatically; do not reimport just to reload them.

Insert a new PDF:
1. Open Write and click PDF printout, the first button.
2. Select the PDF, use quality 144, page range `all`, and size `large`.
3. Cancel the optional OCR question for faster insertion, or OK for searchable
   local OCR.

Rendering is local and retains the original PDF attachment. Gemini is not
involved. The existing limit is 200 pages per insertion. Poppler is required
(on Fedora: `sudo dnf install poppler-utils`); OCR additionally needs Tesseract.
The working Gemini and fast ink recognition routes are unchanged.

Verification:
- TypeScript check and production Vite build passed.
- 13 image loading and visual-selection tests passed, covering binary response
  normalization, MIME detection, read failures, resource cleanup, and CSP.
- A real three-page PDF rendered with pdftoppm at 144 DPI passed the attachment
  source / blob / PNG decoding check, including dimensions and pixel colors.
- Rust and AI worker sources are unchanged from r5. The native CSP configuration
  changed, so a native rebuild is required. Cargo and a native WebView were
  unavailable here; native image display remains unverified.

---

# Gemini JSON/fallback correction (gemini-r4)

Revision r4 gives ink transcription its own fast model route: Gemini 3.5
Flash-Lite first, then 3.1 Flash-Lite. Each ink attempt has a 5-second socket
timeout, with no delayed quota/overload retries or full-Flash fallback. The
working Ask route retains its r3 model order, timeouts, and retries.

This restores lightweight models for automatic and manual ink recognition.
The writing-pause and unfinished-equation grouping behavior is unchanged.
The request configuration remains the accepted JSON-mode format without the
provider-side schema removed in r3. JSON/LaTeX repair remains active.

Timing is not measured against the real API. Cloud recognition still needs a
network round trip; shorter attempts may leave the original ink for review or
retry during overload or unusually slow responses. The 5-second timeout is a
socket-operation limit, not a guaranteed wall-clock completion time.

This is the complete source project, with the uploaded Linux x64 JavaScript
 dependencies retained. It is not a precompiled Fedora RPM or AppImage.

1. Close all running LeNota windows.
2. Extract this ZIP into a fresh directory.
3. Open a terminal in the extracted LeNota-master directory and run:

   ```bash
   bash RUN_UPDATED_APP.sh
   ```

4. Check that the header shows `v0.33.2 · ink-r3 · gemini-r4`.

The worker is embedded in the Rust application at compile time. Rebuild using
this source; restarting an older installed binary cannot apply the correction.
For an installable package, run `bash BUILD_UPDATED_APP.sh`, then install the
newly generated package. Existing Fedora Tauri/Rust build prerequisites, Node/
npm, and Python 3 must be present. On a different OS or CPU architecture,
reinstall apps/desktop JavaScript dependencies for that platform first.

Changes:
- Ask: Gemini 3.8 Flash, 3.5 Flash-Lite, and 3.7 Flash fallbacks.
- Ink: Gemini 3.5 Flash-Lite and 3.1 Flash-Lite, with bounded attempts and no
  delayed provider retries. The restricted 2.5 model remains excluded.
- 45-second Ask budget and up to 15 seconds per API attempt, within the remaining
  budget. Other operations retain their own overall timeout.
- Use the previously accepted JSON-mode request configuration, without a
  provider-side response schema; keep explicit backslash-escaping instructions.
- Recover invalid escapes in JSON strings without deleting backslashes or
  rewriting valid JSON escapes, quotes, Unicode, or code line breaks.
- Repair decoded LaTeX controls in math fields using the existing focused repair.
- Ignore thought parts; reject blocked/truncated replies and broken JSON structure.
- Validate note content inside model fallback rather than after accepting a model.
- For Ask, try alternatives before one bounded retry of each overloaded model;
  honor Retry-After and the shared budget. Authentication failures stop immediately.
- Restored executable launcher permissions.

Verified in this environment:
- Python worker: 32 tests passed, including a simulated 503 followed by the
  invalid-LaTeX-escape response seen in the screenshot.
- Frontend tests: 109 passed.
- TypeScript check and production Vite build passed.
- Rust source was not changed. The embedded Python script still requires a native
  rebuild. Cargo/Rust were unavailable here, so a native app build was not tested.
- No real Gemini API request was made; no user API key was available.

Google-side 503 overload can still happen if all models remain unavailable.
The patch fixes local response handling and adds bounded retries; it cannot
eliminate a provider outage. The UI's existing error path retains the /ask
command or leaves the page unchanged so the user can retry.

References checked while implementing:
https://ai.google.dev/gemini-api/docs/models
https://ai.google.dev/gemini-api/docs/generate-content/structured-output

---

# Run the LeNota reference workspace build

The ZIP contains source code, not a precompiled RPM or AppImage. Launching an
older installed LeNota from the application menu will continue to run the old
bugs.

1. Close every running LeNota window.
2. Extract this ZIP into a new directory. Do not merge it into an older source
   directory.
3. From the extracted `lenota` directory, run:

   ```bash
   ./RUN_UPDATED_APP.sh
   ```

4. Confirm that `v0.33.2 · ink-r3` appears beside **LeNota** in the application header.
   If the `ink-r3` suffix is absent, you are still running one of the older smoothing builds.

To make an installable RPM/AppImage after verifying the correction, run:

```bash
./BUILD_UPDATED_APP.sh
```

Then install the newly generated package before using the desktop application
shortcut again.

This patch archive is intentionally named `lenota-v0.33.2-reference-workspace.zip`.
Do not use an older file named only `lenota.zip`.

The normal launcher uses WebKitGTK's faster renderer. This release keeps that
performance path while adding pressure-sensitive, frame-batched stylus input,
device-neutral pen-button bindings (including hold-to-pan), calibrated and
diagnosable pressure response, stable fast-stroke smoothing, complete off-screen
Focus Mode toolbar/page animations with stable interactive tool shelves and edge
recovery controls, a native Linux tablet-pressure fallback, rounded pencil caps,
a radial Pencil Wheel,
connected-stroke erasing, custom pencils, a
recoverable empty state, and compact-window navigation. It also preserves the approved rail, notebook drawer, floating
tools, bordered canvas, and optional inspector.
Focus Mode uses a single full-window drawable canvas with all controls floating
above it; it does not reserve a separate title area. Light and dark themes are
complete and independently selectable in either workspace mode. Ink converted
to text, math, or shapes keeps the color that was visible on the canvas. Size
fields keep their recommended choices but also accept directly typed positive
values. If your machine shows a blank or corrupted canvas, close LeNota and
use `./RUN_SAFE_RENDERER.sh` as a compatibility fallback.
