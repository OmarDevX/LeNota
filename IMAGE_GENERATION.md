# Free SVG image responses in LeNota

The default `/image` command now uses **your existing text AI provider** (ChatGPT sign-in, Gemini, or an already configured free text provider) to generate a **rendered SVG vector illustration**. The app previews the SVG rather than showing raw code. There are **no additional image API charges** from this route.

Use any of these prompts:

- `/image demonstrate conventional current moving around a battery and resistor circuit`
- `/ask make an image showing the chambers of the human heart`
- **Ask Selection** → `turn this selection into a labeled diagram`
- `/ask create an animated SVG of electrons in a wire`

SVG is especially good for diagrams, educational illustrations, and animations. It is **not photorealistic bitmap generation**, and drawing accuracy depends on the selected text model. SVG code remains available via **Show source**.

**Optional, separate, paid route:** Only users who explicitly enter `/raster ...` and have configured the separately billed **OpenAI Images API** key will send a PNG generation request. `/image`, natural-language `/ask` image requests, and Ask Selection never invoke the billable OpenAI Images API. An API key is not required for free SVG requests. If you never want additional charges, do not configure an image API key or use `/raster`.

The free SVG path needs an available text-model connection and may still consume the normal allowance of that already-connected provider. It cannot generate photo-real images. It also does not automatically download or run a local diffusion model.

OpenAI's Sign in with ChatGPT plan-sharing route does not support image-generation tools; this SVG method uses supported text generation instead. See https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.
