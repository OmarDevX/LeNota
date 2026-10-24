# Expanding containers and cropped grid (r10 / perf-r4)

Expected header: `v0.33.2 · ink-r3 · gemini-r5 · pdf-r2 · perf-r4`.

Close LeNota, extract this ZIP over your existing LeNota-master directory,
replacing source files, then run `bash RUN_SMOOTH_APP.sh` from that directory.
The complete source and built frontend are included. Existing dependencies and
Cargo build caches are reused when extracting over the current project.

## Cause and correction

ProseMirror's default caret scrolling sets scrollTop/scrollLeft on ancestors,
even when those ancestors use overflow:hidden. LeNota's spatial canvas instead
uses its saved x/y/zoom transform. Those unexpected native offsets moved the
canvas contents and clipped its separate paper layer without updating that
transform, matching the screenshot's grid cutoff and displaced content.

All note editors now handle caret visibility through LeNota's viewport system.
Normal typing inside the window leaves the viewport unchanged. Beyond an edge,
the caret is revealed with a small margin using one synchronized translation
for the paper, notes, vectors, and selection controls. Zoom and every object's
world coordinates are preserved. Pending wheel transforms are flushed before
caret measurements, preventing repeated stale-coordinate shifts. Saves remain
batched through the existing viewport commit timer.

The canvas and fixed app layout use overflow:clip on screen, preventing hidden
native scroll offsets from focus, browser caret handling, or content growth.
Code, table, math, inspector, toolbar, and navigation scrollbars are retained.
The custom handler scrolls relevant code/table/math interiors locally, accounting
for canvas zoom, without walking into canvas ancestors. Oversized visible graph
or PDF atoms do not repeatedly bounce the viewport trying to fit in the window.
Print overflow rules remain active because the new clipping is screen-only.

Long /ask answers replace the command with selection at the answer's beginning,
with automatic end-of-answer scrolling disabled. Headings, nested lists/tables,
and graph-only replies use valid ProseMirror selections. All returned blocks
remain in the note; existing notes and generated content are not truncated.

## Verification

- Production TypeScript/Vite build passed.
- All 148 frontend tests and 36 Python worker tests passed.
- Nine new regression tests cover vertical, horizontal, and diagonal overflow;
  five canvas zoom levels; consistent paper/world motion; oversized objects;
  invalid geometry; local code scrolling that cannot change canvas offsets;
  an actual ProseMirror transaction inserting 80 paragraphs; valid selection
  at headings/lists/tables/graph atoms; screen clipping and print preservation.
- Gemini routing, pen geometry, SVG surface sizing, managed images, PDF loading,
  and the release launcher remain unchanged from r9.
- Native Rust/Tauri execution and WebKitGTK behavior could not be tested here.
  Geometry, transaction behavior, code wiring, and the frontend build were
  verified; the affected native window still needs a check after rebuilding.
