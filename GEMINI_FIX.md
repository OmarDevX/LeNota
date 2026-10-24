# Current update: complete long Ask tables (r11 / gemini-r6)

Close LeNota, extract over your existing LeNota-master directory, replacing
source files, then run `bash RUN_SMOOTH_APP.sh`. Confirm `gemini-r6` and `perf-r4`
in the header. All scrolling, graph, PDF, and previous drawing fixes remain.

The worker and frontend now support tables with up to 200 data rows per block.
Numeric table cells are accepted. Longer requested tables can use consecutive
table blocks. No rows or columns are silently cut off during table conversion.
See ASK_TABLE_FIX.md for details and verification.

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

# Gemini JSON/fallback correction (gemini-r4)

Revision r4 gives ink transcription its own fast model route: Gemini 3.5
Flash-Lite first, then 3.1 Flash-Lite. Each ink attempt has a 5-second socket
timeout, with no delayed quota/overload retries or full-Flash fallback. The
working Ask route retains its r3 model order, timeouts, and retries.

This restores lightweight models for automatic and manual ink recognition.
The writing-pause and unfinished-equation grouping behavior is unchanged.
The request configuration remains the accepted JSON-mode format without the
provider-side schema removed in r3. JSON/LaTeX repair remains active.

Timing is not measured against the real API. Cloud recognition still needs a
network round trip; shorter attempts may leave the original ink for review or
retry during overload or unusually slow responses. The 5-second timeout is a
socket-operation limit, not a guaranteed wall-clock completion time.

This is the complete source project, with the uploaded Linux x64 JavaScript
dependencies retained. It is not a precompiled Fedora RPM or AppImage.

1. Close all running LeNota windows.
2. Extract this ZIP into a fresh directory.
3. Open a terminal in the extracted LeNota-master directory and run:

   ```bash
   bash RUN_UPDATED_APP.sh
   ```

4. Check that the header shows `v0.33.2 · ink-r3 · gemini-r4`.

The worker is embedded in the Rust application at compile time. Rebuild using
this source; restarting an older installed binary cannot apply the correction.
For an installable package, run `bash BUILD_UPDATED_APP.sh`, then install the
newly generated package. Existing Fedora Tauri/Rust build prerequisites, Node/
npm, and Python 3 must be present. On a different OS or CPU architecture,
reinstall apps/desktop JavaScript dependencies for that platform first.

Changes:
- Ask: Gemini 3.8 Flash, 3.5 Flash-Lite, and 3.7 Flash fallbacks.
- Ink: Gemini 3.5 Flash-Lite and 3.1 Flash-Lite, with bounded attempts and no
  delayed provider retries. The restricted 2.5 model remains excluded.
- 45-second Ask budget and up to 15 seconds per API attempt, within the remaining
  budget. Other operations retain their own overall timeout.
- Use the previously accepted JSON-mode request configuration, without a
  provider-side response schema; keep explicit backslash-escaping instructions.
- Recover invalid escapes in JSON strings without deleting backslashes or
  rewriting valid JSON escapes, quotes, Unicode, or code line breaks.
- Repair decoded LaTeX controls in math fields using the existing focused repair.
- Ignore thought parts; reject blocked/truncated replies and broken JSON structure.
- Validate note content inside model fallback rather than after accepting a model.
- For Ask, try alternatives before one bounded retry of each overloaded model;
  honor Retry-After and the shared budget. Authentication failures stop immediately.
- Restored executable launcher permissions.

Verified in this environment:
- Python worker: 32 tests passed, including a simulated 503 followed by the
  invalid-LaTeX-escape response seen in the screenshot.
- Frontend tests: 109 passed.
- TypeScript check and production Vite build passed.
- Rust source was not changed. The embedded Python script still requires a native
  rebuild. Cargo/Rust were unavailable here, so a native app build was not tested.
- No real Gemini API request was made; no user API key was available.

Google-side 503 overload can still happen if all models remain unavailable.
The patch fixes local response handling and adds bounded retries; it cannot
eliminate a provider outage. The UI's existing error path retains the /ask
command or leaves the page unchanged so the user can retry.

References checked while implementing:
https://ai.google.dev/gemini-api/docs/models
https://ai.google.dev/gemini-api/docs/generate-content/structured-output
