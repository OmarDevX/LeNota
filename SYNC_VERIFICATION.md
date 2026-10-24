# Verification of the free cloud sync update

New checks passed:

- Three Rust merge tests, including nine scenarios compared against the tested
  Python reference merger (body/metadata conflicts, deletes, parent recovery,
  duplicate tags, cycles, and preserving files on retained edited pages).
- Two Rust managed-provider integration tests against a Supabase protocol
  simulator: independent PC/phone SQLite workspaces, two-way edits, private
  files, token refresh/rotation, conflicts/history, guarded import, CAS retries,
  trash propagation, sign-out, rejection of secret keys, and account binding.
- Repeated unchanged polls download no snapshot/file data and make no pushes,
  as asserted in those integration tests.
- 16 PostgreSQL checks executing the actual Supabase setup SQL in PGlite,
  including idempotent migration, RPC results, stale-version rejection,
  missing-file rollback, anonymous denial, cross-account workspace/file denial,
  and immutable storage policies under non-owner roles.
- 28 account UI browser assertions for both providers, including mobile free
  setup fields, secret-key rejection, sign-in, offline errors, guarded import,
  and waiting for active drawing gestures.
- Frontend TypeScript/production Vite build and app-sync/app-database Clippy
  checks (with the previously existing unnecessary_sort_by lint exempted).

These tests did not contact a live Supabase project. Auth/storage HTTP protocols
were simulated; real SQL functions and access policies were exercised in embedded
PostgreSQL with mock Supabase-managed auth/storage schemas. A final installed
PC/Android check against the user's actual Free project is still needed after
project setup and rebuilding the apps. No project, keys, or user credentials
were created on the user's behalf, and no installer/APK was built here.

The following original-server checks remain relevant and previously passed:

- Frontend TypeScript checks and production Vite build.
- 18 Python server tests: two-way/offline changes, conflicts/history, deletion
  races, hierarchy conflicts, account/session isolation, attachment uploads,
  missing-file rollback, validation, and persistent server restart.
- 15 Rust database tests, including atomic import and edits during a request.
- 2 Rust end-to-end tests using two independent SQLite workspaces and the actual
  Python HTTP server. They cover PC → phone → PC notes, file transfer, localized
  embedded attachment paths, conflicting bodies/history, delayed-apply protection,
  trash propagation, account binding, sign-out, and HTTPS URL validation.
- 19 account UI browser assertions across 320, 390, and 1440 pixel widths,
  including sign-in/sign-out, remote reloads, draft protection while a request
  is in flight, waiting for an active drawing gesture, and offline errors.
- 237 existing mobile browser assertions across six viewport sizes.
- 4 existing mobile unit tests.
- Clippy for app-sync and app-database with warnings denied, except the existing
  `unnecessary_sort_by` lint in the original backup helper.

The existing `test:math` command passed 126 of 127 tests. Its unchanged
`focused mode keeps the classic large toolbar and contextual shelves` test has
outdated source-text assertions: it expects `setToolShelfOpen(true)` and
`setToolShelfOpen(!focusMode)` where the uploaded mobile editor already uses
compact-layout guards. The page editor and that test were not changed by this
update. The separate mobile browser suite passed. This pre-existing assertion
failure is not presented as a successful test run.

The complete Tauri desktop build could not be checked here because its Linux
GTK/WebKit development dependencies are unavailable. The shared Rust account
and sync engine was compiled and exercised against the real server; the Tauri
commands are thin adapters to that tested engine. No desktop installers,
Android APK, or signed iOS binary were built. Installed-device checks are still
needed after building with the project's normal desktop/Android/iOS toolchains.

For the free provider, create your own Supabase project, run setup.sql, and
rebuild both apps. No self-hosted account server is required. See SYNC_SETUP.md.
