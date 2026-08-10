export interface VisualPoint {x:number;y:number;}
export interface VisualSelectionBounds {left:number;top:number;right:number;bottom:number;width:number;height:number;}
export interface VisualImageDrawPlacement {centerX:number;centerY:number;width:number;height:number;rotationRadians:number;}

export interface CaptureNodeLike {
  classList?: {length:number;item(index:number):string|null}|null;
  tagName?: string|null;
}

/** html-to-image can pass non-Element nodes to its filter in WebKitGTK. */
export function shouldCaptureVisualNode(node:CaptureNodeLike,hiddenClasses:ReadonlySet<string>):boolean {
  const classes=node?.classList;
  if(!classes)return true;
  for(let index=0;index<classes.length;index+=1){
    const className=classes.item(index);
    if(className&&hiddenClasses.has(className))return false;
  }
  return true;
}

/** Base DOM capture must never ask html-to-image to reload raster images.
 * Their layout is guarded separately and their pixels are composited from the
 * managed attachment bytes (or the already-rendered element as a fallback). */
export function shouldCaptureVisualBaseNode(node:CaptureNodeLike,hiddenClasses:ReadonlySet<string>):boolean {
  if(!shouldCaptureVisualNode(node,hiddenClasses))return false;
  return String(node?.tagName??"").toUpperCase()!=="IMG";
}

export function detectVisualImageMimeType(bytes:Uint8Array):string {
  if(bytes.length>=8&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47)return "image/png";
  if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return "image/jpeg";
  if(bytes.length>=6&&String.fromCharCode(...bytes.slice(0,6)).startsWith("GIF8"))return "image/gif";
  if(bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==="RIFF"&&String.fromCharCode(...bytes.slice(8,12))==="WEBP")return "image/webp";
  if(bytes.length>=2&&bytes[0]===0x42&&bytes[1]===0x4d)return "image/bmp";
  const prefix=new TextDecoder().decode(bytes.slice(0,512)).trimStart();
  if(prefix.startsWith("<svg")||prefix.startsWith("<?xml")&&prefix.includes("<svg"))return "image/svg+xml";
  return "image/png";
}

export function describeVisualCaptureError(error:unknown):string {
  if(error instanceof Error&&error.message.trim())return error.message.trim();
  if(typeof Event!=="undefined"&&error instanceof Event)return `Browser ${error.type||"resource"} event while loading the selected image`;
  if(error&&typeof error==="object"&&"message" in error&&typeof error.message==="string"&&error.message.trim())return error.message.trim();
  if(typeof error==="string"&&error.trim()&&error!=="[object Event]")return error.trim();
  return "LeNota could not load one of the selected visual resources";
}


/** Convert a visible image's world-space center/size into output screenshot pixels.
 * The image is drawn independently from html-to-image so WebKitGTK cannot
 * silently drop managed photos or rendered PDF printout pages. */
export function visualImageDrawPlacement(
  center:VisualPoint,
  width:number,
  height:number,
  rotationDegrees:number,
  bounds:VisualSelectionBounds,
  outputScale:number,
):VisualImageDrawPlacement {
  const scale=Number.isFinite(outputScale)&&outputScale>0?outputScale:1;
  return {
    centerX:(center.x-bounds.left)*scale,
    centerY:(center.y-bounds.top)*scale,
    width:Math.max(0,width)*scale,
    height:Math.max(0,height)*scale,
    rotationRadians:(Number.isFinite(rotationDegrees)?rotationDegrees:0)*Math.PI/180,
  };
}

export function visualSelectionBounds(points:VisualPoint[],padding=18):VisualSelectionBounds|null {
  if(points.length<3)return null;
  const xs=points.map(point=>point.x),ys=points.map(point=>point.y);
  const left=Math.min(...xs)-padding,top=Math.min(...ys)-padding;
  const right=Math.max(...xs)+padding,bottom=Math.max(...ys)+padding;
  const width=right-left,height=bottom-top;
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<44||height<44)return null;
  return {left,top,right,bottom,width,height};
}
