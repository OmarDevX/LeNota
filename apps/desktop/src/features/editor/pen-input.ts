export interface InkPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface PressureCalibration {
  minimum: number;
  maximum: number;
}

export interface PointerPressureSample {
  pressure?: number;
  pointerType?: string;
  force?: number;
  webkitForce?: number;
}

export interface PointerPressureReading {
  value: number;
  source: "pressure" | "force" | "webkitForce" | "native" | "fallback";
}

export type PenKind = "pencil" | "ballpoint" | "fountain" | "felt-tip" | "custom";

export interface PenPreset {
  id: string;
  name: string;
  kind: PenKind;
  color: string;
  width: number;
  opacity: number;
  pressureEnabled: boolean;
  minPressureScale: number;
  maxPressureScale: number;
  smoothing: number;
  custom?: boolean;
}

export interface InkStroke {
  id: string;
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  points: InkPoint[];
  opacity?: number;
  pressureEnabled?: boolean;
  minPressureScale?: number;
  maxPressureScale?: number;
  smoothing?: number;
  penKind?: PenKind;
  presetId?: string;
}

export const BUILTIN_PEN_PRESETS: readonly PenPreset[] = [
  {
    id: "pencil",
    name: "Pencil",
    kind: "pencil",
    color: "#71717a",
    width: 2.4,
    opacity: .78,
    pressureEnabled: true,
    minPressureScale: .42,
    maxPressureScale: 1.55,
    smoothing: .82,
  },
  {
    id: "ballpoint",
    name: "Ballpoint",
    kind: "ballpoint",
    color: "#d4d4d8",
    width: 2.5,
    opacity: 1,
    pressureEnabled: true,
    minPressureScale: .5,
    maxPressureScale: 1.42,
    smoothing: .86,
  },
  {
    id: "fountain",
    name: "Fountain pen",
    kind: "fountain",
    color: "#c4b5fd",
    width: 3.8,
    opacity: .98,
    pressureEnabled: true,
    minPressureScale: .36,
    maxPressureScale: 1.85,
    smoothing: .84,
  },
  {
    id: "felt-tip",
    name: "Felt tip",
    kind: "felt-tip",
    color: "#e4e4e7",
    width: 5.5,
    opacity: .96,
    pressureEnabled: true,
    minPressureScale: .58,
    maxPressureScale: 1.5,
    smoothing: .88,
  },
] as const;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function safeNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, minimum, maximum) : fallback;
}

