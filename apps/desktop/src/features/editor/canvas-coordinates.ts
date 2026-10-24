export interface CanvasRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CanvasTransformSnapshot {
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
}

function finitePositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Derive the pointer transform from the canvas that is actually rendered.
 * This intentionally does not trust React viewport state: during a pan/zoom,
 * the DOM can already be at a newer transform than an event handler closure or
 * mutable state snapshot. getBoundingClientRect() and PointerEvent.clientX/Y
 * live in the same coordinate space, so their inverse remains correct across
 * pan, app layout changes, display scaling, and browser/webview zoom.
 */
export function canvasTransformFromRenderedRect(
  worldRect: CanvasRectLike,
  worldWidth: number,
  worldHeight: number,
  fallbackScale = 1,
): CanvasTransformSnapshot {
  const safeFallback = finitePositive(fallbackScale, 1);
  return {
    left: worldRect.left,
    top: worldRect.top,
    scaleX: finitePositive(worldRect.width / finitePositive(worldWidth, worldRect.width || 1), safeFallback),
    scaleY: finitePositive(worldRect.height / finitePositive(worldHeight, worldRect.height || 1), safeFallback),
  };
}

export function clientToCanvasPoint(clientX: number, clientY: number, transform: CanvasTransformSnapshot) {
  return {
    x: (clientX - transform.left) / finitePositive(transform.scaleX, 1),
    y: (clientY - transform.top) / finitePositive(transform.scaleY, 1),
  };
}

export function canvasToClientPoint(x: number, y: number, transform: CanvasTransformSnapshot) {
  return {
    x: transform.left + x * finitePositive(transform.scaleX, 1),
    y: transform.top + y * finitePositive(transform.scaleY, 1),
  };
}

export function clientDeltaToCanvasDelta(dx: number, dy: number, transform: CanvasTransformSnapshot) {
  return {
    x: dx / finitePositive(transform.scaleX, 1),
    y: dy / finitePositive(transform.scaleY, 1),
  };
}
