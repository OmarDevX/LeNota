import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  actionForKeyboardEvent,
  actionForPointerEvent,
  appendInterpolatedInkPoints,
  BUILTIN_PEN_PRESETS,
  DEFAULT_INPUT_BINDINGS,
  eraseWholeStrokes,
  normalizePenPressure,
  parseCustomPenPresets,
  parseInputBindings,
  parsePressureCalibration,
  pressureStrokePath,
  readPointerPressure,
  smoothInkPath,
  smoothInkPoints,
  type InkStroke,
} from "../src/features/editor/pen-input.ts";

function stroke(id: string, y = 0): InkStroke {
  return {
    id,
    tool: "pen",
    color: "#111111",
    width: 3,
    points: [{ x: 0, y, pressure: .2 }, { x: 100, y, pressure: .9 }],
  };
}

test("fast pointer gaps are filled with bounded ink samples", () => {
  const points = [{ x: 0, y: 0, pressure: .2 }];
  const appended = appendInterpolatedInkPoints(points, [{ x: 24, y: 0, pressure: 1 }], 2.4);
  assert.ok(appended >= 10);
  assert.equal(points.at(-1)?.x, 24);
  for (let index = 1; index < points.length; index += 1) {
    assert.ok(Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y) <= 2.41);
  }
});

test("stroke eraser removes a complete connected stroke with one touch", () => {
  const strokes = [stroke("touched", 0), stroke("kept", 40)];
  const result = eraseWholeStrokes(strokes, [{ x: 55, y: 2, pressure: .5 }], 8);
  assert.deepEqual(result.map(item => item.id), ["kept"]);
});

test("pressure-sensitive strokes render as one variable filled outline", () => {
  const low = { ...stroke("low"), pressureEnabled: true, minPressureScale: .2, maxPressureScale: 1.6, points: [{ x: 0, y: 0, pressure: .1 }, { x: 100, y: 0, pressure: .1 }] };
  const high = { ...low, id: "high", points: [{ x: 0, y: 0, pressure: 1 }, { x: 100, y: 0, pressure: 1 }] };
  const lowPath = pressureStrokePath(low);
  const highPath = pressureStrokePath(high);
  assert.match(lowPath, /^M .+ Z$/);
  assert.ok((lowPath.match(/ a /g) ?? []).length >= 4, "both ends should use true circular caps");
  assert.notEqual(lowPath, highPath);
  assert.ok(BUILTIN_PEN_PRESETS.every(preset => preset.maxPressureScale - preset.minPressureScale >= .9));
});

test("tablet pressure is read, calibrated, and kept separate from geometry smoothing", () => {
  assert.deepEqual(readPointerPressure({ pointerType: "pen", pressure: .13 }, .5), { value: .13, source: "pressure" });
  assert.deepEqual(readPointerPressure({ pointerType: "pen", pressure: 0, force: .72 }, .2), { value: .72, source: "force" });
  assert.deepEqual(readPointerPressure({ pointerType: "mouse", pressure: .5 }, .25), { value: .5, source: "pressure" });
  assert.deepEqual(readPointerPressure({ pointerType: "mouse", pressure: .5 }, .25, .81), { value: .81, source: "native" });
  assert.deepEqual(readPointerPressure({ pointerType: "mouse", pressure: .28 }, .25, .81), { value: .28, source: "pressure" });
  const calibration = parsePressureCalibration(JSON.stringify({ minimum: .2, maximum: .8 }));
  assert.equal(normalizePenPressure(.2, calibration), 0);
  assert.equal(normalizePenPressure(.8, calibration), 1);
  assert.ok(normalizePenPressure(.5, calibration) > .49 && normalizePenPressure(.5, calibration) < .51);
});

test("fast sparse ink is fitted as an interpolating cubic curve instead of polygon edges", () => {
  const points = [
    { x: 0, y: 0, pressure: .5 },
    { x: 40, y: -24, pressure: .5 },
    { x: 80, y: 0, pressure: .5 },
    { x: 40, y: 24, pressure: .5 },
    { x: 0, y: 0, pressure: .5 },
  ];
  const smoothed = smoothInkPoints(points, .78);
  assert.deepEqual({ x: smoothed[0].x, y: smoothed[0].y }, { x: 0, y: 0 });
  assert.deepEqual({ x: smoothed.at(-1)?.x, y: smoothed.at(-1)?.y }, { x: 0, y: 0 });
  assert.ok(smoothed.length > points.length * 3, "pressure outline should sample the fitted curve densely");
  const centerline = smoothInkPath(points, .78);
  assert.match(centerline, / C /);
  assert.doesNotMatch(centerline, / Q /);
  // The first cubic control is deliberately off the first straight chord, so
  // sparse hardware vertices cannot render as a plain connected polygon.
  assert.notEqual(centerline, "M 0 0 L 40 -24 L 80 0 L 40 24 L 0 0");
  assert.match(pressureStrokePath({ ...stroke("curve"), points, pressureEnabled: true, smoothing: .78 }), / Q /);
});


test("shallow high-rate curves keep their real motion samples", () => {
  const points = Array.from({ length: 101 }, (_, index) => {
    const x = index * 2;
    return { x, y: .003 * (x - 100) * (x - 100), pressure: .5 };
  });
  const path = smoothInkPath(points, .86);
  const cubicCount = (path.match(/ C /g) ?? []).length;
  assert.ok(cubicCount >= 90, `expected shallow curvature samples to survive, got ${cubicCount} cubic segments`);
});

