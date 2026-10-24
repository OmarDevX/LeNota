import assert from "node:assert/strict";
import test from "node:test";
import { BUTTON_ZOOM_DURATION_MS, interpolateButtonZoom } from "../src/features/editor/button-zoom-animation.ts";

const from={x:-100,y:40,zoom:1};
const to={x:-230,y:-50,zoom:1.5};

test("button zoom interpolates endpoints without overshoot",()=>{
  assert.deepEqual(interpolateButtonZoom(from,to,0),from);
  assert.deepEqual(interpolateButtonZoom(from,to,1),to);
  assert.deepEqual(interpolateButtonZoom(from,to,-1),from);
  assert.deepEqual(interpolateButtonZoom(from,to,2),to);
  assert.ok(BUTTON_ZOOM_DURATION_MS>=180&&BUTTON_ZOOM_DURATION_MS<=320);
  for(let i=1;i<=100;i++){
    const current=interpolateButtonZoom(from,to,i/100);
    assert.ok(current.zoom>=from.zoom&&current.zoom<=to.zoom);
    assert.ok(current.x<=from.x&&current.x>=to.x);
  }
});

test("button zoom preserves the same focal world point through animation",()=>{
  const viewport={x:210,y:150,zoom:1};
  const cx=600, cy=400;
  const nextZoom=1.1;
  const wx=(cx-viewport.x)/viewport.zoom, wy=(cy-viewport.y)/viewport.zoom;
  const dest={zoom:nextZoom,x:cx-wx*nextZoom,y:cy-wy*nextZoom};
  for(const progress of [.03,.2,.5,.7,.95,1]){
    const v=interpolateButtonZoom(viewport,dest,progress);
    assert.ok(Math.abs((v.x+wx*v.zoom)-cx)<1e-9);
    assert.ok(Math.abs((v.y+wy*v.zoom)-cy)<1e-9);
  }
});

test("a new click can resume from a displayed intermediate view",()=>{
  const current=interpolateButtonZoom(from,to,.42);
  const final={x:-300,y:-110,zoom:1.65};
  assert.deepEqual(interpolateButtonZoom(current,final,0),current);
  assert.deepEqual(interpolateButtonZoom(current,final,1),final);
});
