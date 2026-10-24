# Graph requests and disappearing duplicate drawings (r9)

Expected header: `v0.33.2 · ink-r3 · gemini-r5 · pdf-r2 · perf-r3`.

Close LeNota, extract this ZIP over your existing LeNota-master directory,
replacing source files, then run `bash RUN_SMOOTH_APP.sh` from that directory.
This reuses installed dependencies and the native build cache. The ZIP also
contains the complete source for a fresh extraction. Existing notebooks stay
in the application's normal data directory.

## Ask for a graph

Both `/ask sketch the graph of y=x^2` and lasso Ask selection now accept actual
graph blocks. When a function is in the selected region, ask "Sketch the graph
of this function." The selected PNG and current page context remain attached.
The response becomes the existing vector graph card, with saved equation,
numeric axis ranges, and title. It supports the local graph renderer's real
x/y relations: arithmetic, powers, fractions, roots, trigonometry, logarithms,
and exponentials. Generated plotting code is never executed. Unsupported
relations should be explained rather than replaced by an invented function.
This is a plotted graph card, not editable pen strokes.

The supplied screenshot reported HTTP 503 overload, malformed JSON, and a
timeout. Ask now regenerates rejected content once, with a formatting correction
and the original context/image, before continuing model fallback. That retry
shares the existing overall deadline. Gemini's accepted JSON-mode request
configuration is unchanged; no responseSchema is added. Cloud Ink retains its
two lightweight models, five-second attempt cap, and no delayed provider retries.
External overload or quota exhaustion can still cause a request to fail.

## Drawing ghosts

The rebased SVG roots no longer force independent compositor textures or paint
containment. This removes a likely stale-tile source when CSS origin, viewBox,
and parent transform change during movement. The viewport-sized padded bounds
remain; paths, point data, pressure geometry, PDF resolution, editing, undo,
visual capture expansion, and printing are retained.

The live ink preview now clears in a React layout effect in the same commit as
the saved stroke, before paint. It no longer relies on a later animation frame
that could display both preview and committed paths or clear the preview too
soon. Active strokes still paint directly without per-sample React updates.

If your graphics driver still leaves disappearing ghost tiles, launch with:

```bash
LENOTA_SAFE_RENDERER=1 bash RUN_SMOOTH_APP.sh
```

This selects the existing WebKit DMA-BUF renderer workaround. Normal launching
keeps WebKit's default; an explicitly supplied WEBKIT_DISABLE_DMABUF_RENDERER
setting is now honored. The fallback's speed depends on the machine.

## Verification

- Production TypeScript/Vite build passed; 139 frontend tests and 36 Python
  worker tests passed.
- Graph tests cover Ask conversion and actual geometry for a parabola, circle,
  sine, and reciprocal, plus invalid syntax/free-parameter rejection and axes.
- Worker tests reproduce overload followed by malformed graph JSON and verify
  regeneration retains the selected image, page context, and accepted config.
  Deadline and blocked-candidate checks keep retries bounded.
- Preview source checks enforce commit-time cleanup; viewport tests enforce
  unpromoted roots, bounded geometry, captures, print, and live pan continuity.
- Ten SVG raster comparisons matched the original full-size surfaces exactly
  across five zoom levels, negative positions, ink, selection, and shapes.
- Mock launcher checks passed for default, explicit renderer, and safe mode.
  Native Rust/Tauri execution, WebKit driver behavior, FPS, and live Gemini
  availability could not be tested in this workspace. The intermittent ghost
  symptom still needs confirmation on the affected machine.
