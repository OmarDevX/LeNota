# 100-word Ask table correction (r11 / gemini-r6)

Expected header: `v0.33.2 · ink-r3 · gemini-r6 · pdf-r2 · perf-r4`.

Close LeNota, extract over your existing LeNota-master directory, then run
`bash RUN_SMOOTH_APP.sh`. The ZIP contains the complete source and built
frontend, with dependency/native build caches omitted so it stays small.

The reported request was "list me most important 100 word and if they are
feminine or masculine in italian." The screenshot reported model timeouts and
two invalid-table errors. The code had two concrete problems for this request:
worker validation rejected tables with more than 50 rows, and frontend conversion
independently truncated table rows to 50. Numbered table entries could also be
rejected if the model used numeric ranks instead of strings. The exact rejected
provider response was not available, so its shape cannot be proven from the
screenshot alone.

Worker validation and frontend conversion now agree on 200 data rows and 12
columns per table. The worker accepts integer and finite floating-point table
cells, including numeric ranks. Existing text and structured math cells are
retained. Ask's prompt states the limits, asks for every requested entry, and
instructs the model to split larger tables across consecutive blocks with
repeated headers. The frontend preserves all accepted rows and columns and
fails explicitly for malformed or oversized tables instead of silently deleting
entries. Header rows do not count toward the data-row limit.

The 200 KB total-response budget and other validation remain in effect.
Gemini models, API JSON-mode configuration, request timeouts, deadline, fallback,
bounded rejected-content retry, and Cloud Ink's fast route are unchanged.
The confirmed perf-r4 canvas fix is retained. No responseSchema was introduced.
Provider availability, quota exhaustion, and network timeouts remain external
failure possibilities; this correction fixes acceptance and preservation of
long table answers.

Verification:
- Production TypeScript/Vite build passed.
- All 152 frontend tests and 40 Python worker tests passed.
- A simulated first-model timeout followed by a 100-row vocabulary table is
  accepted immediately on the next model without a rejected-content retry.
- Every rank, accented word, gender label, and final entry is preserved through
  frontend conversion and JSON save/reload. The actual StarterKit/TableKit
  schema accepts the resulting 101-row table (header plus 100 entries).
- Boundary tests cover 200 accepted rows, explicit rejection of 201 rows in one
  block, 300 entries across multiple blocks, column overflow, numeric cells,
  malformed cells/rows, and the existing total-response budget.
- No live Gemini account request or native Rust/Tauri execution was performed.
