import { useEffect, useRef, type RefObject } from "react";

import { pinchViewport, type Point, type Viewport } from "./touch-geometry";

export function useTouchNavigation(canvas: RefObject<HTMLDivElement | null>, options: {
  enabled: boolean;
  fingerDrawing: boolean;
  selecting: boolean;
  getViewport: () => Viewport;
  preview: (viewport: Viewport) => unknown;
  commit: () => void;
}): (event: PointerEvent) => boolean {
  const start = useRef<(event: PointerEvent) => boolean>(() => false);
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const element = canvas.current;
    if (!element || !options.enabled) return;
    const touches = new Map<number, Point>();
    let baseline: { viewport: Viewport; points: Point[] } | null = null;
    let navigating = false;
    const points = () => Array.from(touches.values());
    const reset = () => { baseline = { viewport: { ...latest.current.getViewport() }, points: points().map(point => ({ ...point })) }; };
    const consume = (event: PointerEvent) => { event.preventDefault(); event.stopPropagation(); };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return false;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button,input,select,textarea,.canvas-floating-ui,[data-focus-chrome]")) return false;
      const rect = element.getBoundingClientRect();
      touches.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      const editing = latest.current.selecting && target?.closest(".note-container,.canvas-shape");
      // One finger writes only when explicitly enabled. Two fingers always
      // navigate; leave ordinary text taps to the editor and native keyboard.
      if (touches.size > 1 || (!latest.current.fingerDrawing && !editing)) {
        if (!navigating && touches.size > 1) {
          // End any first-finger drawing/drag before taking over its sequence.
          const firstId = touches.keys().next().value as number;
          const point = touches.get(firstId)!;
          const cancel = new PointerEvent("pointerup", { pointerId: firstId, pointerType: "touch", clientX:point.x+rect.left, clientY:point.y+rect.top });
          Object.defineProperty(cancel, "lenotaGestureCancel", { value: true });
          window.dispatchEvent(cancel);
        }
        navigating = true;
        reset();
        consume(event);
        element.setPointerCapture(event.pointerId);
        return true;
      }
      return false;
    };
    const move = (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) return;
      const rect = element.getBoundingClientRect();
      touches.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      if (!navigating || !baseline) return;
      consume(event);
      const current = points();
      if (current.length >= 2 && baseline.points.length >= 2) {
        latest.current.preview(pinchViewport(baseline.viewport, [baseline.points[0], baseline.points[1]], [current[0], current[1]]));
      } else if (current.length === 1 && baseline.points.length === 1) {
        latest.current.preview({ ...baseline.viewport, x: baseline.viewport.x + current[0].x - baseline.points[0].x, y: baseline.viewport.y + current[0].y - baseline.points[0].y });
      }
    };
    const end = (event: PointerEvent) => {
      if ((event as PointerEvent & {lenotaGestureCancel?: boolean}).lenotaGestureCancel) return;
      if (!touches.has(event.pointerId)) return;
      touches.delete(event.pointerId);
      if (!navigating) return;
      consume(event);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      if (touches.size) reset();
      else { navigating = false; baseline = null; latest.current.commit(); }
    };
    start.current = down;
    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    return () => {
      start.current = () => false;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      if (navigating) latest.current.commit();
    };
  }, [canvas, options.enabled]);
  return event => start.current(event);
}
