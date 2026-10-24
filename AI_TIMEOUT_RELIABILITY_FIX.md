# LeNota 0.33.3 – Ask/Ask Selection timeout reliability update

This patch **includes the previously verified Ask Selection capture fallback**.

## Failure addressed

The previous UI reported `AI response timed out. Your /ask command was kept.` after 75 seconds. The native worker can try Gemini, then Groq and OpenRouter sequentially, and can run longer than the frontend watchdog (or stall during a slow provider response). That mismatch can hide the real provider failure. It can also leave the shared transport busy until the old native call eventually returns.

## Changes

1. Ask + Ask Selection now request an 80-second provider budget instead of 45 seconds, and the frontend waits up to 110 seconds for the native result. The user is told that configured providers may take up to about 90 seconds.
2. Desktop Python backup chain respects the request budget (rather than an independent 65-second constant). Its Unix signal deadline bounds the **whole** worker operation to the requested time plus 10 seconds and returns an actionable error instead of hanging indefinitely on a slow response.
3. Native desktop and mobile Ask commands accept the larger Ask timeout, without changing the shorter handwriting and math limits. Mobile fallback time is derived from the same Ask budget.
4. The existing `askSafely` guard remains: timed-out and cancelled requests cannot insert late replies, and notes remain editable. A still-running native call is not silently discarded or mistaken for a successful answer.
5. Added regression tests for worker hard timeout, post-timeout recovery and consistent fallback budgets. No API keys, notes or settings are bundled into these ZIPs.

## Limits

This resolves a timing/control-flow failure in LeNota; it cannot make a remote provider answer if its account/key is blocked, quota is exhausted, the internet connection is unavailable or all configured providers fail. In those cases, LeNota now has better opportunity to report the underlying provider error, while preserving existing content.

## Validation in this environment

- 54 Python cloud-AI/fallback tests passed.
- 131 TypeScript editor tests passed.
- 3 safe-Ask transport tests passed.
- 34 browser UI assertions passed using system Chromium.
- TypeScript typecheck and Vite production frontend build passed.
- The new source was **not compiled as a Tauri/native Rust binary here** because `cargo` is unavailable. Rebuild the native app on your machine to deploy changes in `commands.rs` and `cloud_ai_worker.py`.
- Live provider API calls were not tested because your API keys are intentionally not available in the source package.

## Running

Full ZIP: extract and run `bash RUN_UPDATED_APP.sh` in the `LeNota-mobile` folder (requires the normal Rust/Tauri toolchain on Fedora). Rebuild the installed executable with `bash BUILD_UPDATED_APP.sh`.

Source-only ZIP: first install frontend dependencies normally under `apps/desktop`, then use the same commands.

Both retain LeNota's existing on-device data paths. Back up your notes before changing installations.