function validColor(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export const DEFAULT_PRESSURE_CALIBRATION: PressureCalibration = { minimum: .02, maximum: .95 };

export function parsePressureCalibration(raw: string | null): PressureCalibration {
  if (!raw) return { ...DEFAULT_PRESSURE_CALIBRATION };
  try {
    const parsed = JSON.parse(raw) as Partial<PressureCalibration>;
    const minimum = safeNumber(parsed.minimum, DEFAULT_PRESSURE_CALIBRATION.minimum, 0, .9);
    const maximum = safeNumber(parsed.maximum, DEFAULT_PRESSURE_CALIBRATION.maximum, .1, 1);
    return maximum - minimum >= .08 ? { minimum, maximum } : { ...DEFAULT_PRESSURE_CALIBRATION };
  } catch {
    return { ...DEFAULT_PRESSURE_CALIBRATION };
  }
}

/** Reads standard Pointer Events pressure plus WebKit and native tablet fallbacks. */
export function readPointerPressure(sample: PointerPressureSample, fallback = .5, nativePressure?: number): PointerPressureReading {
  const pressure = Number(sample.pressure);
  const native = Number(nativePressure);
  const hasNativePressure = Number.isFinite(native) && native > 0 && native <= 1;
  // Some Linux tablet drivers expose a stylus as pointerType="mouse" while
  // PointerEvent.pressure is stuck at the mouse default of .5. Prefer GTK's
  // varying tablet axis in that exact case, but accept any other real value.
  const mouseDefault = sample.pointerType === "mouse" && Math.abs(pressure - .5) < .0001;
  if (Number.isFinite(pressure) && pressure > 0 && pressure <= 1 && !(mouseDefault && hasNativePressure)) {
    return { value: clamp(pressure, .001, 1), source: "pressure" };
  }
  const force = Number(sample.force);
  if (Number.isFinite(force) && force > 0 && force <= 1) return { value: clamp(force, .001, 1), source: "force" };
  const webkitForce = Number(sample.webkitForce);
  if (Number.isFinite(webkitForce) && webkitForce > 0) {
    return { value: clamp(webkitForce <= 1 ? webkitForce : (webkitForce - 1) / 2, .001, 1), source: "webkitForce" };
  }
  if (hasNativePressure) {
    return { value: clamp(native, .001, 1), source: "native" };
  }
  return { value: clamp(fallback, .001, 1), source: "fallback" };
}

/** Calibrates the tablet's reported range and expands it with a smooth curve. */
export function normalizePenPressure(value: number, calibration: PressureCalibration = DEFAULT_PRESSURE_CALIBRATION) {
  const span = Math.max(.08, calibration.maximum - calibration.minimum);
  const normalized = clamp((value - calibration.minimum) / span, 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

export function parseCustomPenPresets(raw: string | null): PenPreset[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 24).flatMap((candidate, index) => {
      if (!candidate || typeof candidate !== "object") return [];
      const item = candidate as Partial<PenPreset>;
      const name = typeof item.name === "string" ? item.name.trim().slice(0, 40) : "";
      if (!name) return [];
      return [{
        id: typeof item.id === "string" && item.id.startsWith("custom-") ? item.id : `custom-${index}`,
        name,
        kind: "custom" as const,
        color: validColor(item.color, "#d4d4d8"),
        width: safeNumber(item.width, 2.5, .1, 80),
        opacity: safeNumber(item.opacity, 1, .05, 1),
        pressureEnabled: item.pressureEnabled !== false,
        minPressureScale: safeNumber(item.minPressureScale, .55, .05, 2),
        maxPressureScale: safeNumber(item.maxPressureScale, 1.35, .1, 3),
        smoothing: safeNumber(item.smoothing, .7, 0, .95),
        custom: true,
      }];
    });
  } catch {
    return [];
  }
}

/**
 * Adds every hardware sample to the current stroke, filling unusually large
 * gaps. The target is intentionally mutable so a high-rate stylus stream can
 * be collected between animation frames without allocating a React state tree
 * for every individual sample.
 */
export function appendInterpolatedInkPoints(
  target: InkPoint[],
  incoming: readonly InkPoint[],
  maximumStep = 2.4,
  minimumDistance = .08,
) {
  let appended = 0;
  for (const sample of incoming) {
    const pressure = clamp(Number.isFinite(sample.pressure) ? sample.pressure : .5, .01, 1);
    const next = { x: sample.x, y: sample.y, pressure };
    const previous = target[target.length - 1];
    if (!previous) {
      target.push(next);
      appended += 1;
      continue;
    }
    const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
    if (distance < minimumDistance) {
      previous.pressure = (previous.pressure + pressure) / 2;
      continue;
    }
    const steps = Math.max(1, Math.ceil(distance / Math.max(.2, maximumStep)));
    for (let step = 1; step <= steps; step += 1) {
      const amount = step / steps;
      target.push({
        x: previous.x + (next.x - previous.x) * amount,
        y: previous.y + (next.y - previous.y) * amount,
        pressure: previous.pressure + (pressure - previous.pressure) * amount,
      });
      appended += 1;
    }
  }
  return appended;
}

function pointToSegmentDistance(point: InkPoint, a: InkPoint, b: InkPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const amount = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(point.x - (a.x + amount * dx), point.y - (a.y + amount * dy));
}

export function strokeIntersectsEraser(stroke: InkStroke, eraserPoints: readonly InkPoint[], radius: number) {
  if (!stroke.points.length || !eraserPoints.length) return false;
  const hitRadius = radius + stroke.width / 2;
  if (stroke.points.length === 1) {
    return eraserPoints.some(point => Math.hypot(point.x - stroke.points[0].x, point.y - stroke.points[0].y) <= hitRadius);
  }
  for (const eraserPoint of eraserPoints) {
    for (let index = 1; index < stroke.points.length; index += 1) {
      if (pointToSegmentDistance(eraserPoint, stroke.points[index - 1], stroke.points[index]) <= hitRadius) return true;
    }
  }
  return false;
}

/** Removes the complete connected stroke as soon as the eraser touches it. */
export function eraseWholeStrokes(strokes: readonly InkStroke[], eraserPoints: readonly InkPoint[], radius: number): InkStroke[] {
  return strokes.filter(stroke => !strokeIntersectsEraser(stroke, eraserPoints, radius));
}

function rounded(value: number) {
  return Number(value.toFixed(2));
}

function circlePath(point: InkPoint, radius: number) {
  const x = rounded(point.x);
  const y = rounded(point.y);
  const r = rounded(Math.max(.05, radius));
  return `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
}

function uniqueInkPoints(points: readonly InkPoint[]) {
  return points.filter((point, index) => index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > .02);
}

/**
 * Older LeNota builds inserted evenly spaced points on each raw straight chord.
 * Keeping every one of those points as a spline knot reproduces the polygon.
 * Collapse only nearly-collinear, pressure-linear runs before fitting. Sharp
 * handwriting turns and genuine pressure changes remain anchors.
 */
function splineAnchorPoints(points: readonly InkPoint[], smoothing = .7) {
  const source = uniqueInkPoints(points);
  if (source.length < 3) return source.map(point => ({ ...point }));
  // Collapse only points that are effectively on the exact same straight
  // chord. Earlier builds used the smoothing value here and could discard
  // genuine shallow curvature from high-rate mouse/tablet streams before the
  // spline ever saw it. Legacy gap-fill points are mathematically collinear,
  // so a tiny tolerance is enough to remove those without flattening curves.
  const maximumSine = .00075; // about 0.043 degrees
  const output: InkPoint[] = [{ ...source[0] }];
  for (let index = 1; index < source.length - 1; index += 1) {
    const previous = output[output.length - 1];
    const current = source[index];
    const next = source[index + 1];
    const ax = current.x - previous.x;
    const ay = current.y - previous.y;
    const bx = next.x - current.x;
    const by = next.y - current.y;
    const aLength = Math.hypot(ax, ay);
    const bLength = Math.hypot(bx, by);
    if (aLength <= .02 || bLength <= .02) continue;
    const cosine = (ax * bx + ay * by) / (aLength * bLength);
    const sine = Math.abs(ax * by - ay * bx) / (aLength * bLength);
    if (cosine > 0 && sine <= maximumSine) {
      const span = Math.max(.0001, aLength + bLength);
      const expectedPressure = previous.pressure + (next.pressure - previous.pressure) * (aLength / span);
      if (Math.abs(current.pressure - expectedPressure) <= .035) continue;
    }
    output.push({ ...current });
  }
  output.push({ ...source[source.length - 1] });
  return output;
}

/**
 * Build a cardinal/Catmull-Rom style spline that INTERPOLATES the real input
 * samples instead of replacing them with midpoint corners. The important bit
 * is that every hardware point stays on the final curve: smoothing changes the
 * tangent through that point, not where the point itself is.
 *
 * Control handles are clamped to the local segment length. That keeps a sparse
 * fast stroke rounded without the large loops/overshoot that an unconstrained
 * Catmull-Rom conversion can create when event spacing is uneven.
 */
interface InkCubicSegment {
  start: InkPoint;
  control1: InkPoint;
  control2: InkPoint;
  end: InkPoint;
}

function clampControlDistance(anchor: InkPoint, target: InkPoint, maximumDistance: number): InkPoint {
  const dx = target.x - anchor.x;
  const dy = target.y - anchor.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= maximumDistance || distance <= .0001) return target;
  const scale = maximumDistance / distance;
  return {
    x: anchor.x + dx * scale,
    y: anchor.y + dy * scale,
    pressure: target.pressure,
  };
}

function inkSplineSegmentsFromAnchors(source: readonly InkPoint[], smoothing = .7): InkCubicSegment[] {
  if (source.length < 2) return [];
  const amount = safeNumber(smoothing, .7, 0, .95);
  // Normal pen presets are around .6-.8. Boost that range toward a full
  // Catmull-Rom tangent so fast circles look round rather than merely having
  // softened polygon corners. A literal zero is still handled as a polyline.
  const tangentStrength = Math.min(1, amount * 1.25);
  const output: InkCubicSegment[] = [];
  for (let index = 0; index < source.length - 1; index += 1) {
    const start = source[index];
    const end = source[index + 1];
    const previous = source[Math.max(0, index - 1)];
    const following = source[Math.min(source.length - 1, index + 2)];
    const segmentLength = Math.max(.001, Math.hypot(end.x - start.x, end.y - start.y));

    // Cardinal Hermite tangent -> cubic Bezier control point. Using the point
    // on each side gives a continuous direction through sparse samples.
    const startTangentX = (end.x - previous.x) * .5 * tangentStrength;
    const startTangentY = (end.y - previous.y) * .5 * tangentStrength;
    const endTangentX = (following.x - start.x) * .5 * tangentStrength;
    const endTangentY = (following.y - start.y) * .5 * tangentStrength;
    const maxHandle = segmentLength * .48;
    const control1 = clampControlDistance(start, {
      x: start.x + startTangentX / 3,
      y: start.y + startTangentY / 3,
      pressure: start.pressure,
    }, maxHandle);
    const control2 = clampControlDistance(end, {
      x: end.x - endTangentX / 3,
      y: end.y - endTangentY / 3,
      pressure: end.pressure,
    }, maxHandle);
    output.push({ start, control1, control2, end });
  }
  return output;
}

function inkSplineSegments(points: readonly InkPoint[], smoothing = .7): InkCubicSegment[] {
  return inkSplineSegmentsFromAnchors(splineAnchorPoints(points, smoothing), smoothing);
}

function cubicCoordinate(a: number, b: number, c: number, d: number, t: number) {
  const inverse = 1 - t;
  return inverse * inverse * inverse * a
    + 3 * inverse * inverse * t * b
    + 3 * inverse * t * t * c
    + t * t * t * d;
}

function cubicPoint(segment: InkCubicSegment, t: number): InkPoint {
  return {
    x: cubicCoordinate(segment.start.x, segment.control1.x, segment.control2.x, segment.end.x, t),
    y: cubicCoordinate(segment.start.y, segment.control1.y, segment.control2.y, segment.end.y, t),
    // Pressure is intentionally monotonic between hardware samples; geometry
    // smoothing must never create fake pressure spikes.
    pressure: segment.start.pressure + (segment.end.pressure - segment.start.pressure) * t,
  };
}

function approximateCubicLength(segment: InkCubicSegment) {
  let length = 0;
  let previous = segment.start;
  for (let step = 1; step <= 6; step += 1) {
    const current = cubicPoint(segment, step / 6);
    length += Math.hypot(current.x - previous.x, current.y - previous.y);
    previous = current;
  }
  return length;
}

/**
 * Samples the same interpolating spline used by the visible centerline. This is
 * used for variable-pressure outlines so their normals follow the CURVE rather
 * than the old straight input chords.
 */
export function smoothInkPoints(points: readonly InkPoint[], smoothing = .7, maximumStep = 2.75): InkPoint[] {
  const source = uniqueInkPoints(points);
  if (source.length < 2) return source.map(point => ({ ...point }));
  const segments = inkSplineSegments(source, smoothing);
  const stepLimit = safeNumber(maximumStep, 2.75, .6, 12);
  const output: InkPoint[] = [{ ...source[0] }];
  for (const segment of segments) {
    const steps = Math.max(1, Math.ceil(approximateCubicLength(segment) / stepLimit));
    for (let step = 1; step <= steps; step += 1) output.push(cubicPoint(segment, step / steps));
  }
  return output;
}

/** A smooth cubic spline for fixed-width ink and selection previews. */
export function smoothInkPath(points: readonly InkPoint[], smoothing = .7) {
  const source = splineAnchorPoints(points, smoothing);
  if (!source.length) return "";
  if (source.length === 1) return `M ${rounded(source[0].x)} ${rounded(source[0].y)} l .01 .01`;
  if (source.length === 2 || smoothing <= .001) {
    return `M ${rounded(source[0].x)} ${rounded(source[0].y)}${source.slice(1).map(point => ` L ${rounded(point.x)} ${rounded(point.y)}`).join("")}`;
  }
  // `source` is already the cleaned anchor set. Do not pass it through
  // splineAnchorPoints a second time: double simplification could erase
  // shallow turns that are especially important during fast handwriting.
  const segments = inkSplineSegmentsFromAnchors(source, smoothing);
  let path = `M ${rounded(source[0].x)} ${rounded(source[0].y)}`;
  for (const segment of segments) {
    path += ` C ${rounded(segment.control1.x)} ${rounded(segment.control1.y)} ${rounded(segment.control2.x)} ${rounded(segment.control2.y)} ${rounded(segment.end.x)} ${rounded(segment.end.y)}`;
  }
  return path;
}

function quadraticCurveCommands(points: ReadonlyArray<{ x: number; y: number }>) {
  let path = "";
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midpoint = { x: (previous.x + current.x) / 2, y: (previous.y + current.y) / 2 };
    path += ` Q ${rounded(previous.x)} ${rounded(previous.y)} ${rounded(midpoint.x)} ${rounded(midpoint.y)}`;
  }
  const last = points[points.length - 1];
  path += ` L ${rounded(last.x)} ${rounded(last.y)}`;
  return path;
}

/** Builds one filled SVG outline, so pressure does not multiply DOM nodes. */
export function pressureStrokePath(
  stroke: InkStroke,
  options: { capStart?: boolean; capEnd?: boolean } = {},
): string {
  const minimum = safeNumber(stroke.minPressureScale, .55, .05, 2);
  const maximum = Math.max(minimum, safeNumber(stroke.maxPressureScale, 1.35, .1, 3));
  const smoothing = safeNumber(stroke.smoothing, .7, 0, .95);
  // Dense samples are generated *after* fitting the smooth centerline. The old
  // pipeline filled every raw gap with collinear points first, which locked the
  // renderer into the polygonal shape visible during fast circles.
  const sampleStep = clamp(stroke.width * .7 + .9, 1.5, 3.2);
  const source = smoothInkPoints(stroke.points, smoothing, sampleStep);
  if (!source.length) return "";
  let filteredPressure = clamp(source[0].pressure || .5, .01, 1);
  const pressureSmoothing = .18 + smoothing * .3;
  const pressures = source.map((point, index) => {
    const raw = clamp(point.pressure || .5, .01, 1);
    if (index === 0) return filteredPressure;
    filteredPressure = filteredPressure * pressureSmoothing + raw * (1 - pressureSmoothing);
    return filteredPressure;
  });
  const radii = pressures.map(pressure => Math.max(.05, stroke.width * .5 * (minimum + (maximum - minimum) * pressure)));
  if (source.length === 1) return circlePath(source[0], radii[0]);

  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < source.length; index += 1) {
    const before = source[Math.max(0, index - 1)];
    const after = source[Math.min(source.length - 1, index + 1)];
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.max(.0001, Math.hypot(dx, dy));
    const nx = -dy / length;
    const ny = dx / length;
    left.push({ x: source[index].x + nx * radii[index], y: source[index].y + ny * radii[index] });
    right.push({ x: source[index].x - nx * radii[index], y: source[index].y - ny * radii[index] });
  }

  const reversedRight = [...right].reverse();
  const outline = `M ${rounded(left[0].x)} ${rounded(left[0].y)}${quadraticCurveCommands(left)} L ${rounded(reversedRight[0].x)} ${rounded(reversedRight[0].y)}${quadraticCurveCommands(reversedRight)} Z`;
  const startCap = options.capStart === false ? "" : ` ${circlePath(source[0], radii[0])}`;
  const endCap = options.capEnd === false ? "" : ` ${circlePath(source[source.length - 1], radii[radii.length - 1])}`;
  return `${outline}${startCap}${endCap}`;
}

export type InputAction = "temporaryPan" | "temporaryEraser" | "radialMenu" | "pen" | "highlighter" | "strokeEraser" | "select";

export interface KeyInputBinding {
  type: "key";
  code: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export interface PointerInputBinding {
  type: "button";
  button: number;
}

export type InputBinding = KeyInputBinding | PointerInputBinding;
export type InputBindings = Record<InputAction, InputBinding[]>;

export const INPUT_ACTION_LABELS: Record<InputAction, string> = {
  temporaryPan: "Hold to move canvas",
  temporaryEraser: "Hold to erase full strokes",
  radialMenu: "Open pencil wheel",
  pen: "Select pen",
  highlighter: "Select highlighter",
  strokeEraser: "Select stroke eraser",
  select: "Select / type",
};

export const DEFAULT_INPUT_BINDINGS: InputBindings = {
  temporaryPan: [{ type: "key", code: "Space" }, { type: "button", button: 1 }],
  temporaryEraser: [{ type: "button", button: 2 }, { type: "button", button: 5 }],
  radialMenu: [{ type: "key", code: "KeyR" }],
  pen: [{ type: "key", code: "KeyP" }],
  highlighter: [{ type: "key", code: "KeyH" }],
  strokeEraser: [{ type: "key", code: "KeyE" }],
  select: [{ type: "key", code: "KeyV" }],
};

const INPUT_ACTIONS = Object.keys(DEFAULT_INPUT_BINDINGS) as InputAction[];

function validBinding(value: unknown): value is InputBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<InputBinding>;
  if (candidate.type === "button") return Number.isInteger(candidate.button) && Number(candidate.button) >= 0 && Number(candidate.button) <= 31;
  return candidate.type === "key" && typeof candidate.code === "string" && candidate.code.length > 0 && candidate.code.length < 64;
}

export function parseInputBindings(raw: string | null): InputBindings {
  const fallback = Object.fromEntries(INPUT_ACTIONS.map(action => [action, DEFAULT_INPUT_BINDINGS[action].map(binding => ({ ...binding }))])) as InputBindings;
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<InputAction, unknown>>;
    for (const action of INPUT_ACTIONS) {
      const values = parsed[action];
      if (Array.isArray(values)) fallback[action] = values.filter(validBinding).slice(0, 4);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function bindingFromKeyboardEvent(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): KeyInputBinding {
  return {
    type: "key",
    code: event.code,
    ...(event.ctrlKey ? { ctrl: true } : {}),
    ...(event.altKey ? { alt: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
    ...(event.metaKey ? { meta: true } : {}),
  };
}

export function bindingFromPointerEvent(event: Pick<PointerEvent, "button">): PointerInputBinding {
  return { type: "button", button: event.button };
}

export function keyboardBindingMatches(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">, binding: InputBinding) {
  return binding.type === "key"
    && event.code === binding.code
    && event.ctrlKey === Boolean(binding.ctrl)
    && event.altKey === Boolean(binding.alt)
    && event.shiftKey === Boolean(binding.shift)
    && event.metaKey === Boolean(binding.meta);
}

export function pointerBindingMatches(event: Pick<PointerEvent, "button">, binding: InputBinding) {
  return binding.type === "button" && event.button === binding.button;
}

export function actionForKeyboardEvent(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">, bindings: InputBindings): InputAction | null {
  return INPUT_ACTIONS.find(action => bindings[action].some(binding => keyboardBindingMatches(event, binding))) ?? null;
}

export function actionForPointerEvent(event: Pick<PointerEvent, "button">, bindings: InputBindings): InputAction | null {
  return INPUT_ACTIONS.find(action => bindings[action].some(binding => pointerBindingMatches(event, binding))) ?? null;
}

function keyName(code: string) {
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function formatInputBinding(binding: InputBinding) {
  if (binding.type === "button") {
    if (binding.button === 0) return "Tip / button 0";
    if (binding.button === 5) return "Eraser tip / button 5";
    return `Pen or mouse button ${binding.button}`;
  }
  return [binding.ctrl && "Ctrl", binding.alt && "Alt", binding.shift && "Shift", binding.meta && "Meta", keyName(binding.code)].filter(Boolean).join("+");
}
