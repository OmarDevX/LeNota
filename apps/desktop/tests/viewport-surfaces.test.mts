import assert from "node:assert/strict";
import test from "node:test";
import { createViewportSurfaces, paddedSurfaceBounds, paperPresentation, reconcileViewport, viewportWorldBounds } from "../src/features/editor/viewport-surfaces.ts";

function fakeSvg() {
  const attrs = new Map<string,string>();
  let writes = 0;
  const style: Record<string,string> = {};
  const element = { style, setAttribute(key:string,value:string) { attrs.set(key,value); writes++; }, removeAttribute(key:string) { attrs.delete(key); writes++; } };
  return { element: element as unknown as SVGSVGElement, attrs, style, writes:()=>writes };
}
const size = {width:1360,height:760};

test("vector surfaces cover the entire viewport with bounded screen-space padding at all zoom levels",()=>{
  for(const zoom of [.35,.5,1,1.75,2.5]) for(const x of [-50000,-100.25,0,88,49000]) {
    const viewport={x,y:x*.4,zoom};
    const visible=viewportWorldBounds(viewport,size), padded=paddedSurfaceBounds(viewport,size);
    assert.ok(padded.left<=visible.left&&padded.right>=visible.right&&padded.top<=visible.top&&padded.bottom>=visible.bottom);
    assert.ok((padded.right-padded.left)*zoom<=size.width+2048+1e-7);
    assert.ok((padded.bottom-padded.top)*zoom<=size.height+2048+1e-7);
    // Matching the SVG's CSS location and viewBox origin cancels the offset.
    const worldPoint={x:visible.left+20,y:visible.top+30};
    assert.ok(Math.abs(((worldPoint.x-padded.left)+padded.left)*zoom+x-20*zoom)<1e-7);
  }
});

test("small pans reuse SVG backing bounds without layout/viewBox writes",()=>{
  const ink=fakeSvg(),shapes=fakeSvg();
  const surfaces=createViewportSurfaces(()=>[ink.element,shapes.element]);
  surfaces.sync({x:0,y:0,zoom:1},size);
  const initial=ink.writes();
  for(let x=1;x<=120;x++)surfaces.sync({x,y:30,zoom:1},size);
  assert.equal(ink.writes(),initial);
  assert.equal(ink.style.willChange,"auto","rebased SVG roots must not force stale compositor textures");
  surfaces.sync({x:3000,y:0,zoom:1},size);
  assert.ok(ink.writes()>initial);
  const [left,top,width,height]=ink.attrs.get("viewBox")!.split(" ").map(Number);
  const visible=viewportWorldBounds({x:3000,y:0,zoom:1},size);
  assert.ok(left<=visible.left&&left+width>=visible.right&&top<=visible.top&&top+height>=visible.bottom);
  assert.equal(ink.style.overflow,"hidden");
  assert.equal(ink.style.willChange,"auto");
});

test("small trackpad zoom steps do not force SVG viewBox reallocation",()=>{
  const svg=fakeSvg(),surfaces=createViewportSurfaces(()=>[svg.element]);
  surfaces.sync({x:0,y:0,zoom:1},size);
  const initial=svg.writes();
  // The current SVG includes enough room for moderate zoom-out and multiple
  // zoom-in steps; the parent transform handles all of these changes.
  for (const zoom of [.99,.97,.95,.92,1.03,1.08]) {
    surfaces.sync({x:0,y:0,zoom},size);
  }
  assert.equal(svg.writes(),initial,"zoom should not repeatedly resize the SVG backing surface");
  surfaces.sync({x:0,y:0,zoom:.35},size);
  assert.ok(svg.writes()>initial,"a large zoom-out must grow the surface to avoid clipping");
});

test("long pan reuses the same SVG layer until the expanded safety buffer is exhausted",()=>{
  const svg=fakeSvg(),surfaces=createViewportSurfaces(()=>[svg.element]);
  surfaces.sync({x:0,y:0,zoom:1},size);
  const initial=svg.writes();
  for (let x=0; x<=350; x+=10) surfaces.sync({x,y:0,zoom:1},size);
  assert.equal(svg.writes(),initial);
  surfaces.sync({x:1500,y:0,zoom:1},size);
  assert.ok(svg.writes()>initial);
});

