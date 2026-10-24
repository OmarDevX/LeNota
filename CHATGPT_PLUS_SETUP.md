# LeNota AI priority: ChatGPT → Gemini → OpenRouter

## Important scope

LeNota desktop (Linux / Tauri) uses OpenAI's official, **locally hosted/open-source**
Sign in with ChatGPT flow. It requests separate authorization to consume eligible
ChatGPT-plan inference usage. This is not an ordinary OpenAI API key and does not
charge the OpenAI API account; it is subject to ChatGPT plan limits and eligibility.
The *mobile* Rust bridge remains **Gemini → OpenRouter** in this revision because
loopback OAuth and safe credential lifecycle have not been implemented for mobile.

Official documentation: https://developers.openai.com/siwc/token-sharing-open-source

## Setup (Fedora desktop)

1. Install the project's documented Rust/Tauri dependencies and Python 3.
2. Launch LeNota via `bash RUN_UPDATED_APP.sh` inside the `LeNota-mobile` directory.
3. Open **AI providers** from the drawing/editor toolbar.
4. Press **Continue with ChatGPT**; the *system browser* opens OpenAI authorization.
5. Approve the separate request to share your ChatGPT plan allowance with LeNota.
6. Return to LeNota after the browser shows a completion message.
7. Optionally retain your Gemini API key and OpenRouter API key as backups.
8. Try `/ask` or **Ask Selection** and check the returned `engine` field.

No ChatGPT account passwords, browser cookies, ChatGPT private backend APIs,
or unapproved OAuth impersonation are involved. Access and refresh tokens reside
only in the app's per-user AI directory with 0600 permissions on Unix. The native
worker validates OIDC signing keys, issuer, nonce, audience and account identity,
uses OAuth PKCE, and never passes credentials to the renderer.

If you need to revoke access, disconnect in LeNota, then verify access in
ChatGPT Settings → Usage / connected tools. Disconnect attempts refresh token
revocation and clears the local session regardless of network availability.

## Provider order

1. **ChatGPT Plus** via account-authorized `https://api.openai.com/v1/responses`,
   with `store:false` and `stream:true`. Model chosen from account's own `/v1/models`
   list; only `response.completed` is accepted as success.
2. **Gemini** via existing Google AI Studio key and Flash model fallback.
3. **OpenRouter free** via existing OpenRouter key, with named preferred models:
   text: NVIDIA Nemotron 3 Ultra → Nemotron 3 Super;
   images: Qwen3.8 27B → Gemma 4 31B.
   All calls specify `max_price` 0 for both input and output and `:free` model ids.

Groq is removed; legacy Groq secrets are discarded on app startup. Other stored
keys and note storage remain untouched.

## Known limitations

- This build has passed Python worker/OAuth mock tests, React/TypeScript tests
  and Chromium browser UI tests, but **has not had a live ChatGPT account sign-in
  or live AI inference test** with a user's credentials.
- A Linux Tauri native Rust compile was **not available in the build environment**.
  Build the native app locally. Do not mistake a built frontend for a validated RPM/AppImage.
- Free AI services and ChatGPT plan sharing may have usage limits, outages,
  model access restrictions, and system/network failure. Not an uptime guarantee.
- The model catalog and OpenRouter free tier change over time. An unavailable
  named free model automatically tries its next free alternative.
