export type InkAppearanceTheme = "dark" | "light";

interface ColoredInkStroke {
  tool: "pen" | "highlighter";
  color: string;
  points: Array<{ x: number; y: number }>;
}

function strokeLength(points: ColoredInkStroke["points"]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

/** Pick the dominant visible source color. Pen strokes take precedence over
 * highlighters; a highlighter-only selection still keeps its own color. */
export function representativeInkColor(strokes: readonly ColoredInkStroke[]): string {
  const penStrokes = strokes.filter((stroke) => stroke.tool === "pen");
  const candidates = penStrokes.length ? penStrokes : strokes;
  const weights = new Map<string, number>();

  for (const stroke of candidates) {
    const color = /^#[0-9a-f]{6}$/i.test(stroke.color) ? stroke.color.toLowerCase() : "#d4d4d8";
    weights.set(color, (weights.get(color) ?? 0) + Math.max(1, strokeLength(stroke.points)));
  }

  let best = "#d4d4d8";
  let bestWeight = -1;
  for (const [color, weight] of weights) {
    if (weight > bestWeight) {
      best = color;
      bestWeight = weight;
    }
  }
  return best;
}

/** Match the contrast adaptation used while rendering ink on the canvas. */
export function themeAwareInkColor(color: string, theme: InkAppearanceTheme): string {
  const normalized = color.toLowerCase();
  if (theme === "light" && ["#d4d4d8", "#e4e4e7", "#f5f5f5"].includes(normalized)) return "#2f3138";
  if (theme === "dark" && ["#25231f", "#2f3138", "#111827"].includes(normalized)) return "#d4d4d8";
  return color;
}

export function convertedInkColor(strokes: readonly ColoredInkStroke[], theme: InkAppearanceTheme): string {
  return themeAwareInkColor(representativeInkColor(strokes), theme);
}
