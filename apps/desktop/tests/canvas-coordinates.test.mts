import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasToClientPoint,
  canvasTransformFromRenderedRect,
  clientDeltaToCanvasDelta,
  clientToCanvasPoint,
} from "../src/features/editor/canvas-coordinates.ts";

test("pointer mapping follows the rendered pan and zoom",()=>{
  const transform=canvasTransformFromRenderedRect({left:340,top:-125,width:12000,height:12000},8000,8000,1);
  assert.deepEqual(transform,{left:340,top:-125,scaleX:1.5,scaleY:1.5});
  assert.deepEqual(clientToCanvasPoint(790,325,transform),{x:300,y:300});
  assert.deepEqual(canvasToClientPoint(300,300,transform),{x:790,y:325});
});

test("pointer mapping stays correct when the rendered transform is newer than state",()=>{
  // The fallback says 100%, but the DOM has already rendered a 60% zoom.
  const transform=canvasTransformFromRenderedRect({left:-220,top:90,width:4800,height:4800},8000,8000,1);
  assert.equal(transform.scaleX,.6);
  assert.deepEqual(clientToCanvasPoint(80,390,transform),{x:500,y:500});
  assert.deepEqual(clientDeltaToCanvasDelta(60,-30,transform),{x:100,y:-50});
});

test("invalid dimensions safely use the fallback scale",()=>{
  const transform=canvasTransformFromRenderedRect({left:10,top:20,width:0,height:0},0,0,1.25);
  assert.deepEqual(transform,{left:10,top:20,scaleX:1.25,scaleY:1.25});
});
