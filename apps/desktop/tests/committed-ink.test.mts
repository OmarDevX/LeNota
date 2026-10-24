import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pressureStrokePath, smoothInkPath, type InkStroke } from "../src/features/editor/pen-input.ts";
import { themeAwareInkColor } from "../src/features/editor/ink-output-color.ts";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/features/editor/committed-ink.tsx", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime"] });
const compiled = { exports: {} as { CommittedInkLayer: any } };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);

const strokes: InkStroke[] = [
  {id:"pressure",tool:"pen",color:"#d4d4d8",width:3,pressureEnabled:true,minPressureScale:.3,maxPressureScale:1.7,smoothing:.86,
    points:Array.from({length:120},(_,i)=>({x:30+i*2,y:80+Math.sin(i*.1)*40,pressure:.1+(i%19)/20}))},
  {id:"line",tool:"pen",color:"#111827",width:1,points:[{x:15,y:14,pressure:1},{x:20,y:31,pressure:.1}]},
  {id:"highlight",tool:"highlighter",color:"#ffff00",width:14,points:[{x:10,y:15,pressure:.2},{x:100,y:25,pressure:.9}]},
  {id:"dot",tool:"pen",color:"#123456",width:5,pressureEnabled:true,points:[{x:200,y:30,pressure:.4}]},
];

function baseline(ink:InkStroke[],selected:Set<string>,theme:"dark"|"light",live?:string) {
  return ink.map(stroke=>stroke.id===live?null:createElement("g",{key:stroke.id},
    selected.has(stroke.id)?createElement("path",{d:smoothInkPath(stroke.points,stroke.smoothing??.7),fill:"none",stroke:"#a78bfa",strokeWidth:stroke.width+7,strokeLinecap:"round",strokeLinejoin:"round",opacity:".28"}):null,
    stroke.tool==="pen"&&stroke.pressureEnabled
      ?createElement("path",{d:pressureStrokePath(stroke),fill:themeAwareInkColor(stroke.color,theme),stroke:"none",opacity:stroke.opacity??1})
      :createElement("path",{d:smoothInkPath(stroke.points,stroke.smoothing??.7),fill:"none",stroke:themeAwareInkColor(stroke.color,theme),strokeWidth:stroke.width,strokeLinecap:"round",strokeLinejoin:"round",opacity:stroke.opacity??(stroke.tool==="highlighter"?.32:1),style:{mixBlendMode:stroke.tool==="highlighter"?"multiply":"normal"}})));
}

test("optimized ink renders exactly the same SVG in both themes, including selection and live strokes",()=>{
  for(const theme of ["dark","light"] as const) for(const selectedIds of [new Set<string>(),new Set(strokes.map(stroke=>stroke.id))]) {
    for(const liveStrokeId of [undefined,"pressure"]) {
      const actual = renderToStaticMarkup(createElement("svg",null,createElement(compiled.exports.CommittedInkLayer,{ink:strokes,selectedIds,theme,liveStrokeId})));
      const expected = renderToStaticMarkup(createElement("svg",null,baseline(strokes,selectedIds,theme,liveStrokeId)));
      assert.equal(actual,expected);
    }
  }
});

test("changed width, pressure range, smoothing, and moved ink retain exact geometry",()=>{
  const changed=strokes.map(stroke=>({...stroke,width:stroke.width*2,smoothing:.4,minPressureScale:.1,maxPressureScale:2,
    points:stroke.points.map(point=>({...point,x:point.x+15,y:point.y-20}))}));
  const selectedIds=new Set(["pressure"]);
  assert.equal(renderToStaticMarkup(createElement(compiled.exports.CommittedInkLayer,{ink:changed,selectedIds,theme:"light"})),
    renderToStaticMarkup(createElement("g",null,baseline(changed,selectedIds,"light"))).replace(/^<g>|<\/g>$/g,""));
});
