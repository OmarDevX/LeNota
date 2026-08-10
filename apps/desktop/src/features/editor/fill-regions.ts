export interface FillPoint { x: number; y: number }

export interface FillBoundaryStroke {
  width: number;
  points: FillPoint[];
}

export interface FillBoundaryShape {
  kind: "rectangle" | "ellipse" | "line" | "arrow" | "path";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeWidth: number;
  rotation?: number;
}

export interface FillRegionBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FillRegion {
  loops: FillPoint[][];
  bounds: FillRegionBounds;
}

export interface FillRegionOptions {
  cellSize?: number;
  initialRadius?: number;
  maxRadius?: number;
  barrierPadding?: number;
  maxCells?: number;
}

interface GridWindow {
  left: number;
  top: number;
  cellSize: number;
  width: number;
  height: number;
  blocked: Uint8Array;
}

interface GridVertex { x: number; y: number }
interface BoundaryEdge { start: GridVertex; end: GridVertex; dir: number }
interface TracedFillRegion extends FillRegion { grid: GridWindow }

const clamp = (value:number,min:number,max:number) => Math.min(max,Math.max(min,value));

function rotatePoint(point:FillPoint,cx:number,cy:number,degrees:number):FillPoint {
  if(!degrees)return point;
  const radians=degrees*Math.PI/180, cos=Math.cos(radians), sin=Math.sin(radians);
  const dx=point.x-cx,dy=point.y-cy;
  return {x:cx+dx*cos-dy*sin,y:cy+dx*sin+dy*cos};
}

function shapeSegments(shape:FillBoundaryShape,cellSize:number):Array<[FillPoint,FillPoint]> {
  const left=Math.min(shape.x1,shape.x2),right=Math.max(shape.x1,shape.x2),top=Math.min(shape.y1,shape.y2),bottom=Math.max(shape.y1,shape.y2);
  const cx=(left+right)/2,cy=(top+bottom)/2,rotation=shape.rotation??0;
  if(shape.kind==="line"||shape.kind==="arrow")return [[{x:shape.x1,y:shape.y1},{x:shape.x2,y:shape.y2}]];
  if(shape.kind==="rectangle"){
    const raw=[{x:left,y:top},{x:right,y:top},{x:right,y:bottom},{x:left,y:bottom}].map(point=>rotatePoint(point,cx,cy,rotation));
    return raw.map((point,index)=>[point,raw[(index+1)%raw.length]] as [FillPoint,FillPoint]);
  }
  if(shape.kind==="ellipse"){
    const rx=Math.max(.5,(right-left)/2),ry=Math.max(.5,(bottom-top)/2);
    const perimeter=Math.PI*(3*(rx+ry)-Math.sqrt(Math.max(0,(3*rx+ry)*(rx+3*ry))));
    const count=clamp(Math.ceil(perimeter/Math.max(.75,cellSize*.55)),32,4096);
    const points=Array.from({length:count},(_,index)=>{
      const angle=index/count*Math.PI*2;
      return rotatePoint({x:cx+Math.cos(angle)*rx,y:cy+Math.sin(angle)*ry},cx,cy,rotation);
    });
    return points.map((point,index)=>[point,points[(index+1)%points.length]] as [FillPoint,FillPoint]);
  }
  return [];
}

function geometryBounds(strokes:FillBoundaryStroke[],shapes:FillBoundaryShape[]):FillRegionBounds|null {
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity,found=false;
  for(const stroke of strokes){
    const pad=Math.max(0,stroke.width/2);
    for(const point of stroke.points){
      found=true;left=Math.min(left,point.x-pad);top=Math.min(top,point.y-pad);right=Math.max(right,point.x+pad);bottom=Math.max(bottom,point.y+pad);
    }
  }
  for(const shape of shapes){
    if(shape.kind==="path")continue;
    const segments=shapeSegments(shape,3);
    for(const [a,b] of segments){
      const pad=Math.max(0,shape.strokeWidth/2);
      found=true;left=Math.min(left,a.x-pad,b.x-pad);top=Math.min(top,a.y-pad,b.y-pad);right=Math.max(right,a.x+pad,b.x+pad);bottom=Math.max(bottom,a.y+pad,b.y+pad);
    }
  }
  return found?{left,top,right,bottom}:null;
}

