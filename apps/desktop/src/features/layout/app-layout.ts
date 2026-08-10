interface AppGridTemplateOptions {
  focusMode: boolean;
  navigationWidth: number;
  navigationCollapsed: boolean;
  resizerWidth: number;
}

export function appGridTemplate({
  focusMode,
  navigationWidth,
  navigationCollapsed,
  resizerWidth,
}: AppGridTemplateOptions): string {
  // Hidden siblings are removed from grid placement in Focus Mode, so the
  // editor must become the only grid column. Keeping hidden tracks here would
  // auto-place the editor in the first zero-width track and blank the window.
  if (focusMode) return "minmax(0, 1fr)";
  // The redesigned normal-mode notebook navigator visually combines the old
  // rail and page list into one left panel. Collapse therefore removes both
  // tracks, leaving only the small resizer/expand handle beside the editor.
  if (navigationCollapsed) return `0px 0px ${resizerWidth}px minmax(0, 1fr)`;
  return `70px ${navigationWidth}px ${resizerWidth}px minmax(0, 1fr)`;
}

interface LayoutBox { width: number; height: number }

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function normalizeCanvasViewport(viewport: CanvasViewport): CanvasViewport {
  const x = Number.isFinite(viewport.x) ? viewport.x : 100;
  const y = Number.isFinite(viewport.y) ? viewport.y : 80;
  const zoom = Number.isFinite(viewport.zoom) ? viewport.zoom : 1;
  return {
    x: Math.max(-50000, Math.min(50000, x)),
    y: Math.max(-50000, Math.min(50000, y)),
    zoom: Math.max(.35, Math.min(2.5, zoom)),
  };
}

export function canvasViewportTransform(viewport: CanvasViewport): string {
  const safe = normalizeCanvasViewport(viewport);
  // WebKitGTK can eagerly rasterize an enormous transformed element when a
  // 3D transform promotes it to a compositor layer. Keep this 2D so WebKit can
  // tile and repaint only the visible part of the canvas.
  return `translate(${safe.x}px, ${safe.y}px) scale(${safe.zoom})`;
}

export function fitCanvasBounds(
  bounds: CanvasBounds,
  viewportWidth: number,
  viewportHeight: number,
  padding = 72,
  maximumZoom = 1.25,
): CanvasViewport {
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  const zoom = Math.max(.35, Math.min(maximumZoom, availableWidth / width, availableHeight / height));
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  return normalizeCanvasViewport({
    zoom,
    x: viewportWidth / 2 - centerX * zoom,
    // Notes are read top-to-bottom. Keep the first content row near the top
    // gutter instead of vertically centering sparse pages in a sea of empty
    // canvas. The zoom calculation still guarantees the bottom remains visible.
    y: padding - bounds.top * zoom,
  });
}

export function focusLayoutIsVisible(editor: LayoutBox | null, canvas: LayoutBox | null): boolean {
  return Boolean(
    editor && canvas
    && editor.width >= 320
    && editor.height >= 320
    && canvas.width >= 240
    && canvas.height >= 180,
  );
}
