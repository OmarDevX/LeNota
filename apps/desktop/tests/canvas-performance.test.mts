import assert from "node:assert/strict";
import test from "node:test";
import { captureCanvasSnapshot, createCanvasSerializer } from "../src/features/editor/canvas-persistence.ts";
import { createCallbackRelay } from "../src/features/editor/callback-relay.ts";
import { appendInterpolatedInkPoints, type InkStroke } from "../src/features/editor/pen-input.ts";

const makeStroke = (id: string): InkStroke => ({ id, tool: "pen", color: "#123456", width: 2.5,
  pressureEnabled: true, smoothing: .86, points: [{ x: 10, y: 12, pressure: .1 }, { x: 23, y: 38, pressure: .9 }] });
const document = () => ({ type: "lenota-canvas", version: 3, viewport: { x: 88, y: 72, zoom: 1 },
  containers: [{ id: "note", x: 2, y: 4, width: 900, content: { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: 'Quotes "\\ LaTeX عربي Türkçe 🖊️\n' }] },
    { type: "image", attrs: { attachmentId: "pdf-1", src: "asset://page.png", ocrText: "OCR text" } },
  ] } }], ink: [makeStroke("ink")], shapes: [{ id: "shape", kind: "path", pathLoops: [[{ x: 1, y: 2 }]] }],
  background: { pattern: "grid", color: "#ffffff", spacing: 24 }, aiMemory: [{ containerId: "note", prompt: "Q", answer: "A" }] });

test("optimized saves remain byte-for-byte identical to the existing canvas JSON", () => {
  const encode = createCanvasSerializer();
  let current = document();
  assert.equal(encode(current), JSON.stringify(current));
  for (let frame = 0; frame < 80; frame++) {
    current = { ...current, viewport: { ...current.viewport, x: frame },
      ink: [...current.ink, makeStroke(`ink-${frame}`)] };
    assert.equal(encode(current), JSON.stringify(current));
    const changed = { ...current.containers[0], width: 300 + frame,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Edit ${frame}` }] }] } };
    current = { ...current, containers: [changed] };
    assert.equal(encode(current), JSON.stringify(current));
  }
  current = { ...current, ink: current.ink.slice(20), shapes: [], aiMemory: [], background: { ...current.background, pattern: "plain" } };
  assert.equal(encode(current), JSON.stringify(current));
});

test("saving a growing live stroke never reuses stale point JSON", () => {
  const encode = createCanvasSerializer();
  const current = document(), live = current.ink[0];
  for (let i = 0; i < 5; i++) {
    appendInterpolatedInkPoints(live.points, [{ x: 50 + i, y: 50, pressure: .7 }], Infinity);
    assert.equal(encode(current, live), JSON.stringify(current));
  }
  const committed = { ...current, ink: [{ ...live, points: [...live.points] }] };
  assert.equal(encode(committed), JSON.stringify(committed));
});

test("undo snapshots preserve editing, moving, deleting, and redo data", () => {
  const initial = document();
  const before = captureCanvasSnapshot(initial);
  const expected = JSON.stringify(before);
  const edited = { ...initial, containers: [{ ...initial.containers[0], x: 100,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Changed" }] }] } }],
    ink: initial.ink.map(stroke => ({ ...stroke, points: stroke.points.map(p => ({ ...p, x: p.x + 20 })) })),
    shapes: [{ ...initial.shapes[0], pathLoops: [[{ x: 9, y: 10 }]] }],
    background: { ...initial.background, color: "#121212" }, aiMemory: [] };
  const redo = captureCanvasSnapshot(edited);
  const removed = { ...edited, ink: [], containers: [], shapes: [] };
  assert.equal(JSON.stringify(before), expected);
  const { type: _type, version: _version, viewport: _viewport, ...editedCanvas } = edited;
  assert.deepEqual(captureCanvasSnapshot(redo), editedCanvas);
  assert.equal(removed.ink.length, 0);
  assert.equal(before.ink.length, 1);
  assert.strictEqual(before.ink[0].points, initial.ink[0].points, "completed geometry is shared, not duplicated");
});

test("a snapshot taken during drawing isolates mutable live points", () => {
  const current = document(), live = current.ink[0];
  const before = captureCanvasSnapshot(current, live);
  const expected = JSON.stringify(before);
  live.points[0].pressure = .8;
  appendInterpolatedInkPoints(live.points, [{ x: 70, y: 90, pressure: 1 }], Infinity);
  assert.equal(JSON.stringify(before), expected);
  assert.notStrictEqual(before.ink[0].points, live.points);
});

test("memoized container events retain their identity and use the current selection", () => {
  let selected = "old", last = "", calls = 0;
  const relay = createCallbackRelay({ move: (id: string, dx: number) => { last = `${selected}:${id}:${dx}`; calls++; }, read: () => selected });
  const move = relay.callbacks.move, read = relay.callbacks.read;
  selected = "new";
  relay.update({ move: (id: string, dx: number) => { last = `${selected}:${id}:${dx * 2}`; calls++; }, read: () => selected });
  assert.strictEqual(move, relay.callbacks.move);
  move("pdf-note", 3);
  assert.equal(last, "new:pdf-note:6");
  assert.equal(calls, 1);
  assert.equal(read(), "new");
});