function segmentIntersectsWindow(a:FillPoint,b:FillPoint,left:number,top:number,right:number,bottom:number,pad:number) {
  const minX=Math.min(a.x,b.x)-pad,maxX=Math.max(a.x,b.x)+pad,minY=Math.min(a.y,b.y)-pad,maxY=Math.max(a.y,b.y)+pad;
  return maxX>=left&&minX<=right&&maxY>=top&&minY<=bottom;
}

function createGrid(center:FillPoint,radius:number,requestedCellSize:number,maxCells:number):GridWindow {
  const diameter=radius*2;
  const minimumCell=diameter/Math.max(32,Math.sqrt(maxCells));
  const cellSize=Math.max(requestedCellSize,minimumCell);
  const width=Math.max(8,Math.ceil(diameter/cellSize)+3),height=width;
  return {
    left:center.x-radius-cellSize,
    top:center.y-radius-cellSize,
    cellSize,width,height,
    blocked:new Uint8Array(width*height),
  };
}

function rasterizeBoundaries(grid:GridWindow,strokes:FillBoundaryStroke[],shapes:FillBoundaryShape[],barrierPadding:number) {
  const {left,top,cellSize,width,height,blocked}=grid;
  const right=left+width*cellSize,bottom=top+height*cellSize;
  const markDisc=(x:number,y:number,radius:number)=>{
    const minX=Math.max(0,Math.floor((x-radius-left)/cellSize));
    const maxX=Math.min(width-1,Math.ceil((x+radius-left)/cellSize));
    const minY=Math.max(0,Math.floor((y-radius-top)/cellSize));
    const maxY=Math.min(height-1,Math.ceil((y+radius-top)/cellSize));
    const effective=radius+cellSize*.48,effectiveSquared=effective*effective;
    for(let gy=minY;gy<=maxY;gy+=1){
      const cy=top+(gy+.5)*cellSize;
      for(let gx=minX;gx<=maxX;gx+=1){
        const cx=left+(gx+.5)*cellSize,dx=cx-x,dy=cy-y;
        if(dx*dx+dy*dy<=effectiveSquared)blocked[gy*width+gx]=1;
      }
    }
  };
  const markSegment=(a:FillPoint,b:FillPoint,widthValue:number)=>{
    const radius=Math.max(.35,widthValue/2)+barrierPadding;
    if(!segmentIntersectsWindow(a,b,left,top,right,bottom,radius))return;
    const length=Math.hypot(b.x-a.x,b.y-a.y);
    const steps=Math.max(1,Math.ceil(length/Math.max(.35,cellSize*.35)));
    for(let index=0;index<=steps;index+=1){
      const t=index/steps;
      markDisc(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,radius);
    }
  };
  for(const stroke of strokes){
    if(stroke.points.length===1){markDisc(stroke.points[0].x,stroke.points[0].y,Math.max(.35,stroke.width/2)+barrierPadding);continue;}
    for(let index=1;index<stroke.points.length;index+=1)markSegment(stroke.points[index-1],stroke.points[index],stroke.width);
  }
  for(const shape of shapes){
    if(shape.kind==="path")continue;
    for(const [a,b] of shapeSegments(shape,cellSize))markSegment(a,b,shape.strokeWidth);
  }
}

