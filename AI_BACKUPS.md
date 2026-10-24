# AI provider configuration

See [CHATGPT_PLUS_SETUP.md](CHATGPT_PLUS_SETUP.md).

This version prioritizes ChatGPT Plus via official open-source Sign in with ChatGPT,
then Gemini, then quality-selected OpenRouter free models. Groq has been removed.

### AI error mentioning “Temporary failure in name resolution”

This is a **network DNS problem**, not an API quota error. LeNota cannot
reach the AI host even if the API key and ChatGPT login are valid. Run
`bash CHECK_AI_NETWORK.sh` from the project root on the affected Fedora
computer. It checks DNS and HTTPS only (no credentials are accessed).
If `DNS: FAILED` appears on multiple providers, inspect `resolvectl status`
and your active NetworkManager connection. Restarting the app or changing API
keys will not repair a broken resolver. Network/timeout errors never trigger
the app's quota cooldown, so retrying as soon as connectivity is restored works.

### Slow /ask requests and provider timeouts

Detailed ChatGPT Plus answers may take more than 45 seconds. `/ask` now gives
the primary provider up to ~90 seconds, while reserving time for Gemini and
OpenRouter (the full request may take ~150 seconds). A timeout means the
provider did not finish in time; it is not proof of a subscription problem.

OpenRouter free models are verified against the live `/api/v1/models` catalog,
including image-input support and zero prices, before attempting requests. If
its catalog is unreachable, the fallback is a short list of named free variants
with `provider.max_price=0` (never the random `openrouter/free` route). A 429
may still mean the account has exhausted its free-rate limit.
