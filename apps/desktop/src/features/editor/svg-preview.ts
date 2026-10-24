/**
 * SVG returned by /ask is displayed as an image, never injected as markup.
 * Browsers disable script execution in SVG loaded through <img>, but reject
 * active/external content too so a model response cannot fetch remote assets.
 * Keep the source in the editable code block, rather than storing a second copy.
 */
export function svgPreviewDataUrl(source: unknown, language: unknown): string | null {
  const raw = String(source ?? "").trim();
  const lang = String(language ?? "").trim().toLowerCase();
  if (raw.length < 11 || raw.length > 100_000) return null;
  const fenced = /^```(?:svg|xml)\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(raw);
  const svg = fenced ? fenced[1].trim() : raw;
  if (lang && lang !== "svg" && lang !== "svg+xml" && lang !== "xml" && !fenced) return null;
  // XML comments are inert, and models commonly add them to long diagrams.
  // Remove them only from the preview: the editable code block keeps the source.
  // Do this before checking for DOCTYPE/entity declarations, which must stay blocked.
  const cleaned = svg.replace(/<!--[\s\S]*?-->/g, "");
  // There must be one complete SVG document; never render an HTML fragment.
  if (!/^<svg(?=[\s>])[\s\S]*<\/svg\s*>$/i.test(cleaned)) return null;
  if (/<!|<\?|<\s*\/?\s*(?:script|foreignObject|iframe|frame|object|embed|image|audio|video|a|link)\b/i.test(cleaned)) return null;

  // Safe, embedded CSS is normal in detailed diagrams (classes, fill/stroke,
  // labels, and optional CSS animations). The previous blanket <style> ban
  // wrongly rejected valid medical and engineering drawings. Disallow all CSS
  // imports, remote/image-loading functions, escapes, and unknown at-rules.
  let unsupportedStyle = false;
  const withoutStyles = cleaned.replace(
    /<style(?:\s+type=(['"])text\/css\1)?\s*>([\s\S]*?)<\/style\s*>/gi,
    (_match, _quote: string | undefined, css: string) => {
      const strippedCss = css.replace(/\/\*[\s\S]*?\*\//g, "");
      if (/\/\*|\*\//.test(strippedCss) || /[<>\\]/.test(strippedCss) ||
          /@(?!(?:-webkit-)?keyframes\b)/i.test(strippedCss) ||
          /\b(?:image-set|cross-fade|paint|element)\s*\(/i.test(strippedCss)) {
        unsupportedStyle = true;
      }
      return "";
    },
  );
  if (unsupportedStyle || /<\s*\/?\s*style\b/i.test(withoutStyles)) return null;
  // No event handlers, remote references, stylesheets, data URIs, or XML entities.
  if (/\son[a-z][\w:-]*\s*=/i.test(cleaned) || /\b(?:javascript:|data:|file:|ftp:)/i.test(cleaned)) return null;
  if (/(?:@import\b|expression\s*\(|-moz-binding\b)/i.test(cleaned)) return null;
  // SVG paint servers may use url(#id), but external url(...) is not allowed.
  for (const match of cleaned.matchAll(/\burl\s*\(\s*([^)]*?)\s*\)/gi)) {
    const target = match[1].trim().replace(/^['"]|['"]$/g, "");
    if (!/^#[\w:.-]+$/.test(target)) return null;
  }
  // hrefs must be local fragment targets (supports <mpath href="#flow">).
  const references = cleaned.matchAll(/\b(?:href|xlink:href)\s*=\s*(['"])(.*?)\1/gi);
  for (const match of references) if (!/^#[\w:.-]+$/.test(match[2])) return null;
  // Require parseable SVG before passing it into an image decoder. DOMParser
  // is present in Tauri/WebView; pure checks above also run in Node tests.
  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(cleaned, "image/svg+xml");
    if (document.querySelector("parsererror") || document.documentElement.localName !== "svg" ||
      document.documentElement.namespaceURI !== "http://www.w3.org/2000/svg") return null;
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleaned)}`;
}