function closestOpenCell(grid:GridWindow,point:FillPoint):{x:number;y:number}|null {
  const {left,top,cellSize,width,height,blocked}=grid;
  const baseX=clamp(Math.floor((point.x-left)/cellSize),0,width-1),baseY=clamp(Math.floor((point.y-top)/cellSize),0,height-1);
  if(!blocked[baseY*width+baseX])return {x:baseX,y:baseY};
  for(let radius=1;radius<=6;radius+=1){
    let best:{x:number;y:number;distance:number}|null=null;
    for(let dy=-radius;dy<=radius;dy+=1){
      for(let dx=-radius;dx<=radius;dx+=1){
        if(Math.max(Math.abs(dx),Math.abs(dy))!==radius)continue;
        const x=baseX+dx,y=baseY+dy;if(x<1||y<1||x>=width-1||y>=height-1||blocked[y*width+x])continue;
        const cx=left+(x+.5)*cellSize,cy=top+(y+.5)*cellSize,distance=Math.hypot(cx-point.x,cy-point.y);
        if(!best||distance<best.distance)best={x,y,distance};
      }
    }
    if(best)return {x:best.x,y:best.y};
  }
  return null;
}

function flood(grid:GridWindow,start:{x:number;y:number}):{inside:Uint8Array;touchesEdge:boolean;count:number} {
  const {width,height,blocked}=grid,total=width*height;
  const inside=new Uint8Array(total),queue=new Int32Array(total);
  let head=0,tail=0,touchesEdge=false,count=0;
  const startIndex=start.y*width+start.x;inside[startIndex]=1;queue[tail++]=startIndex;
  while(head<tail){
    const index=queue[head++],x=index%width,y=Math.floor(index/width);count+=1;
    if(x===0||y===0||x===width-1||y===height-1)touchesEdge=true;
    if(x>0){const next=index-1;if(!blocked[next]&&!inside[next]){inside[next]=1;queue[tail++]=next;}}
    if(x+1<width){const next=index+1;if(!blocked[next]&&!inside[next]){inside[next]=1;queue[tail++]=next;}}
    if(y>0){const next=index-width;if(!blocked[next]&&!inside[next]){inside[next]=1;queue[tail++]=next;}}
    if(y+1<height){const next=index+width;if(!blocked[next]&&!inside[next]){inside[next]=1;queue[tail++]=next;}}
  }
  return {inside,touchesEdge,count};
}

const vertexKey=(point:GridVertex)=>`${point.x},${point.y}`;

function extractGridLoops(grid:GridWindow,inside:Uint8Array):GridVertex[][] {
  const {width,height}=grid,edges:BoundaryEdge[]=[];
  const isInside=(x:number,y:number)=>x>=0&&y>=0&&x<width&&y<height&&inside[y*width+x]===1;
  for(let y=0;y<height;y+=1){
    for(let x=0;x<width;x+=1){
      if(!isInside(x,y))continue;
      if(!isInside(x,y-1))edges.push({start:{x,y},end:{x:x+1,y},dir:0});
      if(!isInside(x+1,y))edges.push({start:{x:x+1,y},end:{x:x+1,y:y+1},dir:1});
      if(!isInside(x,y+1))edges.push({start:{x:x+1,y:y+1},end:{x,y:y+1},dir:2});
      if(!isInside(x-1,y))edges.push({start:{x,y:y+1},end:{x,y},dir:3});
    }
  }
  const outgoing=new Map<string,number[]>();
  edges.forEach((edge,index)=>{const key=vertexKey(edge.start),list=outgoing.get(key)??[];list.push(index);outgoing.set(key,list);});
  const used=new Uint8Array(edges.length),loops:GridVertex[][]=[];
  const turnRank=(from:number,to:number)=>{
    const delta=(to-from+4)%4;
    if(delta===1)return 0; // keep the filled region on the right
    if(delta===0)return 1;
    if(delta===3)return 2;
    return 3;
  };
  for(let seed=0;seed<edges.length;seed+=1){
    if(used[seed])continue;
    const loop:GridVertex[]=[];let current=seed,guard=0;
    const startKey=vertexKey(edges[seed].start);
    while(!used[current]&&guard++<=edges.length+4){
      const edge=edges[current];used[current]=1;loop.push(edge.start);
      const endKey=vertexKey(edge.end);
      if(endKey===startKey)break;
      const candidates=(outgoing.get(endKey)??[]).filter(index=>!used[index]);
      if(!candidates.length){loop.length=0;break;}
      candidates.sort((a,b)=>turnRank(edge.dir,edges[a].dir)-turnRank(edge.dir,edges[b].dir));
      current=candidates[0];
    }
    if(loop.length>=3)loops.push(loop);
  }
  return loops;
}

