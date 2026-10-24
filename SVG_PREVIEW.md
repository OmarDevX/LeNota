# Animated SVG diagrams in /ask and Ask Selection

When ChatGPT, Gemini, or an OpenRouter backup returns SVG source in a `code` note
block with `language: "svg"`, LeNota now previews it as an **SVG image** instead of
printing only source code. Declarative SVG/SMIL animations (for example,
`<animateMotion>`) run if supported by the device's WebView.

The note keeps the original editable SVG source in its code block. Use **Show
source** to view/edit it, then **Show preview** to return to the diagram. SVG
blocks saved by earlier versions also use the new renderer when reopened.

If an AI returns a Markdown ` ```svg ` fence inside a paragraph, LeNota also
converts that fenced section into an SVG code block during /ask insertion.
Other code blocks are unaffected.

Example request:

    /ask Create an animated SVG showing conventional current moving around a battery-resistor circuit, with labeled battery terminals and resistor.

Ask specifically for an **animated SVG** when you want motion. The `/image`
API generates static PNG images, not animation.

Safety: SVG is loaded using `<img>` (never arbitrary inline HTML). Detailed diagrams
may use embedded `<style>` rules (including local gradients, CSS classes and
keyframe animations) and harmless XML comments. Comments are removed from the
preview image only; the original editable code is unchanged. Scripts, event
handlers, external references, CSS imports, embedded HTML, invalid XML and
oversized files stay visible as source instead of being executed.

Validation: TypeScript typecheck and production frontend build; editor unit
tests, SVG-specific tests, and Python AI-worker tests. A Chromium preview test
confirmed that a SMIL-animated SVG changes over time. Live desktop/mobile
Tauri generation is not covered by those checks.

October 2026 compatibility fix: the earlier preview rejected `<style>` and
`<!-- comments -->` unconditionally. Existing notes containing such valid SVGs
now display automatically after restarting the updated app; regenerate only if
the actual SVG was malformed or uses an unsupported external asset.
