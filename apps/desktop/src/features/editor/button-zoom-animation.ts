// Keep the interactive portion of button zoom compositor-only. Sharp layout
// reflow is performed once by the editor's idle viewport commit.
export const BUTTON_ZOOM_DURATION_MS = 260;

type Viewport = {x:number;y:number;zoom:number};

export function interpolateButtonZoom(from:Viewport,to:Viewport,progress:number):Viewport {
  const p=Math.max(0,Math.min(1,progress));
  // Starts promptly but decelerates gently; consecutive clicks restart from
  // the current displayed position without jumping between targets.
  const t=1-(1-p)**3;
  return {
    x:from.x+(to.x-from.x)*t,
    y:from.y+(to.y-from.y)*t,
    zoom:from.zoom+(to.zoom-from.zoom)*t,
  };
}
