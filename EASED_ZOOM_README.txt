LeNota 0.33.3 — Animated Button Zoom (2026-10-24)

APPLY TO
Your previous LeNota-Smooth-Zoom-SOURCE.zip version, or the same patch-applied folder.

INSTALL
1. Extract this ZIP.
2. Open a terminal in the LeNota-mobile project directory.
3. Run:
     patch -p1 < /path/to/lenota-eased-zoom.patch
     bash RUN_SMOOTH_APP.sh

WHAT CHANGED
- +/- controls ease toward the target in 260 ms instead of an instant 10% jump.
- Consecutive clicks continue from the currently visible scale.
- Button zoom preserves the center anchor; touchpad and pointer actions interrupt safely.
- CSS layout zoom/redraw happens once after the last click (850 ms idle).
- Reduced-motion preference disables the animation.
- Does not alter stored note data or call paid APIs.

CHECKED
- TypeScript typecheck, production frontend build
- 139 editor/math tests, 49 performance tests, 31 SVG tests, 3 new zoom tests
- Patch dry-run against the supplied previous Smooth Zoom source

NOT VERIFIED
Native Fedora/WebKitGTK performance. A headless browser integration run was
blocked by the sandbox network policy; the native app was not run here.
