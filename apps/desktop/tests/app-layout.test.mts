import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appGridTemplate, canvasViewportTransform, fitCanvasBounds, focusLayoutIsVisible, normalizeCanvasViewport } from "../src/features/layout/app-layout.ts";
import { clearInterfacePreferences, discardPersistedFocusMode, INTERFACE_PREFERENCE_KEYS } from "../src/features/layout/ui-preferences.ts";
import { LENOTA_VERSION } from "../src/build-info.ts";
import { orderFocusPages } from "../src/features/navigation/focus-pages.ts";
import { convertedInkColor, representativeInkColor } from "../src/features/editor/ink-output-color.ts";
import { customSizeOr, parseCustomSize } from "../src/features/editor/custom-size.ts";

test("focus mode gives the editor one non-zero grid track", () => {
  assert.equal(appGridTemplate({
    focusMode: true,
    navigationWidth: 310,
    navigationCollapsed: false,
    resizerWidth: 8,
  }), "minmax(0, 1fr)");
});

test("focus pages keep persisted sibling order and place children after their parent", () => {
  const pages = [
    { id: "page-2", parentPageId: null },
    { id: "child-2", parentPageId: "page-2" },
    { id: "page-1", parentPageId: null },
    { id: "child-1", parentPageId: "page-1" },
  ];
  assert.deepEqual(orderFocusPages(pages).map((page) => page.id), ["page-2", "child-2", "page-1", "child-1"]);
});

test("focus page ordering does not move the selected page to the front", () => {
  const pages = [
    { id: "first", parentPageId: null },
    { id: "selected", parentPageId: null },
    { id: "third", parentPageId: null },
  ];
  assert.deepEqual(orderFocusPages(pages).map((page) => page.id), ["first", "selected", "third"]);
});

test("normal mode preserves rail, navigator, resizer, and editor tracks", () => {
  assert.equal(appGridTemplate({
    focusMode: false,
    navigationWidth: 310,
    navigationCollapsed: false,
    resizerWidth: 8,
  }), "70px 310px 8px minmax(0, 1fr)");
});

test("collapsed normal navigation removes both left navigation tracks", () => {
  assert.equal(appGridTemplate({
    focusMode: false,
    navigationWidth: 310,
    navigationCollapsed: true,
    resizerWidth: 8,
  }), "0px 0px 8px minmax(0, 1fr)");
});

