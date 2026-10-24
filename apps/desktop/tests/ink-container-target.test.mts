import assert from "node:assert/strict";
import test from "node:test";
import { chooseInkContainerTarget } from "../src/features/editor/ink-container-target.ts";

const note=(id:string,left:number,top:number,right:number,bottom:number,zIndex=1)=>({id,bounds:{left,top,right,bottom},zIndex});

test("targets the container underneath handwritten text",()=>{
  assert.equal(chooseInkContainerTarget({left:140,top:150,right:260,bottom:190},[note("note-1",100,100,500,400)]),"note-1");
});

test("does not pull nearby handwriting into a container",()=>{
  assert.equal(chooseInkContainerTarget({left:510,top:150,right:630,bottom:190},[note("note-1",100,100,500,400)]),null);
});

test("prefers the topmost note when containers overlap equally",()=>{
  const ink={left:180,top:180,right:230,bottom:220};
  assert.equal(chooseInkContainerTarget(ink,[note("back",100,100,400,400,2),note("front",100,100,400,400,9)]),"front");
});