function pointSegmentDistance(point:FillPoint,a:FillPoint,b:FillPoint) {
  const dx=b.x-a.x,dy=b.y-a.y,denominator=dx*dx+dy*dy;
  if(!denominator)return Math.hypot(point.x-a.x,point.y-a.y);
  const t=clamp(((point.x-a.x)*dx+(point.y-a.y)*dy)/denominator,0,1);
  return Math.hypot(point.x-(a.x+t*dx),point.y-(a.y+t*dy));
}

function simplifyOpen(points:FillPoint[],tolerance:number):FillPoint[] {
  if(points.length<=2)return points;
  let maxDistance=0,index=-1;
  for(let i=1;i<points.length-1;i+=1){
    const distance=pointSegmentDistance(points[i],points[0],points[points.length-1]);
    if(distance>maxDistance){maxDistance=distance;index=i;}
  }
  if(index<0||maxDistance<=tolerance)return [points[0],points[points.length-1]];
  const left=simplifyOpen(points.slice(0,index+1),tolerance),right=simplifyOpen(points.slice(index),tolerance);
  return [...left.slice(0,-1),...right];
}

function simplifyClosed(points:FillPoint[],tolerance:number):FillPoint[] {
  if(points.length<=6)return points;
  let anchor=0;
  for(let i=1;i<points.length;i+=1)if(points[i].x<points[anchor].x||(points[i].x===points[anchor].x&&points[i].y<points[anchor].y))anchor=i;
  let opposite=anchor,best=-1;
  for(let i=0;i<points.length;i+=1){const distance=(points[i].x-points[anchor].x)**2+(points[i].y-points[anchor].y)**2;if(distance>best){best=distance;opposite=i;}}
  if(opposite===anchor)return points;
  const forward:FillPoint[]=[];for(let i=anchor;;i=(i+1)%points.length){forward.push(points[i]);if(i===opposite)break;}
  const backward:FillPoint[]=[];for(let i=opposite;;i=(i+1)%points.length){backward.push(points[i]);if(i===anchor)break;}
  const a=simplifyOpen(forward,tolerance),b=simplifyOpen(backward,tolerance);
  return [...a.slice(0,-1),...b.slice(0,-1)];
}

function loopArea(points:FillPoint[]) {
  let area=0;for(let i=0,j=points.length-1;i<points.length;j=i++)area+=points[j].x*points[i].y-points[i].x*points[j].y;
  return area/2;
}

function worldLoops(grid:GridWindow,inside:Uint8Array):FillPoint[][] {
  return extractGridLoops(grid,inside).map(loop=>loop.map(point=>({x:grid.left+point.x*grid.cellSize,y:grid.top+point.y*grid.cellSize})))
    .map(loop=>simplifyClosed(loop,grid.cellSize*.72))
    .filter(loop=>loop.length>=3&&Math.abs(loopArea(loop))>=grid.cellSize*grid.cellSize*2);
}

function loopsBounds(loops:FillPoint[][]):FillRegionBounds|null {
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity,found=false;
  for(const loop of loops)for(const point of loop){
    found=true;left=Math.min(left,point.x);top=Math.min(top,point.y);right=Math.max(right,point.x);bottom=Math.max(bottom,point.y);
  }
  return found?{left,top,right,bottom}:null;
}

function traceRegionInGrid(
  grid:GridWindow,
  point:FillPoint,
  strokes:FillBoundaryStroke[],
  shapes:FillBoundaryShape[],
  barrierPadding:number,
):TracedFillRegion|"open"|null {
  rasterizeBoundaries(grid,strokes,shapes,barrierPadding);
  const start=closestOpenCell(grid,point);
  if(!start)return null;
  const result=flood(grid,start);
  if(result.touchesEdge)return "open";
  if(result.count<2)return null;
  const loops=worldLoops(grid,result.inside),regionBounds=loopsBounds(loops);
  return regionBounds&&loops.length?{loops,bounds:regionBounds,grid}:null;
}

