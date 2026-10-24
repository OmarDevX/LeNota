# LeNota 0.33.3 – Smooth Canvas Navigation (Stage 3)

This patch builds directly on the Stage 2 incremental SQLite storage source, and preserves the existing providers, AI context controls, selected-image capture, and canvas file format.

## Changes

1. SVG surface rebasing now depends on actual world-space coverage, not on a change in zoom alone. Zooming a small amount scales the world normally without reallocating the SVG viewBox, CSS size, and origin each frame.
2. Vector viewBox/surface padding is increased from 256 to 512 screen pixels, reducing the rate of expensive WebKitGTK backing-surface rebases while panning.
3. The buffered note/ink visibility window grows from 850 to 1300 screen pixels, and refresh hysteresis from 260 to 400 screen pixels. This reduces heavy editor mounting during continuous movement, at the cost of mounting somewhat more nearby content.
4. Visibility refreshes are now scheduled as React transitions, letting pointer and wheel input retain priority. The actual world transform remains animation-frame based.

These changes only affect view-layer scheduling. They do not delete, crop, or truncate documents. All offscreen content remains available to saving, search, AI, sync and export.

## Important: use the RELEASE launcher for performance checks

`RUN_UPDATED_APP.sh` uses `tauri dev`. For everyday Fedora use, close the development instance first and run:

```sh
bash RUN_SMOOTH_APP.sh
```

The first launch may compile the native release build and therefore take longer. Subsequent starts are faster. Keep `RUN_UPDATED_APP.sh` for development/hot reload.

To test graphics-driver artifacts, `LENOTA_SAFE_RENDERER=1 bash RUN_SMOOTH_APP.sh` disables WebKit's DMA-BUF renderer, which may avoid ghost tiles at the cost of performance. Don't turn this mode on unless you see actual visual corruption, not just dropped frames.

## Verification performed

- TypeScript typecheck and production frontend build passed.
- 48 focused rendering/persistence/context tests passed, including two added pan/zoom rebase checks.
- 131 editor tests, 4 mobile tests, 40 AI worker tests passed.
- Synthetic simulation on one fake SVG (120 events at 1360x760): zoom attribute rewrites decreased from 357 to 0; continuous pan from 9 to 6. This is not a Fedora frame-time/FPS benchmark.

## Limitations

- This workspace cannot compile native Rust/Tauri or measure hardware GPU frame pacing in Fedora/WebKitGTK.
- A single very large rich-text note still costs time to mount; release-mode testing will clarify how much lag remains.
- Canvas movement completion still serializes the full page for the viewport persistence path. The next step, if lag is still measurable after this patch, is an asynchronous or incremental viewport-only persistence update with crash/recovery tests.
- A larger visibility buffer uses more memory. If the device is memory-constrained and the frame rate becomes worse, compare against Stage 2 before replacing your original.