test("legacy straight-gap filler points no longer lock a fast turn into a polygon", () => {
  const points = [
    { x: 0, y: 0, pressure: .5 },
    { x: 7, y: 0, pressure: .5 },
    { x: 14, y: 0, pressure: .5 },
    { x: 21, y: 0, pressure: .5 },
    { x: 28, y: 0, pressure: .5 },
    { x: 35, y: 7, pressure: .5 },
    { x: 42, y: 14, pressure: .5 },
    { x: 49, y: 21, pressure: .5 },
  ];
  const path = smoothInkPath(points, .78);
  assert.match(path, / C /);
  const cubicCount = (path.match(/ C /g) ?? []).length;
  assert.ok(cubicCount < points.length - 1, "collinear synthetic points should be collapsed before fitting");
});

test("input bindings are device-neutral, persistent, and replaceable", () => {
  assert.equal(actionForKeyboardEvent({ code: "Space", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, DEFAULT_INPUT_BINDINGS), "temporaryPan");
  assert.equal(actionForPointerEvent({ button: 1 }, DEFAULT_INPUT_BINDINGS), "temporaryPan");
  assert.equal(actionForPointerEvent({ button: 2 }, DEFAULT_INPUT_BINDINGS), "temporaryEraser");
  assert.equal(actionForPointerEvent({ button: 5 }, DEFAULT_INPUT_BINDINGS), "temporaryEraser");
  assert.equal(actionForKeyboardEvent({ code: "KeyR", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, DEFAULT_INPUT_BINDINGS), "radialMenu");
  const parsed = parseInputBindings(JSON.stringify({ radialMenu: [{ type: "button", button: 4 }] }));
  assert.equal(actionForPointerEvent({ button: 4 }, parsed), "radialMenu");
  assert.equal(actionForKeyboardEvent({ code: "KeyR", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, parsed), null);
});

test("custom pencil presets are validated before use", () => {
  const presets = parseCustomPenPresets(JSON.stringify([{ id: "bad", name: " Soft pencil ", width: 999, opacity: -4, color: "red" }]));
  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, "Soft pencil");
  assert.equal(presets[0].width, 80);
  assert.equal(presets[0].opacity, .05);
  assert.equal(presets[0].color, "#d4d4d8");
  assert.ok(presets[0].id.startsWith("custom-"));
});

test("editor consumes coalesced stylus events in animation-frame batches", () => {
  const editor = readFileSync(new URL("../src/features/editor/page-editor.tsx", import.meta.url), "utf8");
  const native = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(editor, /getCoalescedEvents/);
  assert.match(editor, /pointerrawupdate/);
  assert.match(editor, /lenota-native-stylus/);
  assert.match(native, /connect_event_after/);
  assert.doesNotMatch(native, /PropagationPhase::Capture/);
  assert.doesNotMatch(native, /GestureStylus::new/);
  assert.match(native, /AxisUse::Pressure/);
  assert.match(native, /gdk_window_set_event_compression/);
  assert.match(native, /pressure\.unwrap_or\(0\.5\)/);
  assert.match(native, /lenota-native-stylus/);
  assert.match(editor, /nativeInkMotionRef/);
  assert.match(editor, /nativeMotionActive/);
  assert.match(editor, /inkPreviewFrameRef\.current=requestAnimationFrame/);
  assert.match(editor, /eraseWholeStrokes/);
  assert.match(editor, /<CommittedInkLayer/);
  assert.match(editor, /Live pressure test/);
  assert.match(editor, /Use detected range/);
  assert.match(editor, /readPointerPressure/);
  assert.match(editor, /temporaryPanActiveRef/);
  assert.match(editor, /beginCanvasPan/);
  assert.match(editor, /aria-label="Pencil wheel"/);
  assert.match(editor, /Key & pen-button bindings/);
});

test("finished ink previews clear at React commit before paint, never in a delayed animation frame",()=>{
  const editor=readFileSync(new URL("../src/features/editor/page-editor.tsx",import.meta.url),"utf8");
  assert.match(editor,/useLayoutEffect\(\(\)=>\{[\s\S]*?if\(drawingRef\.current\)return;\s*liveInkBakedPreviewRef\.current\?\.setAttribute\("d",""\);\s*liveInkPreviewRef\.current\?\.setAttribute\("d",""\);\s*\},\[ink\]\)/);
  assert.doesNotMatch(editor,/requestAnimationFrame\(\(\)=>\{if\(!drawingRef\.current\)/);
});


test("live pen rendering stays off React's per-frame hot path", () => {
  const editor = readFileSync(new URL("../src/features/editor/page-editor.tsx", import.meta.url), "utf8");
  assert.match(editor, /data-live-ink-preview-group="true"/);
  assert.match(editor, /BAKE_CHUNK_POINTS=240/);
  assert.match(editor, /Number\.POSITIVE_INFINITY/);
  assert.match(editor, /sampleTime<lastHardwareTime-\.01/);
  assert.match(editor, /only commit the immutable stroke to React on pointer-up/);
});

test("pressure preview chunks can suppress internal round caps", () => {
  const sample = { ...stroke("chunk"), pressureEnabled: true };
  const defaultPath = pressureStrokePath(sample);
  const chunkPath = pressureStrokePath(sample, { capStart: false, capEnd: false });
  assert.ok((defaultPath.match(/ a /g) ?? []).length >= 4);
  assert.equal((chunkPath.match(/ a /g) ?? []).length, 0);
});

test("empty workspaces and compact windows keep creation and navigation reachable", () => {
  const app = readFileSync(new URL("../src/app.tsx", import.meta.url), "utf8");
  const editor = readFileSync(new URL("../src/features/editor/page-editor.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(app, /async function createFirstNote\(\)/);
  assert.match(editor, /Create your first note/);
  assert.match(css, /\.empty-workspace-card/);
  assert.match(css, /data-compact-layout="true"/);
  assert.match(css, /@media \(max-width: 660px\)/);
});
