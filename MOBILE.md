> **Latest source: LeNota 0.33.3 (2026-10-17).** LaTeX paste/typing conversion and AI-backup resilience fixes are documented in [RELIABILITY_FIXES.md](RELIABILITY_FIXES.md). Rebuild the app or APK; already installed binaries do not change.

> **New: account sync.** Both native desktop and mobile builds support free
> Supabase cloud sync with the same offline-safe sync engine. Read
> [SYNC_SETUP.md](SYNC_SETUP.md) to create a Free project and connect both devices.

# LeNota on mobile

The existing React + Tauri 2 + SQLite app now targets Android and iOS alongside desktop. This is a native app: opening `dist/index.html` in a phone browser does not provide its Rust database backend.

## Interface

- Phones use a full-width workspace, a notebook drawer, and bottom navigation for Notes, Search, New Note, Files, and More.
- Text-only pages reflow in **Write** mode at readable sizes. The display reflows without changing saved container positions or widths. Switch to **Draw** or **Canvas view** for the spatial canvas. Pages containing ink or shapes always preserve their canvas layout.
- **Draw** opens a dedicated bottom dock with Pen, Marker, Eraser, Pan, and additional tools. Pen/Marker draw immediately with a finger or passive stylus; active pens use the existing pressure-aware input path. Choose **Pan** to move the canvas with one contact, or use two fingers to pan/pinch from any tool. Pinching while Pen/Marker is selected cancels provisional ink and its Undo entry. Color, width, Undo, Redo, and Fit remain visible while drawing. The dock uses one row in wide landscape layouts to preserve canvas height.
- Tablets adapt when rotated; wide layouts retain the desktop navigator. Tool shelves scroll horizontally, dialogs fit smaller screens, and inputs avoid iOS automatic zoom.
- Android Back dismisses drawers and dialogs before navigating back through notes. The Android WebView handles system bars, display cutouts, and the keyboard; native keyboard visibility hides the bottom navigation while typing. iOS uses CSS safe areas and the visible viewport.
- Mobile prose editing hides spatial selection overlays. Focus Mode keeps its toolbar above the note, removes the overlapping page strip from prose pages, and offers an exit button in the bottom controls.
- Autosave, local recovery drafts, notebooks, sections/groups, tags, favorites, attachments, revisions, and SQLite backups use the existing backend. Backgrounding also triggers a save. The Account & sync feature now adds cross-device synchronization.

## Android

Install Node 22 or newer, Rust stable, a **full JDK 17** (not just a JRE), and Android Studio's SDK/command-line tools. Install platform tools, the SDK platform/build tools required by `src-tauri/gen/android/app/build.gradle.kts`, and NDK `27.2.12479018` (pinned in that Gradle file). The checked-in native project currently uses compile/target SDK 37; the minimum Android API is 24. Keep Android System WebView up to date.

Set `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME` to your local installations. The SDK manager package names are `platforms;android-37.0` and `build-tools;37.0.0`. Keep your normal network/proxy settings available to Gradle as well as npm/Cargo.

```bash
cd apps/desktop
npm ci
npm run android:apk
```

That builds a debug-signed APK containing **armeabi-v7a (32-bit ARM)** and **arm64-v8a (64-bit ARM)** libraries. A 64-bit processor does not guarantee a 64-bit Android OS; 32-bit firmware cannot install the previous arm64-only APK. The wrapper includes both ARM targets by default for Android builds. Use `-- --target armv7` or `-- --target aarch64` when you deliberately want one architecture. Android library linking explicitly supports 16 KB page alignment, including when using NDK r27. Outputs are under `src-tauri/gen/android/app/build/outputs/apk/`. Use `npm run android:dev` with a connected phone/emulator. Run `npm run android:init -- --ci` only if you need to generate a fresh native project; the Android project is already included. Preserve the custom `MainActivity.kt` and manifest when regenerating.

For a release APK/AAB, configure your Android signing key in the generated Gradle project and use `npm run android:build`. Do not commit signing keys/passwords. A debug build is for installation/testing, not store submission.

The **Mobile** GitHub Actions workflow builds a debug APK for both ARM architectures and uploads it as an Actions artifact. It is included but is not automatically pushed or run by this archive.

## iPhone / iPad

iOS development/builds require **macOS, Xcode, and an Apple development team**. On that machine:

```bash
cd apps/desktop
npm ci
export APPLE_DEVELOPMENT_TEAM=YOUR_TEAM_ID
npm run ios:init -- --ci
npm run ios:dev
# Signed distribution build:
npm run ios:build
```

The wrapper generates a missing project before dev/build. `tauri.ios.conf.json` selects the mobile window and minimum iOS 16.4 (matching the Tailwind 4/WebKit requirements). `Info.ios.plist` supplies the microphone explanation and supported orientations. iOS has not been built or device-tested in the Linux environment used for this update.

## Platform differences

Gemini Cloud Ink, Ask, selected-region Ask, and cloud math use a native Rust HTTPS client on mobile; Python remains the desktop transport. Add your own Gemini key in the AI toolbar. No live-provider request was made as part of verification. `scripts/sync-mobile-prompts.py` snapshots the desktop prompts for mobile; run it after editing the desktop worker's prompts/model list.

Local **Tesseract OCR**, **Poppler PDF page rendering**, desktop **Print / PDF export**, and **folder-based section/notebook exports** remain desktop features. Mobile can attach PDFs and export individual pages as Markdown, HTML, or text through the native document picker. Files chosen on Android may use opaque document-provider URLs; imports read their bytes rather than treating those URLs as local filesystem paths. Common image/PDF/audio types are detected from their headers. Mobile imports are limited to 25 MB per attachment and 5 MB for text.

## Checks

```bash
npm run build
npm run test:mobile
npm run test:math
npm run test:images
npm run test:performance
npm run test:ai-worker
npx playwright install chromium
npm run test:mobile-ui
# From the repository root:
cargo test -p app-core -p app-database
```

The browser suite supplies a mock Tauri backend and checks phone, landscape, tablet, and desktop layouts, readable text, drawer focus navigation, title/text autosave, drawing directly after selecting Pen, Marker and Eraser, explicit Pan, real touch pinch input without stray ink or Undo entries, and command dialogs. It checks drawing controls stay on screen with at least 44 px touch targets. It also rotates an open note through compact and wide layouts, verifies light theme and Focus Mode, and simulates Android keyboard notifications and iOS visual-viewport resizing. These keyboard checks test frontend responses to those signals, not an actual OS keyboard. Device testing is still needed for native file pickers, permissions, audio, stylus/palm behavior, and signing.

The original mobile port passed the production frontend build; existing math, image, performance, Python worker, core/database, and mobile AI response tests; and Android Rust library compilation for both ARMv7 and ARM64. The drawing/layout update passed the frontend build, mobile geometry/file-type and pen input tests (18 tests), and the 237-assertion browser suite at 320, 390, 430, 768, 844, and 1440 px, with an additional 1024 px rotation state. The suite also covers drawing in Focus Mode and the shorter landscape dock. Full desktop native compilation and iOS compilation were not run in this environment.

A debug APK containing both 32-bit and 64-bit ARM libraries was built successfully (LeNota 0.33.2). Its APK signature, archive integrity, 16 KB ZIP alignment, and packaged ELF architectures and load/RELRO alignment were verified. Native debug symbols remain in Cargo's build directory and are stripped from the installable APK. The user confirmed the previous universal APK installs and launches on their Redmi 9C. The updated drawing build has not been run on that physical device here; stylus behavior and native integration still need device testing.
