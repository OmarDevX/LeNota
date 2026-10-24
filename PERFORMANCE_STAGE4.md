# LeNota 0.33.3 — Stage 4: Trackpad and stylus panning smoothness

This update builds on Stage 3 (including the Stage 2 object-store database).
There is **no new database migration** in Stage 4.

## Changes

- Trackpad wheel/pinch navigation settles for 550 ms before committing the page viewport (was 140 ms). This avoids unnecessary page serialization and native save work during momentary gaps in touchpad momentum events. Changing note content remains on its original save path.
- Nonurgent viewport-virtualization updates wait for 165 ms of motion inactivity. Editors are not repeatedly mounted and unmounted in the middle of every short pan.
- If the displayed region approaches within 150 screen pixels of the currently mounted buffer edge, the virtualization refresh happens immediately to reduce blank-region risk during fast navigation.
- ResizeObserver note-height measurements are batched for 170 ms before rebuilding the note spatial index.
- Stage 3 SVG surface stability and zoom performance are preserved.

## Install

1. Back up LeNota's notes and attachments, and keep your known-working Stage 3 project as a rollback.
2. Close LeNota completely.
3. Extract the Stage 4 **full** ZIP to a new directory. Enter `LeNota-mobile`.
4. For regular Fedora use, run `bash RUN_SMOOTH_APP.sh`. The first native release build may take time.
5. If you only want dev mode, run `bash RUN_UPDATED_APP.sh` (it can feel less smooth).

## Validation

TypeScript check, frontend build, editor unit tests, and performance unit tests passed in the packaging environment. The native Fedora/Tauri runtime was not compiled/tested here. Chromium UI automation was blocked by the container's browser policy (ERR_BLOCKED_BY_ADMINISTRATOR). Actual FPS, ink latency, and visible notebook behavior need checking in the release build on the user's Fedora machine.

## Important

Camera position changes may take an extra fraction of a second to be persisted after a trackpad gesture ends. Edits to notes and handwriting are not delayed by this change. There is no claim of perfect 60/120 FPS on all hardware: WebKitGTK, GPU drivers, compositor and the number/complexity of on-screen rich-text editors can still affect frame time.

If an older pre-Stage-2 version is installed, do not open a database already migrated to the Stage 2 object-store format with it.
