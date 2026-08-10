export const RECENT_MATH_EDIT_WINDOW_MS=30_000;

export interface ReopenableMathConversion {
  bounds:{left:number;top:number;right:number;bottom:number};
  expiresAt:number;
}

export function findReopenableMathConversion(
  conversions:Iterable<readonly [string,ReopenableMathConversion]>,
  point:{x:number;y:number},
  now=Date.now(),
):string|null {
  let best:{id:string;distance:number}|null=null;
  for(const [id,entry] of conversions){
    if(entry.expiresAt<now)continue;
    const width=Math.max(1,entry.bounds.right-entry.bounds.left);
    const height=Math.max(1,entry.bounds.bottom-entry.bounds.top);
    // Large operators need room above/below for limits; ordinary equations
    // mostly grow to the right.
    const padX=Math.max(70,width*.72),padY=Math.max(85,height*1.45);
    const left=entry.bounds.left-padX*.35,right=entry.bounds.right+padX;
    const top=entry.bounds.top-padY,bottom=entry.bounds.bottom+padY;
    if(point.x<left||point.x>right||point.y<top||point.y>bottom)continue;
    const cx=(entry.bounds.left+entry.bounds.right)/2;
    const cy=(entry.bounds.top+entry.bounds.bottom)/2;
    const distance=Math.hypot(point.x-cx,point.y-cy);
    if(!best||distance<best.distance)best={id,distance};
  }
  return best?.id??null;
}

export function confirmAllRecentMathConversions<T>(conversions:Map<string,T>):number {
  const confirmed=conversions.size;
  conversions.clear();
  return confirmed;
}