test("zoom and resize refresh bounds without changing world coordinates",()=>{
  const svg=fakeSvg(),surfaces=createViewportSurfaces(()=>[svg.element]);
  surfaces.sync({x:0,y:0,zoom:1},size);
  surfaces.sync({x:300,y:100,zoom:.35},{width:1800,height:1100});
  const [left,top,width,height]=svg.attrs.get("viewBox")!.split(" ").map(Number);
  assert.equal(svg.style.left,`${left}px`);
  assert.equal(svg.style.top,`${top}px`);
  assert.equal(Number(svg.attrs.get("width")),width);
  assert.equal(Number(svg.attrs.get("height")),height);
  assert.ok(width*.35<=1800+2048+1e-7);
});

test("visual capture includes off-screen lasso bounds and then restores small surfaces",()=>{
  const svg=fakeSvg(),surfaces=createViewportSurfaces(()=>[svg.element]);
  surfaces.sync({x:88,y:72,zoom:1},size);
  const before=svg.attrs.get("viewBox");
  const release=surfaces.pinCapture({left:-4000,top:-5000,right:6000,bottom:7000});
  const [left,top,width,height]=svg.attrs.get("viewBox")!.split(" ").map(Number);
  assert.ok(left<=-4000&&top<=-5000&&left+width>=6000&&top+height>=7000);
  assert.equal(svg.style.willChange,"auto","captures must not force enormous GPU layers");
  release(); release();
  assert.equal(svg.attrs.get("viewBox"),before);
});

test("printing restores the full unclipped roots and returns to viewport bounds afterward",()=>{
  const svg=fakeSvg(),surfaces=createViewportSurfaces(()=>[svg.element]);
  surfaces.sync({x:-2500,y:-1200,zoom:1},size);
  const before=svg.attrs.get("viewBox");
  const endPrint=surfaces.unclipForPrint();
  assert.equal(svg.attrs.has("viewBox"),false);
  assert.equal(svg.attrs.get("width"),"8000");
  assert.equal(svg.style.overflow,"visible");
  endPrint(); endPrint();
  assert.equal(svg.attrs.get("viewBox"),before);
  assert.equal(svg.style.overflow,"hidden");
});

test("paper grid and ruling retain the original phase, including negative and fractional scrolling",()=>{
  const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
  for(const pattern of ["grid","ruled"] as const) for(const zoom of [.35,1,2.5]) for(const x of [-50000,-17.5,0,88.25,50000]) {
    const viewport={x,y:x*.37,zoom},spacing=26;
    const paper=paperPresentation(pattern,spacing,viewport),period=spacing*zoom;
    const phase=(v:number)=>((v%period)+period)%period;
    const background=paper.backgroundPosition.split(" ").map(parseFloat);
    // Position at canvas origin = layer location + background position + transform.
    near(-paper.margin+background[0]+(paper.composited?paper.x:0),pattern==="grid"?phase(x):0);
    near(-paper.margin+background[1]+(paper.composited?paper.y:0),phase(viewport.y));
    assert.ok(paper.x<=paper.margin&&paper.y<=paper.margin);
  }
});

test("very large custom paper spacing avoids oversized compositor layers",()=>{
  const paper=paperPresentation("grid",10000,{x:50000,y:-123.5,zoom:2.5});
  assert.equal(paper.composited,false);
  assert.equal(paper.margin,0);
  assert.equal(paper.transform,"none");
  assert.equal(paper.backgroundSize,"25000px 25000px");
  assert.equal(paperPresentation("plain",26,{x:20,y:30,zoom:1}).backgroundSize,"auto");
});

test("typing, AI status, and save renders preserve the live pan position until a viewport state change",()=>{
  const rendered={x:88,y:72,zoom:1};
  const scrolling={x:-400,y:-600,zoom:1};
  assert.strictEqual(reconcileViewport(rendered,rendered,scrolling),scrolling);
  const newState={x:0,y:0,zoom:.5};
  assert.strictEqual(reconcileViewport(newState,rendered,scrolling),newState);
});
