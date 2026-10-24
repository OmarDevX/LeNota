# LeNota 0.33.3 — Giant Canvas Performance, Stage 2 (native object storage)

## What changed

- A version-8 SQLite migration adds `page_canvas_state` and `page_canvas_items`.
- The first *edit* to a valid canvas moves its typed note containers, ink strokes, and shapes to individually keyed records **inside a single SQLite transaction**. Previous workspaces and legacy ProseMirror documents remain readable; pages with missing or duplicated object IDs continue using their original full-document storage so no objects can disappear silently.
- Each later save compares compact SHA-256 hashes and order positions. Only new, deleted, changed or reordered objects are inserted, deleted or updated. Page title, plain-text search index and a small metadata record are updated separately.
- The public `get_page`, page duplication, revision history, revision restore and sync snapshot APIs continue to expose a *complete* canvas JSON document. Cloud sync protocol and all frontend data structures stay unchanged. Incoming sync documents are written in the portable full-document format until locally edited again.
- Database errors and rejected sync operations roll back everything including object-store changes. If component storage is missing, loading fails with an explicit error rather than silently creating an empty page.
- Before upgrading a version-1-to-7 on-disk SQLite workspace, LeNota makes a one-time consistent rollback copy next to the original database, named `workspace.pre-stage2.sqlite3`. This is a safety net, not a substitute for your regular attachments + database backup.
- Stage 1 canvas virtualization, AI context checkmarks, Ask Selection, and ChatGPT → Gemini → OpenRouter remain unchanged.

## Important limitations

**Native Rust compilation and the new Rust integration tests were not possible in the packaging environment.** On your Fedora machine, run `bash VERIFY_STORAGE_STAGE2.sh` and require every test to pass *before* using this build on your real notes. A frontend build alone cannot validate native storage. This is a **test candidate**, not a verified production release.

The frontend still constructs and transmits complete page JSON on save; the backend still validates/hashes it and updates page-level plain text/FTS. This stage reduces database *object writes*, not total serialization or CPU to constant time. The 50 MB JSON page limit, 10,000-container and 100,000-ink object validators, and whole-document cloud snapshots are unchanged. Large images, huge undo stacks, exporting, and full sync still cost time and memory. A later stage would need change-set IPC, paged loading, selective sync, and performance profiling.

**Do not open a stage-2-modified database with an older LeNota build.** The older build does not recognize the object-store marker. Keep the original backup and a separate copy of your existing installation until after tests succeed.

## Verify and run on Fedora

```bash
cd LeNota-mobile
bash VERIFY_STORAGE_STAGE2.sh
# Only after it passes, back up your real workspace and attachments, then:
bash RUN_UPDATED_APP.sh
```

The verifier runs the native `app-database` test suite, the production frontend build, and the Stage-1 performance tests. It doesn't modify your real notes. Native tests include first-save migration, object-level write tracing, reopen, duplicate, revision history storage, normalized cloud snapshots, successful sync apply, rejected sync rollback, duplicate-ID legacy fallback, and the one-time pre-upgrade rollback copy.

For manual smoke testing on a disposable copy: open a page, type into one note, draw and erase one stroke, close/reopen, duplicate, create/restore a revision, check Find, Ask Selection, and export, then test cloud sync against a separate device. Don't deploy to your primary database until these checks pass.

## Restore if needed

Close LeNota **on all devices** and disable synchronization before doing any restore. The pre-upgrade `workspace.pre-stage2.sqlite3` is a consistent snapshot *before* schema v8. Restore it together with the corresponding attachment files via your existing backup workflow. Do not simply copy a live WAL-backed database over an open application.
