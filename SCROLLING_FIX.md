# Current canvas correction: perf-r4

See CONTAINER_SCROLL_FIX.md for long-container caret scrolling and the cropped
paper-grid correction. See GRAPH_AND_DRAWING_FIX.md for the retained r9 graph
and duplicate-drawing changes.

Close LeNota, extract over the existing LeNota-master directory, then run:

```bash
bash RUN_SMOOTH_APP.sh
```

Confirm `gemini-r5` and `perf-r4` in the header. The existing optional renderer
fallback from r9 remains available, but container growth now uses the normal
canvas pan path and screen-only non-scrollable clipping.
