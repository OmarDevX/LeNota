export interface Point { x: number; y: number }
export interface Viewport { x: number; y: number; zoom: number }

/** Keep the world point under the original fingers under their new midpoint. */
export function pinchViewport(viewport: Viewport, start: [Point, Point], next: [Point, Point]): Viewport {
  const midpoint = (points: [Point, Point]) => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
  const distance = (points: [Point, Point]) => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
  const before = midpoint(start), after = midpoint(next);
  const zoom = Math.max(.35, Math.min(2.5, viewport.zoom * distance(next) / Math.max(1, distance(start))));
  return { zoom, x: after.x - (before.x - viewport.x) * zoom / viewport.zoom, y: after.y - (before.y - viewport.y) * zoom / viewport.zoom };
}

