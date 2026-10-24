import assert from "node:assert/strict";
import test from "node:test";
import { svgPreviewDataUrl } from "../src/features/editor/svg-preview.ts";

const animated = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="380" viewBox="0 0 640 380">
<defs><path id="flow" d="M100 172 V100 H540 V280 H100 V208"/></defs>
<circle fill="orange" r="7"><animateMotion dur="6s" repeatCount="indefinite"><mpath href="#flow"/></animateMotion></circle>
</svg>`;

test("SVG diagrams render as an image data URI, retaining SMIL animation", () => {
  const url = svgPreviewDataUrl(animated, "svg");
  assert.ok(url?.startsWith("data:image/svg+xml;charset=utf-8,"));
  assert.match(decodeURIComponent(url!.split(",")[1]), /<animateMotion/);
  assert.match(decodeURIComponent(url!.split(",")[1]), /<mpath href="#flow"/);
});

test("SVG fences and XML-labelled SVGs can be previewed", () => {
  assert.ok(svgPreviewDataUrl("```svg\n"+animated+"\n```", null));
  assert.ok(svgPreviewDataUrl(animated,"SVG"));
  assert.ok(svgPreviewDataUrl(animated,"xml"));
  assert.ok(svgPreviewDataUrl(animated,null));
  assert.equal(svgPreviewDataUrl(animated,"typescript"),null);
});

test("ordinary code, malformed SVG, and oversized sources stay as editable code", () => {
  for(const [source,language] of [
    ["print('hi')","python"],
    ["<svg><circle /></svg><div>bad</div>","svg"],
    ["<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".repeat(10_000),"svg"],
  ] as const) assert.equal(svgPreviewDataUrl(source,language),null);
});

test("potentially active, cross-origin, or embedded HTML SVG is never previewed", () => {
  for(const payload of [
    '<script>alert(1)</script>',
    '<foreignObject><body>HTML</body></foreignObject>',
    '<image href="https://example.org/track.png"/>',
    '<a href="https://example.org">click</a>',
    '<circle onload="alert(1)"/>',
    '<use href="javascript:alert(1)"/>',
    '<style>@import url(https://example.org/foo.css)</style>',
    '<rect fill="url(https://example.org/track.svg#x)"/>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>',
  ]){
    const document=`<svg xmlns="http://www.w3.org/2000/svg">${payload}</svg>`;
    assert.equal(svgPreviewDataUrl(document,"svg"),null,payload);
  }
});

test("gradient paint references (internal url(#id)) are permitted", () => {
  const svg='<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="sky"/></defs><rect fill="url(#sky)" width="20" height="20"/></svg>';
  assert.ok(svgPreviewDataUrl(svg,"svg"));
});


test("detailed labeled SVGs can use harmless XML comments and embedded CSS", () => {
  const heart = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 1060">
    <defs>
      <linearGradient id="muscle"><stop stop-color="#dc8984"/><stop offset="1" stop-color="#853840"/></linearGradient>
      <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5 0 7Z"/></marker>
      <style>text{font-family:Arial,Helvetica,sans-serif;fill:#213342}.label{font-size:18px;font-weight:600}.flow{fill:none;stroke:#16799d;stroke-width:3;marker-end:url(#arrow)}</style>
    </defs>
    <!-- Myocardial envelope -->
    <path d="M0 0H400V500Z" fill="url(#muscle)" />
    <!-- Valve labels -->
    <text x="30" y="44" class="label">Heart valves</text>
  </svg>`;
  const preview = svgPreviewDataUrl(heart, "svg");
  assert.ok(preview);
  const renderedSvg = decodeURIComponent(preview.split(",")[1]);
  assert.match(renderedSvg, /<style>text\{/);
  assert.match(renderedSvg, /marker-end:url\(#arrow\)/);
  assert.doesNotMatch(renderedSvg, /<!--/);
});

test("CSS keyframe animation and safe inline styles are allowed", () => {
  const animation = `<svg xmlns="http://www.w3.org/2000/svg"><style>
    @keyframes pulse { from {opacity: 0.2;} to {opacity: 1;} }
    .pulsing { animation: pulse 1s ease-in-out infinite; fill: #a33; }
  </style><circle class="pulsing" cx="15" cy="15" r="10" style="stroke:#222;stroke-width:2"/></svg>`;
  assert.ok(svgPreviewDataUrl(animation, "svg"));
});

test("comments and stylesheets cannot bypass SVG restrictions", () => {
  const badSvg = [
    '<!-- harmless --> <script>alert(1)</script>',
    '<!-- <script>comment</script> --> <foreignObject><div/></foreignObject>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>',
    '<style>@import "https://example.org/a.css";</style>',
    '<style>.x{fill:url(https://example.org/external.svg#x)}</style>',
    '<style>.x{background-image:image-set("https://example.org/external.png")}</style>',
    '<style>.x{fill:url(\\68ttp://example.org/external.svg)}</style>',
    '<style type="text/css" onload="alert(1)">.x{fill:red}</style>',
    '<style>.x{fill:red}</style><style src="https://example.org/a.css"/>',
    '<style>@font-face {font-family:evil;src:url(https://example.org/font.woff)}</style>',
    '<!-- unclosed comment <circle/>',
  ];
  for (const payload of badSvg) {
    assert.equal(svgPreviewDataUrl(`<svg xmlns="http://www.w3.org/2000/svg">${payload}</svg>`, "svg"), null, payload);
  }
});
