import assert from "node:assert/strict";
import test from "node:test";
import { fillPathData, findEnclosedFillRegion, normalizeFillLoops } from "../src/features/editor/fill-regions.ts";

const stroke=(points:Array<[number,number]>,width=2)=>({width,points:points.map(([x,y])=>({x,y}))});
const opts={cellSize:1.5,initialRadius:90,maxRadius:240,maxCells:400_000};

test("fills a hand-drawn closed stroke instead of requiring a primitive shape",()=>{
  const boundary=stroke([[0,0],[100,1],[101,100],[0,99],[0,0]],3);
  const region=findEnclosedFillRegion({x:50,y:50},[boundary],[],opts);
  assert.ok(region);
  assert.ok(region.bounds.left<5&&region.bounds.right>95);
  assert.ok(region.bounds.top<5&&region.bounds.bottom>95);
  assert.ok(region.loops[0].length>=4);
});

test("fills an area enclosed by several separate drawing strokes",()=>{
  const strokes=[
    stroke([[0,0],[100,0]]),
    stroke([[100,0],[100,100]]),
    stroke([[100,100],[0,100]]),
    stroke([[0,100],[0,0]]),
  ];
  const region=findEnclosedFillRegion({x:50,y:50},strokes,[],opts);
  assert.ok(region);
  assert.ok((region.bounds.right-region.bounds.left)>90);
  assert.ok((region.bounds.bottom-region.bounds.top)>90);
});

test("supports mixed ink and vector outlines as one closed boundary",()=>{
  const strokes=[stroke([[0,0],[100,0]]),stroke([[0,100],[0,0]])];
  const shapes=[
    {kind:"line" as const,x1:100,y1:0,x2:100,y2:100,strokeWidth:2},
    {kind:"line" as const,x1:100,y1:100,x2:0,y2:100,strokeWidth:2},
  ];
  assert.ok(findEnclosedFillRegion({x:50,y:50},strokes,shapes,opts));
});

test("bridges a small hand-drawn endpoint gap without accepting a clearly open boundary",()=>{
  const almostClosed=[
    stroke([[0,0],[96,0]]),
    stroke([[100,0],[100,100]]),
    stroke([[100,100],[0,100]]),
    stroke([[0,100],[0,0]]),
  ];
  assert.ok(findEnclosedFillRegion({x:50,y:50},almostClosed,[],opts));
  const clearlyOpen=[...almostClosed.slice(1),stroke([[0,0],[88,0]])];
  assert.equal(findEnclosedFillRegion({x:50,y:50},clearlyOpen,[],opts),null);
});

test("does not fill an open drawing that leaks to the outside",()=>{
  const strokes=[
    stroke([[0,0],[100,0]]),
    stroke([[100,0],[100,100]]),
    stroke([[100,100],[0,100]]),
  ];
  assert.equal(findEnclosedFillRegion({x:50,y:50},strokes,[],opts),null);
});

test("preserves holes inside the selected fill region",()=>{
  const outer=stroke([[0,0],[140,0],[140,140],[0,140],[0,0]],3);
  const inner=stroke([[45,45],[95,45],[95,95],[45,95],[45,45]],3);
  const region=findEnclosedFillRegion({x:20,y:20},[outer,inner],[],{...opts,initialRadius:110});
  assert.ok(region);
  assert.ok(region.loops.length>=2,"expected an outer loop and an inner hole");
});

test("normalizes traced loops and renders them as a closed SVG path",()=>{
  const bounds={left:10,top:20,right:110,bottom:70};
  const loops=[[{x:10,y:20},{x:110,y:20},{x:110,y:70},{x:10,y:70}]];
  const normalized=normalizeFillLoops(loops,bounds);
  assert.deepEqual(normalized,[[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]]);
  assert.match(fillPathData(normalized,bounds),/^M 10 20 .* Z$/);
});


test("keeps narrow corridors connected instead of splitting the fill into islands",()=>{
  const strokes=[
    stroke([[0,20],[44,20],[44,8],[76,8],[76,20],[120,20]],3),
    stroke([[120,20],[120,80],[76,80],[76,92],[44,92],[44,80],[0,80],[0,20]],3),
  ];
  const region=findEnclosedFillRegion({x:20,y:50},strokes,[],{...opts,cellSize:1.1,initialRadius:100});
  assert.ok(region);
  assert.ok(region.bounds.right-region.bounds.left>110);
});

test("traces fills tightly enough to avoid coarse inset borders",()=>{
  const region=findEnclosedFillRegion({x:50,y:50},[stroke([[0,0],[100,0],[100,100],[0,100],[0,0]],4)],[],{...opts,cellSize:1.0,initialRadius:90});
  assert.ok(region);
  assert.ok(region.bounds.left<2.5);
  assert.ok(region.bounds.top<2.5);
  assert.ok(region.bounds.right>97.5);
  assert.ok(region.bounds.bottom>97.5);
});
