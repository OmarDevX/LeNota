# LeNota 0.33.3 — Giant Canvas Performance, Stage 1

## What changed

- The canvas retains the **complete** note, ink, and shape arrays for saving, export,
  sync, undo, AI context, and selection. The storage format/version is unchanged.
- A 512-world-unit spatial grid indexes note containers, shapes, and committed pen strokes.
  Visible objects within a generous pixel buffer are mounted; other rich-text editors and
  SVG stroke/shape elements are not mounted.
- The viewport buffer follows wheel/pan using the compositor-friendly animation-frame
  path already in LeNota; React recomputes the rendered set only near buffer edges.
- Long rich-text containers have conservative initial bounds and measured heights
  from `ResizeObserver` after mounting, to avoid clipping a note that stretches below
  its top edge. Selected/focused containers and selected ink/shapes stay mounted.
- **Ask Selection** first mounts the region being captured and releases it afterward.
- Printing temporarily restores all objects; page Find/Replace retains all editors so
  existing editor-based matches and replacements keep working. The mobile prose mode
  remains unvirtualized to retain its regular scrolling behavior.
- No new UI controls, changes to ChatGPT/Gemini/OpenRouter, or modifications to on-disk
  SQLite, backups, or sync schema.

## Limits / follow-up work

This is a rendering optimization, **not** an infinite-document or storage migration.
Page JSON is still loaded and saved in one document, so saving, undo snapshots and
sync still scale with total page size. The previous 50 MB JSON limit has not changed.
Find/Replace and printing intentionally mount the whole page and will still be slow
on extreme documents. Offscreen note geometry is conservatively estimated until
measured. Mobile prose mode needs independent virtualization work.

Next stage should investigate incremental indexed storage and background serialization
with backups and cross-device-sync migration tests, followed by ink tile caching,
measured editing latency and Fedora/WebKitGTK frame-time profiling.

## Verification

```sh
cd apps/desktop
npm run build
npm run test:performance
npm run test:math
npm run test:mobile
npm run benchmark:spatial
npm run test:spatial-ui   # requires an unrestricted installed Chromium browser
```

The synthetic benchmark builds indexes for 25,000 notes and 50,000 ink items and
queries two indexes in 250 different viewports; it is NOT an FPS or device benchmark.
Before replacing your current installation, back up your notebook database, then
check pan/zoom, typing, selection, Ask Selection (including handwriting), page search,
print/export, undo, and cloud sync on Fedora and your actual Android device.