function maxBoundaryThickness(strokes:FillBoundaryStroke[],shapes:FillBoundaryShape[]) {
  return Math.max(
    0,
    ...strokes.map(stroke=>stroke.width||0),
    ...shapes.filter(shape=>shape.kind!=="path").map(shape=>shape.strokeWidth||0),
  );
}

function refineTracedRegion(
  point:FillPoint,
  strokes:FillBoundaryStroke[],
  shapes:FillBoundaryShape[],
  region:TracedFillRegion,
  maxCells:number,
  barrierPadding:number|undefined,
):FillRegion {
  let best=region;
  const boundaryThickness=maxBoundaryThickness(strokes,shapes);
  for(let pass=0;pass<2;pass+=1){
    const nextCell=Math.max(.45,best.grid.cellSize*.62);
    if(nextCell>=best.grid.cellSize-.05)break;
    const width=best.bounds.right-best.bounds.left,height=best.bounds.bottom-best.bounds.top;
    const radius=Math.max(width,height)/2+Math.max(18,boundaryThickness*2.5,best.grid.cellSize*8);
    const center={x:(best.bounds.left+best.bounds.right)/2,y:(best.bounds.top+best.bounds.bottom)/2};
    const grid=createGrid(center,radius,nextCell,maxCells);
    const padding=barrierPadding??Math.max(.14,grid.cellSize*.18);
    const traced=traceRegionInGrid(grid,point,strokes,shapes,padding);
    if(!traced||traced==="open")break;
    best=traced;
  }
  return {loops:best.loops,bounds:best.bounds};
}

/**
 * Finds the enclosed drawable region containing `point` by rasterizing ink and
 * vector outlines as barriers, then tracing the connected interior back into
 * vector loops. Returns null when the click can escape to the outside.
 */
export function findEnclosedFillRegion(
  point:FillPoint,
  strokes:FillBoundaryStroke[],
  shapes:FillBoundaryShape[],
  options:FillRegionOptions={},
):FillRegion|null {
  const bounds=geometryBounds(strokes,shapes);
  if(!bounds||point.x<bounds.left||point.x>bounds.right||point.y<bounds.top||point.y>bounds.bottom)return null;
  const requestedCell=clamp(options.cellSize??1.15,.55,8);
  const initialRadius=Math.max(80,options.initialRadius??280),maxRadius=Math.max(initialRadius,options.maxRadius??1800);
  const maxCells=Math.max(100_000,options.maxCells??2_400_000);
  let radius=initialRadius;
  while(true){
    const grid=createGrid(point,radius,requestedCell,maxCells);
    const padding=options.barrierPadding??Math.max(.18,grid.cellSize*.22);
    const traced=traceRegionInGrid(grid,point,strokes,shapes,padding);
    if(traced&&traced!=="open")return refineTracedRegion(point,strokes,shapes,traced,maxCells,options.barrierPadding);
    if(traced===null)return null;
    if(radius>=maxRadius)return null;
    radius=Math.min(maxRadius,radius*2);
  }
}

export function normalizeFillLoops(loops:FillPoint[][],bounds:FillRegionBounds):FillPoint[][] {
  const width=Math.max(Number.EPSILON,bounds.right-bounds.left),height=Math.max(Number.EPSILON,bounds.bottom-bounds.top);
  return loops.map(loop=>loop.map(point=>({x:(point.x-bounds.left)/width,y:(point.y-bounds.top)/height})));
}

export function fillPathData(loops:FillPoint[][],bounds:FillRegionBounds):string {
  const width=bounds.right-bounds.left,height=bounds.bottom-bounds.top;
  return loops.map(loop=>{
    if(!loop.length)return "";
    const first=loop[0],head=`M ${bounds.left+first.x*width} ${bounds.top+first.y*height}`;
    return `${head}${loop.slice(1).map(point=>` L ${bounds.left+point.x*width} ${bounds.top+point.y*height}`).join("")} Z`;
  }).filter(Boolean).join(" ");
}
