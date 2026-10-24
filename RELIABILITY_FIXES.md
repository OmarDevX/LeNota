# LeNota 0.33.3: LaTeX paste + free AI resilience (2026-10-17)

This is an updated source project, **not an installable APK or RPM**. The existing
compiled application will not change until it is rebuilt. Do not delete your
original project or note database. Back up notes before installing an update.

## Math in notes

- Paste Markdown/plain text copied from ChatGPT with `$...$`, `$$...$$`,
  `\(...\)` or `\[...\]` equations directly into an editable LeNota note.
- Pasted equations are actual editable KaTeX math nodes. Markdown headings,
  basic bold text, and bulleted/numbered lists are converted as well.
- Typing a complete `$x^2$` or `\(x^2\)` equation also creates a math node.
- Existing formatted math pasted from within LeNota retains its original node.
- Code fences, incomplete math delimiters, plain prose, and escaped dollars
  are not automatically converted. This does not recognize bare unmarked TeX.
- Long/invalid LaTeX still depends on KaTeX syntax support.

**Smoke test:** Paste this *source text* (not a rendered image) into a note:

```text
# My Physics Notes
Inline: $A_x=4$.

$$
\vec{A}=4\hat{i}+6\hat{j}+3\hat{k}
$$
```

It should show a heading, rendered inline math, and a rendered display formula.
Click a formula to edit it; its LaTeX source is still saved in your note.

## Cloud AI

- Keeps the original Gemini -> Groq -> OpenRouter automatic fallback order.
- Removes OpenRouter's provider `require_parameters` and JSON-mode filter,
  which excluded some free endpoints. **Zero-price routing is still enforced.**
- A complete free-model response in plain text can be converted to a normal
  `/ask` note when JSON formatting is unsupported. Structured outputs are still
  required for handwriting recognition and equation solving.
- A response cut off by its token limit is not inserted. One shorter retry is
  attempted before switching providers; user notes and `/ask` stay intact.
- More output capacity is available to Groq for longer requests. Other
  provider failures still trigger cooldown and fallbacks.
- Error details, including HTTP 403 key/access failures, are shown in a
  nonblocking **Why did the AI fail?** expander.
- Android **Test Groq** and **Test OpenRouter** now test only the requested
  provider, even when both backup keys are saved.

**Reality check:** A 403 error can come from a disabled/restricted account,
invalid permissions, provider policy or regional access; no client code can
make a forbidden account work. With free remote services, quotas, outages,
blocked model responses and unavailable internet can still cause failures.
No app can truthfully guarantee always-on free cloud AI.

## Build and verification

Fedora desktop (requires a configured Tauri/Rust toolchain):

```sh
cd apps/desktop
npm run build
npm run test:math
npm run test:ai-backups
npm run test:ai-worker
cd ../..
bash RUN_SMOOTH_APP.sh
```

Android (requires Android SDK/NDK + Rust Android targets):

```sh
cd apps/desktop
npm run android:apk
```

The TypeScript production build, Python worker tests, frontend math tests, and
browser UI tests with a simulated native backend were run for this patch.
Live calls to your Groq/OpenRouter/Gemini accounts have **not** been tested:
private API keys are not available. The Rust native build / Android APK could
not be compiled in the modification environment. Test the keys again in the
AI backups dialog on the actual device after rebuilding.
