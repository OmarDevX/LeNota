/** Spatial buckets for canvas rendering. Source arrays remain authoritative for
 * saving, selection, AI context, undo, sync, export, and search. Only the view
 * layer queries this index. Results preserve source/z ordering. */
export interface SpatialBounds { left:number; top:number; right:number; bottom:number }
export interface SpatialViewport { x:number; y:number; zoom:number }
export interface SpatialSize { width:number; height:number }

export function intersectsBounds(a:SpatialBounds,b:SpatialBounds):boolean {
  return a.left<=b.right && a.right>=b.left && a.top<=b.bottom && a.bottom>=b.top;
}

export function paddedWorldBounds(viewport:SpatialViewport,size:SpatialSize,padding=1300):SpatialBounds {
  const zoom=Math.max(.01,viewport.zoom);
  return {
    left:-viewport.x/zoom-padding/zoom,
    top:-viewport.y/zoom-padding/zoom,
    right:(size.width-viewport.x)/zoom+padding/zoom,
    bottom:(size.height-viewport.y)/zoom+padding/zoom,
  };
}

export function viewportNeedsRefresh(current:SpatialBounds,viewport:SpatialViewport,size:SpatialSize,margin=400):boolean {
  const visible=paddedWorldBounds(viewport,size,margin);
  return visible.left<current.left || visible.top<current.top ||
    visible.right>current.right || visible.bottom>current.bottom;
}

/** Virtualize on a paused gesture, unless the viewport is close enough to
 * expose blank space before React can mount the next rich editor. */
export function canvasMountUrgency(current:SpatialBounds,viewport:SpatialViewport,size:SpatialSize):"none"|"defer"|"now" {
  if(!viewportNeedsRefresh(current,viewport,size,400))return "none";
  return viewportNeedsRefresh(current,viewport,size,150)?"now":"defer";
}

export function mergeBounds(a:SpatialBounds,b:SpatialBounds):SpatialBounds {
  return {left:Math.min(a.left,b.left),top:Math.min(a.top,b.top),right:Math.max(a.right,b.right),bottom:Math.max(a.bottom,b.bottom)};
}

const TILE=512;
const MAX_CELLS_PER_OBJECT=128;

export class SpatialIndex<T> {
  private readonly cells=new Map<string,number[]>();
  private readonly overflow:number[]=[];
  private readonly geometries:SpatialBounds[]=[];
  private readonly items:readonly T[];
  constructor(items:readonly T[], getBounds:(item:T)=>SpatialBounds) {
    this.items=items;
    items.forEach((item,index)=>{
      const bounds=getBounds(item);
      this.geometries.push(bounds);
      if(!Number.isFinite(bounds.left+bounds.top+bounds.right+bounds.bottom)){
        // Never accidentally hide an object whose geometry cannot be computed.
        this.overflow.push(index);return;
      }
      const minX=Math.floor(bounds.left/TILE),maxX=Math.floor(bounds.right/TILE);
      const minY=Math.floor(bounds.top/TILE),maxY=Math.floor(bounds.bottom/TILE);
      if((maxX-minX+1)*(maxY-minY+1)>MAX_CELLS_PER_OBJECT){this.overflow.push(index);return;}
      for(let x=minX;x<=maxX;x++) for(let y=minY;y<=maxY;y++){
        const key=`${x}:${y}`;
        const bucket=this.cells.get(key);
        if(bucket)bucket.push(index);else this.cells.set(key,[index]);
      }
    });
  }
  query(bounds:SpatialBounds):T[] {
    const indices=new Set(this.overflow);
    const minX=Math.floor(bounds.left/TILE),maxX=Math.floor(bounds.right/TILE);
    const minY=Math.floor(bounds.top/TILE),maxY=Math.floor(bounds.bottom/TILE);
    const cellCount=(maxX-minX+1)*(maxY-minY+1);
    if(!Number.isFinite(cellCount)||cellCount>25000){
      // A fit-to-all, gigantic lasso or corrupt zoom must not loop millions
      // of empty tiles. Fall back to a bounded O(document-size) scan.
      for(let i=0;i<this.items.length;i++)indices.add(i);
    } else {
      for(let x=minX;x<=maxX;x++) for(let y=minY;y<=maxY;y++){
        for(const index of this.cells.get(`${x}:${y}`)??[])indices.add(index);
      }
    }
    // Preserve source order, even where an object occupies multiple tiles.
    return [...indices].sort((a,b)=>a-b)
      .filter(index=>intersectsBounds(this.geometries[index],bounds))
      .map(index=>this.items[index]);
  }
}

/** Note heights start as generous estimates until their rich editor has been
 * mounted and measured. Overestimating costs performance, not missing content. */
export function estimatedNoteBounds(note:{x:number;y:number;width:number;minHeight:number;plainText:string},measuredHeight?:number):SpatialBounds {
  const conservativeHeight=Math.max(note.minHeight,200,
    Math.min(150000,120+(note.plainText?.length??0)*2.2));
  return {left:note.x,top:note.y,right:note.x+note.width,
    bottom:note.y+(measuredHeight===undefined?conservativeHeight:Math.max(conservativeHeight,measuredHeight))};
}
