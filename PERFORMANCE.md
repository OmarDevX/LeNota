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
