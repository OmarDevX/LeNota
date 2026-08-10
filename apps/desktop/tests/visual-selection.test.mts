import assert from "node:assert/strict";
import test from "node:test";
import { describeVisualCaptureError, detectVisualImageMimeType, shouldCaptureVisualBaseNode, shouldCaptureVisualNode, visualImageDrawPlacement, visualSelectionBounds } from "../src/features/editor/visual-selection.ts";

test("adds capture padding around a visual lasso",()=>{
  assert.deepEqual(visualSelectionBounds([{x:100,y:80},{x:300,y:80},{x:300,y:180},{x:100,y:180}],20),{
    left:80,top:60,right:320,bottom:200,width:240,height:140,
  });
});

test("rejects a click or tiny accidental lasso",()=>{
  assert.equal(visualSelectionBounds([{x:10,y:10},{x:11,y:11},{x:12,y:10}],4),null);
});

test("capture filter accepts non-Element nodes without crashing",()=>{
  const hidden=new Set(["canvas-floating-ui"]);
  assert.equal(shouldCaptureVisualNode({},hidden),true);
  assert.equal(shouldCaptureVisualNode({classList:null},hidden),true);
  assert.equal(shouldCaptureVisualNode({classList:{length:1,item:()=>"canvas-floating-ui"}},hidden),false);
});


test("base visual capture excludes raster image nodes without excluding their wrappers",()=>{
  const hidden=new Set(["canvas-floating-ui"]);
  assert.equal(shouldCaptureVisualBaseNode({tagName:"IMG"},hidden),false);
  assert.equal(shouldCaptureVisualBaseNode({tagName:"img"},hidden),false);
  assert.equal(shouldCaptureVisualBaseNode({tagName:"DIV"},hidden),true);
  assert.equal(shouldCaptureVisualBaseNode({tagName:"DIV",classList:{length:1,item:()=>"canvas-floating-ui"}},hidden),false);
});

test("detects managed PDF-page and photo image bytes",()=>{
  assert.equal(detectVisualImageMimeType(Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),"image/png");
  assert.equal(detectVisualImageMimeType(Uint8Array.from([0xff,0xd8,0xff,0xe0])),"image/jpeg");
});

test("turns browser load events into a useful capture error",()=>{
  assert.doesNotMatch(describeVisualCaptureError({toString:()=>"[object Event]"}),/\[object Event\]/);
  assert.match(describeVisualCaptureError(new Error("Image bytes failed")),/Image bytes failed/);
});


test("maps a visible PDF/image layer into the lasso screenshot",()=>{
  const bounds={left:100,top:50,right:500,bottom:350,width:400,height:300};
  const placement=visualImageDrawPlacement({x:260,y:170},240,120,90,bounds,2);
  assert.equal(placement.centerX,320);
  assert.equal(placement.centerY,240);
  assert.equal(placement.width,480);
  assert.equal(placement.height,240);
  assert.ok(Math.abs(placement.rotationRadians-Math.PI/2)<1e-12);
});
