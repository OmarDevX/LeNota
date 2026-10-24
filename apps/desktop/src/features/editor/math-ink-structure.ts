export interface StructuralInkPoint { x: number; y: number }
export interface StructuralInkStroke { points: StructuralInkPoint[] }

function bounds(stroke: StructuralInkStroke) {
  const xs=stroke.points.map(point=>point.x),ys=stroke.points.map(point=>point.y);
  return {left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)};
}

function length(points: StructuralInkPoint[]):number {
  let total=0;
  for(let index=1;index<points.length;index+=1){
    total+=Math.hypot(points[index].x-points[index-1].x,points[index].y-points[index-1].y);
  }
  return total;
}

/**
 * Recognize the common three-stroke handwritten sigma: a top bar, a diagonal
 * middle sweep, and a bottom bar. Vision recognition often sees each piece correctly
 * but an eager integral heuristic can steal the diagonal before raster OCR sees
 * the complete symbol. This score only describes topology; it does not attempt
 * to read surrounding limit glyphs.
 */
export function multiStrokeSigmaScore(strokes: StructuralInkStroke[]):number {
  const usable=strokes.filter(stroke=>stroke.points.length>=2);
  if(usable.length<3)return 0;
  const described=usable.map(stroke=>{
    const b=bounds(stroke),width=Math.max(1,b.right-b.left),height=Math.max(1,b.bottom-b.top);
    const first=stroke.points[0],last=stroke.points[stroke.points.length-1];
    const direct=Math.max(1,Math.hypot(last.x-first.x,last.y-first.y));
    return {stroke,b,width,height,cx:(b.left+b.right)/2,cy:(b.top+b.bottom)/2,straightness:length(stroke.points)/direct};
  });
  const all={
    left:Math.min(...described.map(item=>item.b.left)),right:Math.max(...described.map(item=>item.b.right)),
    top:Math.min(...described.map(item=>item.b.top)),bottom:Math.max(...described.map(item=>item.b.bottom)),
  };
  const width=Math.max(1,all.right-all.left),height=Math.max(1,all.bottom-all.top);
  if(width<28||height<28)return 0;
  const bars=described.filter(item=>
    // Handwritten sigma bars are often curved or retraced, especially the
    // bottom stroke, so require horizontal dominance without demanding ruler
    // straightness.
    item.width>=width*.58&&item.height<=Math.max(16,height*.35)
  );
  const top=bars.find(item=>item.cy<=all.top+height*.38);
  const bottom=bars.find(item=>item.cy>=all.bottom-height*.38);
  if(!top||!bottom||top.stroke===bottom.stroke)return 0;
  const middle=described.find(item=>
    item.stroke!==top.stroke&&item.stroke!==bottom.stroke&&
    item.width>=width*.34&&item.height>=height*.34&&
    item.b.top<=top.cy+height*.28&&item.b.bottom>=bottom.cy-height*.28
  );
  if(!middle)return 0;
  const barWidthRatio=Math.min(top.width,bottom.width)/Math.max(top.width,bottom.width);
  const verticalOrder=top.cy<middle.cy&&middle.cy<bottom.cy;
  return Math.min(1,.74+barWidthRatio*.16+(verticalOrder?.08:0));
}

/**
 * Recognize the compact/continuous sigma form where the top bar is one stroke
 * and the diagonal plus bottom bar are another (or the symbol is one stroke).
 * Both horizontal caps and a wide, tall turning stroke are required, keeping
 * fraction bars, equals signs, and integral strokes out.
 */
export function compactSigmaScore(strokes: StructuralInkStroke[]):number {
  const usable=strokes.filter(stroke=>stroke.points.length>=2);
  if(!usable.length||usable.length>4)return 0;
  const described=usable.map(stroke=>{
    const b=bounds(stroke),width=Math.max(1,b.right-b.left),height=Math.max(1,b.bottom-b.top);
    const first=stroke.points[0],last=stroke.points[stroke.points.length-1];
    const direct=Math.max(1,Math.hypot(last.x-first.x,last.y-first.y));
    return {b,width,height,pathRatio:length(stroke.points)/direct};
  });
  const allPoints=usable.flatMap(stroke=>stroke.points);
  const all={
    left:Math.min(...allPoints.map(point=>point.x)),right:Math.max(...allPoints.map(point=>point.x)),
    top:Math.min(...allPoints.map(point=>point.y)),bottom:Math.max(...allPoints.map(point=>point.y)),
  };
  const width=Math.max(1,all.right-all.left),height=Math.max(1,all.bottom-all.top);
  if(width<28||height<28||width/height<.45||width/height>2.1)return 0;
  const spread=(points:StructuralInkPoint[])=>points.length<2?0:Math.max(...points.map(point=>point.x))-Math.min(...points.map(point=>point.x));
  const topSpread=spread(allPoints.filter(point=>point.y<=all.top+height*.27))/width;
  const bottomSpread=spread(allPoints.filter(point=>point.y>=all.bottom-height*.27))/width;
  if(topSpread<.50||bottomSpread<.50)return 0;
  const turning=described.find(item=>item.height>=height*.48&&item.width>=width*.40&&item.pathRatio>=1.18);
  if(!turning)return 0;
  const hasHorizontalCap=described.some(item=>item.width>=width*.55&&item.height<=height*.30);
  if(usable.length>1&&!hasHorizontalCap)return 0;
  return Math.min(1,.78+Math.min(topSpread,bottomSpread)*.12+Math.min(1,(turning.pathRatio-1.18)/1.5)*.10);
}