test("normal notebook panel uses live resize geometry instead of a hard-coded width", () => {
  const appSource = readFileSync(new URL("../src/app.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(appSource, /--ln-navigation-total-width/);
  assert.match(appSource, /is-navigation-collapsed/);
  assert.match(css, /\.navigation-drawer \{[\s\S]*?width: var\(--ln-navigation-total-width, 350px\) !important;/);
  assert.match(css, /\.sidebar-resizer \{[\s\S]*?left: var\(--ln-navigation-resizer-left, 342px\) !important;/);
  assert.match(css, /\.is-navigation-collapsed \.navigation-drawer \{[\s\S]*?display: none !important;/);
});

test("focus mode rejects a blank or collapsed editor layout", () => {
  assert.equal(focusLayoutIsVisible({ width: 1500, height: 900 }, { width: 1500, height: 720 }), true);
  assert.equal(focusLayoutIsVisible({ width: 0, height: 900 }, { width: 0, height: 720 }), false);
  assert.equal(focusLayoutIsVisible({ width: 1500, height: 900 }, { width: 1500, height: 0 }), false);
  assert.equal(focusLayoutIsVisible(null, null), false);
});

test("canvas viewport uses a WebKit-friendly 2D transform and clamps unsafe values", () => {
  assert.deepEqual(normalizeCanvasViewport({ x: Number.NaN, y: 90000, zoom: 9 }), { x: 100, y: 50000, zoom: 2.5 });
  assert.equal(canvasViewportTransform({ x: 40, y: 60, zoom: 1.2 }), "translate(40px, 60px) scale(1.2)");
});

test("fit canvas keeps full content inside the visible frame", () => {
  const viewport = fitCanvasBounds({ left: 100, top: 200, right: 1100, bottom: 800 }, 1200, 800, 80, 1.25);
  assert.equal(viewport.zoom, 1.04);
  assert.equal(viewport.x, -24);
  assert.equal(viewport.y, -128);
});

test("startup discards an old persisted focus mode value", () => {
  const values = new Map([["lenota:appearance:focus-mode", "true"]]);
  const storage = { removeItem: (key: string) => { values.delete(key); } };
  assert.equal(discardPersistedFocusMode(storage), false);
  assert.equal(values.has("lenota:appearance:focus-mode"), false);
});

test("interface reset preserves note and recovery data", () => {
  const values = new Map<string, string>([
    ...INTERFACE_PREFERENCE_KEYS.map((key) => [key, "saved"] as const),
    ["lenota:recovery:page-1", "important draft"],
    ["unrelated", "keep"],
  ]);
  clearInterfacePreferences({ removeItem: (key: string) => { values.delete(key); } });
  for (const key of INTERFACE_PREFERENCE_KEYS) assert.equal(values.has(key), false);
  assert.equal(values.get("lenota:recovery:page-1"), "important draft");
  assert.equal(values.get("unrelated"), "keep");
});

test("light theme does not turn hover utilities into permanent fills", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.equal(css.includes('[class*="bg-white/"]'), false);
  assert.equal(css.includes('[class~="hover:bg-white/8"]:hover'), true);
  assert.equal(css.includes('html[data-theme="light"] .canvas-floating-ui'), true);
});

test("focus mode is one full-screen canvas with floating chrome", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.editor-shell\.is-focus-mode \.editor-title-bar \{\s*display: none !important;/);
  assert.match(css, /\.editor-shell\.is-focus-mode \.editor-stage \{[\s\S]*?inset: 0;[\s\S]*?width: 100vw;[\s\S]*?height: 100vh;/);
  assert.match(css, /\.editor-shell\.is-focus-mode \.note-canvas \{[\s\S]*?position: absolute;[\s\S]*?inset: 0;/);
  assert.match(css, /\.editor-shell\.is-focus-mode \.topbar-editor-tools \{[\s\S]*?top: 140px !important;/);
  assert.equal(css.includes(".editor-shell.is-focus-mode .topbar-editor-tools { display: none !important; }"), false);
});

test("normal mode exposes visible Layers and Fill controls", () => {
  const editorSource = readFileSync(new URL("../src/features/editor/page-editor.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(editorSource, /aria-label="Layer and fill tools"/);
  assert.match(editorSource, /<Layers className="size-4"\/><span>Layers<\/span>/);
  assert.match(editorSource, /<PaintBucket className="size-4"\/><span>Fill<\/span>/);
  assert.match(css, /\.editor-shell:not\(\.is-focus-mode\) \.normal-selection-tools \{[\s\S]*?right: 326px !important;/);
  assert.match(css, /\.normal-selection-tools > button:disabled \{[\s\S]*?opacity: \.72 !important;/);
});

test("focused mode keeps the classic large toolbar and contextual shelves", () => {
  const editorSource = readFileSync(new URL("../src/features/editor/page-editor.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(editorSource, /mode==="write"\)\{setDrawingTool\("select"\);setToolShelfOpen\(true\);\}/);
  assert.match(editorSource, /setToolShelfOpen\(!focusMode\)/);
  assert.match(editorSource, /if \(focusMode\) \{[\s\S]*?setToolShelfOpen\(false\);/);
  assert.match(editorSource, /topbar-editor-tools no-print/);
  assert.match(css, /\.editor-shell\.is-focus-mode \.editor-mode-bar \{[\s\S]*?width: 712px !important;[\s\S]*?height: 69px !important;/);
  assert.match(css, /\.editor-shell\.is-focus-mode \.app-topbar-actions \{[\s\S]*?position: fixed !important;[\s\S]*?top: auto !important;[\s\S]*?bottom: 92px !important;/);
  assert.match(css, /\.app-shell > \.fixed \{\s*z-index: 2000000 !important;/);
});

test("normal light and focus dark own every previously hard-coded surface", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /html\[data-theme="light"\] \.app-shell:not\(\.is-focus-mode\) \.navigation-drawer \{/);
  assert.match(css, /html\[data-theme="light"\] \.editor-shell:not\(\.is-focus-mode\) \.editor-status-bar \{/);
  assert.match(css, /html\[data-theme="dark"\] \.editor-shell\.is-focus-mode \.editor-mode-bar \{/);
  assert.match(css, /html\[data-theme="dark"\] \.editor-shell\.is-focus-mode \.topbar-editor-tools \{/);
  assert.match(css, /html\[data-theme="light"\] \[data-ln-text-color="#d4d4d8"\]/);
  assert.match(css, /html\[data-theme="dark"\] \[data-math-color="#2f3138"\]/);
});

test("focus mode and appearance are independent settings", () => {
  const appSource = readFileSync(new URL("../src/app.tsx", import.meta.url), "utf8");
  assert.match(appSource, /useState<AppTheme>\(readStoredTheme\)/);
  assert.equal(appSource.includes('setTheme(focusMode ? "dark" : "light")'), false);
});

test("converted ink uses the color visible in the active theme", () => {
  const lightDefault = [{ tool: "pen" as const, color: "#d4d4d8", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }];
  const darkDefault = [{ tool: "pen" as const, color: "#2f3138", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }];
  const custom = [{ tool: "pen" as const, color: "#e11d48", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }];
  assert.equal(convertedInkColor(lightDefault, "light"), "#2f3138");
  assert.equal(convertedInkColor(darkDefault, "dark"), "#d4d4d8");
  assert.equal(convertedInkColor(custom, "light"), "#e11d48");
  assert.equal(convertedInkColor(custom, "dark"), "#e11d48");
});

test("converted ink chooses the dominant pen and falls back to highlighter color", () => {
  const mixed = [
    { tool: "pen" as const, color: "#ef4444", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { tool: "pen" as const, color: "#2563eb", points: [{ x: 0, y: 0 }, { x: 80, y: 0 }] },
    { tool: "highlighter" as const, color: "#fde047", points: [{ x: 0, y: 0 }, { x: 500, y: 0 }] },
  ];
  assert.equal(representativeInkColor(mixed), "#2563eb");
  assert.equal(representativeInkColor([mixed[2]]), "#fde047");
});

test("custom sizes accept arbitrary positive integers and decimals without a preset ceiling", () => {
  assert.equal(parseCustomSize("2.75"), 2.75);
  assert.equal(parseCustomSize("12345.678"), 12345.678);
  assert.equal(parseCustomSize("0"), null);
  assert.equal(parseCustomSize("not-a-number"), null);
  assert.equal(customSizeOr("", 24), 24);
});

test("size controls are typed fields with retained recommended choices", () => {
  const editorSource = readFileSync(new URL("../src/features/editor/page-editor.tsx", import.meta.url), "utf8");
  assert.match(editorSource, /type="number"[\s\S]*list=\{listId\}/);
  assert.match(editorSource, /aria-label=\{`\$\{ariaLabel\} recommended values`\}/);
  assert.match(editorSource, /title="Font size — type any positive value"/);
  assert.match(editorSource, /title="Pen\/highlighter width — type any positive value"/);
  assert.match(editorSource, /title="Equation size — type any positive value"/);
  assert.match(editorSource, /recommended=\{\[8,9,10,11,12,14,16,18,20,24,28,32,36,48,64,72\]\}/);
  assert.equal(editorSource.includes('title="Font size" aria-label="Font size" value={fontSize}'), false);
});


test("normal toolbar owns Layers and Fill, Inspector is reachable, and canvas settings drive both modes", () => {
  const editorSource = readFileSync(new URL("../src/features/editor/page-editor.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(editorSource, /contextTools=\{!focusMode\?<div className="workspace-context-tools"/);
  assert.match(editorSource, /title="Fill tool — click a rectangle or ellipse to fill it" aria-label="Fill" aria-pressed=\{drawingTool==="fill"\}/);
  assert.match(editorSource, /type DrawingTool = [^;]*"fill"/);
  assert.match(editorSource, /if\(drawingTool==="fill"\)\{[\s\S]*?dataset\.shapeId[\s\S]*?mutateShapes/);
  assert.match(editorSource, /const \[shapeFillColor, setShapeFillColor\] = useState\("transparent"\)/);
  assert.match(editorSource, /fill:\(drawingTool==="rectangle"\|\|drawingTool==="ellipse"\)\?shapeFillColor:"transparent"/);
  assert.match(editorSource, /aria-label="Toggle inspector" aria-pressed=\{inspectorOpen\}/);
  assert.match(editorSource, /--ln-page-background-image/);
  assert.match(editorSource, /stateRef\.current=\{\.\.\.stateRef\.current,background:next\}/);
  assert.match(editorSource, /setProperty\("--ln-page-background-position"/);
  assert.match(css, /html\[data-theme\] \.editor-shell:not\(\.is-focus-mode\) \.note-canvas,[\s\S]*?background-image: var\(--ln-page-background-image, none\) !important;/);
  assert.match(css, /\.workspace-context-tools \{/);
  assert.match(css, /\.page-inspector-action \{[\s\S]*?position: static !important;[\s\S]*?display: grid !important;/);
  assert.match(css, /\.editor-shell \.note-canvas \{[\s\S]*?background-image: var\(--ln-page-background-image, none\) !important;/);
});

test("the visible build marker matches package and Tauri versions", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const tauriConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { version: string; app: { windows: Array<{ title: string }> } };
  assert.equal(packageJson.version, LENOTA_VERSION);
  assert.equal(tauriConfig.version, LENOTA_VERSION);
  assert.equal(tauriConfig.app.windows[0]?.title.includes(LENOTA_VERSION), true);
});
