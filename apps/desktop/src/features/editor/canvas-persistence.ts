import type { InkStroke } from "./pen-input.ts";

interface CanvasParts<C, S, B, M> {
  containers: C[];
  ink: InkStroke[];
  shapes: S[];
  background: B;
  aiMemory: M[];
}

/** Committed canvas data is replaced on edit, never changed in place. Only
 * the currently drawn stroke has mutable points and needs a private copy. */
export function captureCanvasSnapshot<C, S, B, M>(
  state: CanvasParts<C, S, B, M>, liveStroke: InkStroke | null = null,
): CanvasParts<C, S, B, M> {
  return {
    containers: state.containers,
    ink: liveStroke ? state.ink.map(stroke => stroke === liveStroke
      ? { ...stroke, points: stroke.points.map(point => ({ ...point })) } : stroke) : state.ink,
    shapes: state.shapes,
    background: state.background,
    aiMemory: state.aiMemory,
  };
}

interface SerializableCanvas extends CanvasParts<object, object, object, object> {
  type: string;
  version: number;
  viewport: object;
}

/** Keep the existing on-disk JSON format, but encode unchanged geometry once.
 * Weak references let deleted data and evicted undo entries be collected. */
export function createCanvasSerializer() {
  const objects = new WeakMap<object, string>();
  const arrays = new WeakMap<object[], string>();
  const encode = (value: object, mutable: object | null) => {
    if (value === mutable) return JSON.stringify(value);
    const previous = objects.get(value);
    if (previous !== undefined) return previous;
    const json = JSON.stringify(value);
    objects.set(value, json);
    return json;
  };
  const encodeList = (values: object[], mutable: object | null = null) => {
    const cacheable = !mutable || !values.includes(mutable);
    const previous = cacheable ? arrays.get(values) : undefined;
    if (previous !== undefined) return previous;
    const json = `[${values.map(value => encode(value, mutable)).join(",")}]`;
    if (cacheable) arrays.set(values, json);
    return json;
  };
  return (document: SerializableCanvas, liveStroke: InkStroke | null = null): string =>
    `{"type":${JSON.stringify(document.type)},"version":${JSON.stringify(document.version)},` +
    `"viewport":${encode(document.viewport, null)},"containers":${encodeList(document.containers)},` +
    `"ink":${encodeList(document.ink, liveStroke)},"shapes":${encodeList(document.shapes)},` +
    `"background":${encode(document.background, null)},"aiMemory":${encodeList(document.aiMemory)}}`;
}
