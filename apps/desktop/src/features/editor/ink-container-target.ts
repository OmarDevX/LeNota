export interface CanvasBounds {
  left:number;
  top:number;
  right:number;
  bottom:number;
}

export interface ContainerHitTarget {
  id:string;
  bounds:CanvasBounds;
  zIndex:number;
}

const width=(bounds:CanvasBounds)=>Math.max(0,bounds.right-bounds.left);
const height=(bounds:CanvasBounds)=>Math.max(0,bounds.bottom-bounds.top);

function intersectionArea(a:CanvasBounds,b:CanvasBounds):number {
  return Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*
    Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
}

/** Choose the visible note underneath recognized ink. A center hit is enough;
 * otherwise most of the ink bounds must overlap the note. */
export function chooseInkContainerTarget(ink:CanvasBounds,targets:ContainerHitTarget[]):string|null {
  const center={x:(ink.left+ink.right)/2,y:(ink.top+ink.bottom)/2};
  const inkArea=Math.max(144,width(ink)*height(ink));
  const candidates=targets.flatMap(target=>{
    const inside=center.x>=target.bounds.left&&center.x<=target.bounds.right&&
      center.y>=target.bounds.top&&center.y<=target.bounds.bottom;
    const overlap=intersectionArea(ink,target.bounds)/inkArea;
    if(!inside&&overlap<.55)return [];
    return [{id:target.id,score:(inside?2:0)+Math.min(1,overlap),zIndex:target.zIndex}];
  });
  candidates.sort((a,b)=>b.score-a.score||b.zIndex-a.zIndex);
  return candidates[0]?.id??null;
}
