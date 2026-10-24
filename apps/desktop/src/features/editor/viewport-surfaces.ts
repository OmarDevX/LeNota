export interface SurfaceViewport { x: number; y: number; zoom: number }
export interface SurfaceSize { width: number; height: number }
export interface SurfaceBounds { left: number; top: number; right: number; bottom: number }

export function viewportWorldBounds(viewport: SurfaceViewport, size: SurfaceSize): SurfaceBounds {
  return { left: -viewport.x / viewport.zoom, top: -viewport.y / viewport.zoom,
    right: (size.width - viewport.x) / viewport.zoom, bottom: (size.height - viewport.y) / viewport.zoom };
}

export function paddedSurfaceBounds(viewport: SurfaceViewport, size: SurfaceSize): SurfaceBounds {
  const visible = viewportWorldBounds(viewport, size);
  // Give the SVG surface a wider screen-space runway. WebKitGTK may repaint
  // the complete vector root when a pan crosses this boundary, so avoid
  // frequent viewBox / CSS origin changes during ordinary navigation.
  const tile = 512 / viewport.zoom;
  return { left: Math.floor(visible.left / tile) * tile - tile,
    top: Math.floor(visible.top / tile) * tile - tile,
    right: Math.ceil(visible.right / tile) * tile + tile,
    bottom: Math.ceil(visible.bottom / tile) * tile + tile };
}

function contains(outer: SurfaceBounds, inner: SurfaceBounds, margin: number) {
  return inner.left >= outer.left + margin && inner.top >= outer.top + margin &&
    inner.right <= outer.right - margin && inner.bottom <= outer.bottom - margin;
}
const union = (a: SurfaceBounds, b: SurfaceBounds): SurfaceBounds => ({
  left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
  right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom),
});

/** Keep vector backing surfaces close to the visible window. Pan within the
 * padding only moves the parent transform: it does not change SVG layout or
 * viewBox. All paths stay mounted for editing, search, capture, and printing. */
export function createViewportSurfaces(getSurfaces: () => Array<SVGSVGElement | null>) {
  let current: SurfaceBounds | null = null;
  let latest: { viewport: SurfaceViewport; size: SurfaceSize } | null = null;
  const captures = new Set<SurfaceBounds>();
  let unclipped = 0;
  function sync(viewport: SurfaceViewport, size: SurfaceSize) {
    latest = { viewport, size };
    if (size.width <= 0 || size.height <= 0) return;
    if (unclipped) {
      for (const svg of getSurfaces()) if (svg) {
        svg.removeAttribute("viewBox");
        svg.setAttribute("width", "8000"); svg.setAttribute("height", "8000");
        Object.assign(svg.style, { left: "0px", top: "0px", width: "8000px", height: "8000px", overflow: "visible", willChange: "auto" });
      }
      current = null;
      return;
    }
    let needed = viewportWorldBounds(viewport, size);
    for (const capture of captures) needed = union(needed, capture);
    // A zoom by itself does not invalidate an SVG viewBox: its bounds are in
    // world coordinates and the parent transform performs scaling. Rebase
    // only when the visible world rectangle actually approaches an edge.
    if (current && contains(current, needed, 96 / viewport.zoom)) return;
    const padded = paddedSurfaceBounds(viewport, size);
    current = union(padded, { left: needed.left - 96 / viewport.zoom, top: needed.top - 96 / viewport.zoom,
      right: needed.right + 96 / viewport.zoom, bottom: needed.bottom + 96 / viewport.zoom });
    const width = current.right - current.left, height = current.bottom - current.top;
    for (const svg of getSurfaces()) if (svg) {
      svg.setAttribute("viewBox", `${current.left} ${current.top} ${width} ${height}`);
      svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height));
      // These roots are rebased (CSS origin + viewBox) while their parent
      // moves. Forcing independent compositor textures can retain old tiles
      // on WebKitGTK and leave ghost copies until the next repaint.
      Object.assign(svg.style, { left: `${current.left}px`, top: `${current.top}px`, width: `${width}px`, height: `${height}px`, overflow: "hidden", willChange: "auto" });
    }
  }
  function refresh() { if (latest) { current = null; sync(latest.viewport, latest.size); } }
  return {
    sync,
    pinCapture(bounds: SurfaceBounds) {
      captures.add(bounds); refresh();
      let released = false;
      return () => { if (!released) { released = true; captures.delete(bounds); refresh(); } };
    },
    unclipForPrint() {
      unclipped += 1; refresh();
      let released = false;
      return () => { if (!released) { released = true; unclipped -= 1; refresh(); } };
    },
  };
}

/** A periodic paper grid can move by its phase on a small independent layer.
 * Large custom spacings use background-position instead of huge backing layers. */
export function paperPresentation(pattern: "plain" | "grid" | "ruled", spacing: number, viewport: SurfaceViewport) {
  const period = Math.max(1, spacing) * viewport.zoom;
  const phase = (value: number) => ((value % period) + period) % period;
  const x = pattern === "grid" ? phase(viewport.x) : 0;
  const y = pattern !== "plain" ? phase(viewport.y) : 0;
  const composited = pattern !== "plain" && period <= 512;
  const margin = composited ? Math.ceil(Math.max(64, period)) : 0;
  return { margin, x, y, composited,
    transform: composited ? `translate3d(${x}px, ${y}px, 0)` : "none",
    backgroundPosition: composited ? `${margin}px ${margin}px` : `${x}px ${y}px`,
    backgroundSize: pattern === "grid" ? `${period}px ${period}px` : pattern === "ruled" ? `100% ${period}px` : "auto" };
}

/** An unrelated React render must not reset an in-flight wheel/pan position. */
export function reconcileViewport(rendered: SurfaceViewport, previousRendered: SurfaceViewport, live: SurfaceViewport) {
  return rendered === previousRendered ? live : rendered;
}
