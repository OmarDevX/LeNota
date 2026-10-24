import type { VisualPoint, VisualSelectionBounds } from "./visual-selection.ts";

/** Draw readable note text without cloning the page or reloading any browser
 * resources. This path is deliberately independent of html-to-image, fonts
 * fetched by CSS and foreignObject SVG rasterisation (fragile in WebKitGTK).
 * Text position comes from the *rendered* DOM so it still follows wrapping,
 * container movement and zoom. Media images are composited separately. */
export function drawVisualNoteText(
  context: CanvasRenderingContext2D,
  world: HTMLElement,
  bounds: VisualSelectionBounds,
  outputScale: number,
  clientToWorld: (x: number, y: number) => VisualPoint,
): number {
  let painted = 0;
  const editors = Array.from(world.querySelectorAll<HTMLElement>(".note-container-editor"));
  const range = document.createRange();
  context.save();
  context.textBaseline = "alphabetic";
  for (const editor of editors) {
    const outer = editor.getBoundingClientRect();
    const upperLeft = clientToWorld(outer.left, outer.top);
    const lowerRight = clientToWorld(outer.right, outer.bottom);
    if (lowerRight.x < bounds.left || upperLeft.x > bounds.right || lowerRight.y < bounds.top || upperLeft.y > bounds.bottom) continue;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const value = node.textContent ?? "";
      if (!value.trim()) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest("svg,script,style,.katex-mathml,[aria-hidden='true']:not(.katex-html)")) continue;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const fontSize = Number.parseFloat(style.fontSize) || 14;
      context.fillStyle = style.color || "#e4e4e7";
      context.font = `${style.fontStyle} ${style.fontWeight} ${fontSize * outputScale}px ${style.fontFamily}`;
      // A range covering a whole node can wrap to several lines; measure the
      // individual text runs instead of placing everything on the first line.
      const segments = value.match(/\S+|\s+/g) ?? [];
      let offset = 0;
      for (const segment of segments) {
        const from = offset;
        offset += segment.length;
        if (!segment.trim()) continue;
        range.setStart(node, from);
        range.setEnd(node, offset);
        for (const rect of Array.from(range.getClientRects())) {
          const start = clientToWorld(rect.left, rect.top);
          const end = clientToWorld(rect.right, rect.bottom);
          if (end.x < bounds.left || start.x > bounds.right || end.y < bounds.top || start.y > bounds.bottom) continue;
          const x = (start.x - bounds.left) * outputScale;
          const y = (start.y - bounds.top + (end.y - start.y) * 0.8) * outputScale;
          // Measured width preserves browser text layout for unusual fonts.
          context.fillText(segment, x, y, Math.max(1, (end.x - start.x) * outputScale));
          painted += 1;
        }
      }
    }
  }
  context.restore();
  return painted;
}

/** Paint drawing surfaces directly through Canvas 2D. Unlike a blob created
 * by html-to-image, these primitives never trigger a second browser resource
 * load. The SVG coordinates are already world coordinates. */
export function drawVisualVectorLayers(
  context: CanvasRenderingContext2D,
  world: HTMLElement,
  bounds: VisualSelectionBounds,
  outputScale: number,
): number {
  let painted = 0;
  context.save();
  context.translate(-bounds.left * outputScale, -bounds.top * outputScale);
  context.scale(outputScale, outputScale);
  for (const layer of world.querySelectorAll<SVGSVGElement>(".canvas-shapes-layer,.canvas-ink-layer")) {
    for (const element of layer.querySelectorAll<SVGElement>("path,rect,ellipse,line,polyline,polygon,circle")) {
      if (element.closest("defs,.lasso-preview,[data-live-ink-preview-group]")) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const fill = element.getAttribute("fill") || style.fill || "none";
      const stroke = element.getAttribute("stroke") || style.stroke || "none";
      if (fill === "none" && stroke === "none") continue;
      context.save();
      try {
        const matrix = (element as SVGGraphicsElement).transform?.baseVal?.consolidate()?.matrix;
        if (matrix) context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
        context.globalAlpha = Number.parseFloat(element.getAttribute("opacity") ?? style.opacity) || 1;
        context.lineCap = (element.getAttribute("stroke-linecap") || style.strokeLinecap || "round") as CanvasLineCap;
        context.lineJoin = (element.getAttribute("stroke-linejoin") || style.strokeLinejoin || "round") as CanvasLineJoin;
        context.lineWidth = Number.parseFloat(element.getAttribute("stroke-width") || style.strokeWidth) || 1;
        if (style.mixBlendMode === "multiply") context.globalCompositeOperation = "multiply";
        let path = new Path2D();
        const number = (name: string) => Number.parseFloat(element.getAttribute(name) || "0") || 0;
        switch (element.tagName.toLowerCase()) {
          case "path": path = new Path2D(element.getAttribute("d") || ""); break;
          case "rect": path.rect(number("x"), number("y"), number("width"), number("height")); break;
          case "ellipse": path.ellipse(number("cx"), number("cy"), Math.max(0.0001,number("rx")),Math.max(0.0001,number("ry")),0,0,Math.PI*2); break;
          case "circle": path.arc(number("cx"),number("cy"),Math.max(0.0001,number("r")),0,Math.PI*2); break;
          case "line": path.moveTo(number("x1"),number("y1")); path.lineTo(number("x2"),number("y2")); break;
          case "polygon":
          case "polyline": {
            const pairs = (element.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
            for (let i=0;i+1<pairs.length;i+=2) { if (i===0) path.moveTo(pairs[i],pairs[i+1]); else path.lineTo(pairs[i],pairs[i+1]); }
            if (element.tagName.toLowerCase()==="polygon") path.closePath();
            break;
          }
        }
        if (fill !== "none") { context.fillStyle = fill; context.fill(path, element.getAttribute("fill-rule")==="evenodd"?"evenodd":"nonzero"); }
        if (stroke !== "none") { context.strokeStyle = stroke; context.stroke(path); }
        painted += 1;
      } catch (error) {
        // A malformed/unsupported individual SVG shape should not drop the
        // rest of the selected ink, photos, equations or notes.
        console.warn("[LeNota Ask selection] Skipped one vector shape",error);
      } finally { context.restore(); }
    }
  }
  context.restore();
  return painted;
}
