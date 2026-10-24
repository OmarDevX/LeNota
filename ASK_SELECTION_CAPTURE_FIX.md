# LeNota 0.33.3 — Ask Selection capture fix (2026-10-18)

## What failed

The message "Visible page capture failed after retrying (Browser error event while loading the selected image)" came from `html-to-image` / WebKit capture **before** a request reached any AI provider. It was not evidence that the AI service was down.

## What changed

- `src/features/editor/page-editor.tsx` now has a bounded DOM image-capture attempt. If fonts, image resources or browser SVG decoding fail or stall, it continues to a separate Canvas 2D capture instead of cancelling Ask Selection.
- `src/features/editor/visual-canvas-fallback.ts` captures positioned text, math glyphs, and note content from rendered DOM text, plus SVG pen ink and shapes from their native paths without cloning or loading network/browser resources. The existing managed photo/PDF-byte composition is still used, preserving source resolution.
- A failing drawing-overlay capture no longer discards a successful base screenshot: only the SVG layer uses Canvas fallback.
- Errors occurring *before* the AI transport are now reported as selection-capture failures rather than incorrectly blaming an AI provider.
- The prompt now refers to AI instead of a specific vendor, since automatic provider fallback already exists.

## How to use

Close LeNota. Extract the zip. From `LeNota-mobile/`, run `bash RUN_UPDATED_APP.sh` (requires Rust/Tauri system dependencies) or `bash RUN_SMOOTH_APP.sh`. For a release build, `bash BUILD_UPDATED_APP.sh`. **An already-installed application is not changed by downloading this source; it must be rebuilt or launched from the extracted project.**

If the included `node_modules/` is not usable on your system, run `npm ci` in `LeNota-mobile/apps/desktop/` before launching. Rebuild Android separately, as usual, using `npm run android:apk` from that directory.

## Validation run

- TypeScript type check: passed
- 131 editor/math/image unit tests: passed
- AI backup/safe-ask tests: passed
- Vite production frontend build: passed
- Chromium native Canvas screenshot test (`node tests/visual-canvas-fallback-ui.mjs`): passed (text + shapes + ink + PNG encoding)

The new fallback is exercised in Chromium; direct execution in the user's particular WebKitGTK/Tauri runtime or an installed Android APK has **not** been tested here. The native fallback is intentionally written without WebKit's problematic HTML-to-image / resource-loading path. Unavailable or unreadable original attachments may still need to be repaired; the app does not invent missing image data.
