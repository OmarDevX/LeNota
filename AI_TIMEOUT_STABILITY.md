# LeNota 0.33.3 — ChatGPT /ask slow-response reliability update

This source replaces the previous Network Recovery package and keeps its DNS-error recovery, ChatGPT Plus sign-in, Gemini/OpenRouter order, and Ask Selection capture fallback.

## What changed

- The earlier ``Overall Cloud Ask time limit (25s)`` error came from Gemini's *individual fallback budget*, not the entire request. Desktop /ask previously allowed 80 seconds in total, but ChatGPT's HTTP streaming read could time out after 45 seconds.
- Desktop /ask and Ask Selection now permit 150 seconds overall, allowing ChatGPT up to approximately 90 seconds to produce a detailed response while reserving approximately 30 seconds for Gemini and up to 35 seconds for OpenRouter. The editor watchdog is longer than the native request so it should report the real provider error instead of prematurely timing out. Cancellation and late-reply protections remain.
- OpenRouter now queries the provider's model catalog and selects verified zero-price, text- or vision-compatible entries. It prefers named Nemotron/Gemma free variants, falls through to other listed free models by intelligence ordering, and will not use the random openrouter/free router or paid models. Its catalog is cached for 10 minutes. If the catalog is unavailable, a short list of named free variants remains available with strict max_price=0 enforcement. HTTP 404 invalidates the catalog. HTTP 429 still indicates a quota/rate problem and cannot be bypassed automatically.
- Mobile still uses Gemini -> OpenRouter because the desktop ChatGPT login cannot operate on mobile; model catalog selection is currently only in the desktop Python AI worker.

## Verification

- 60 Python worker/auth/backup tests
- 131 editor tests
- 3 frontend late-reply/timeout-safety tests
- 17 cloud-response rendering tests
- TypeScript checking and production Vite build

A native Rust/Tauri binary could not be built in the packaging environment (no Rust toolchain). Actual provider requests must be verified after launching on Fedora with your own existing ChatGPT login/API keys; none are included here.

## Start

Extract the full archive, open `LeNota-mobile` and run:

```sh
bash RUN_UPDATED_APP.sh
```

The existing Tauri app-data directory contains your saved notes and credentials. Back up your data before replacing versions.