export interface EnclosingParenthesisIndices {
  left:number;
  right:number;
  inner:number[];
}

function parenthesisBowScore(stroke:StructuralInkStroke,side:"left"|"right",overallHeight:number):number {
  if(stroke.points.length<3)return 0;
  const b=bounds(stroke),width=Math.max(1,b.right-b.left),height=Math.max(1,b.bottom-b.top);
  if(height<overallHeight*.62||height/width<1.35)return 0;
  const top=stroke.points.reduce((best,point)=>point.y<best.y?point:best);
  const bottom=stroke.points.reduce((best,point)=>point.y>best.y?point:best);
  const middleY=(b.top+b.bottom)/2;
  const middle=stroke.points.reduce((best,point)=>Math.abs(point.y-middleY)<Math.abs(best.y-middleY)?point:best);
  const shoulders=(top.x+bottom.x)/2;
  const bow=side==="left"?(shoulders-middle.x)/width:(middle.x-shoulders)/width;
  if(bow<.12)return 0;
  return Math.min(1,.62+Math.min(.28,bow*.45)+Math.min(.10,(height/width-1.35)*.04));
}

/**
 * Find a pair of tall bowed strokes enclosing an expression. Parentheses are
 * removed before recursive recognition and restored as LaTeX afterwards, so
 * formula OCR cannot hallucinate them as integral commands.
 */
export function findEnclosingParentheses(strokes:StructuralInkStroke[]):EnclosingParenthesisIndices|null {
  const usable=strokes.map((stroke,index)=>({stroke,index,b:bounds(stroke)})).filter(item=>item.stroke.points.length>=2);
  if(usable.length<3)return null;
  const allPoints=usable.flatMap(item=>item.stroke.points);
  const overall={
    left:Math.min(...allPoints.map(point=>point.x)),right:Math.max(...allPoints.map(point=>point.x)),
    top:Math.min(...allPoints.map(point=>point.y)),bottom:Math.max(...allPoints.map(point=>point.y)),
  };
  const width=Math.max(1,overall.right-overall.left),height=Math.max(1,overall.bottom-overall.top);
  const leftCandidates=usable.map(item=>({...item,score:parenthesisBowScore(item.stroke,"left",height)}))
    .filter(item=>item.score>=.70&&(item.b.left+item.b.right)/2<=overall.left+width*.28)
    .sort((a,b)=>b.score-a.score||a.b.left-b.b.left);
  const rightCandidates=usable.map(item=>({...item,score:parenthesisBowScore(item.stroke,"right",height)}))
    .filter(item=>item.score>=.70&&(item.b.left+item.b.right)/2>=overall.right-width*.28)
    .sort((a,b)=>b.score-a.score||b.b.right-a.b.right);
  for(const left of leftCandidates)for(const right of rightCandidates){
    if(left.index===right.index||left.b.right>=right.b.left)return null;
    const inner=usable.filter(item=>item.index!==left.index&&item.index!==right.index&&
      (item.b.left+item.b.right)/2>left.b.left&&
      (item.b.left+item.b.right)/2<right.b.right
    ).map(item=>item.index);
    if(inner.length)return {left:left.index,right:right.index,inner};
  }
  return null;
}

/** Find the sigma strokes even when small upper/lower-limit glyphs enlarge the
 * overall expression bounds. Three-stroke combinations are cheap for normal
 * ink groups and avoid relying on one vertically dominant seed stroke. */
export function findMultiStrokeSigmaCluster(strokes: StructuralInkStroke[]):number[]|null {
  const usable=strokes.map((stroke,index)=>({stroke,index})).filter(item=>item.stroke.points.length>=2);
  if(usable.length<3)return null;
  const allPoints=usable.flatMap(item=>item.stroke.points);
  const overall={
    left:Math.min(...allPoints.map(point=>point.x)),right:Math.max(...allPoints.map(point=>point.x)),
    top:Math.min(...allPoints.map(point=>point.y)),bottom:Math.max(...allPoints.map(point=>point.y)),
  };
  const overallWidth=Math.max(1,overall.right-overall.left);
  let best:{indices:number[];score:number;left:number;right:number}|null=null;
  for(let a=0;a<usable.length-2;a+=1)for(let b=a+1;b<usable.length-1;b+=1)for(let c=b+1;c<usable.length;c+=1){
    const items=[usable[a],usable[b],usable[c]];
    const score=multiStrokeSigmaScore(items.map(item=>item.stroke));
    if(score<.86)continue;
    const points=items.flatMap(item=>item.stroke.points);
    const left=Math.min(...points.map(point=>point.x)),right=Math.max(...points.map(point=>point.x));
    // Large operators belong on the left half of an expression. This rejects
    // coincidental bar/diagonal triples inside a long right-hand body.
    const center=(left+right)/2;
    if(center>overall.left+overallWidth*.62)continue;
    if(!best||score>best.score||(score===best.score&&left<best.left))best={indices:items.map(item=>item.index),score,left,right};
  }
  return best?.indices??null;
}
