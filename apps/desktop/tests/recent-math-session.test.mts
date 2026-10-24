import assert from "node:assert/strict";
import test from "node:test";
import { confirmAllRecentMathConversions, findReopenableMathConversion } from "../src/features/editor/recent-math-session.ts";

const conversion=(expiresAt:number)=>({
  bounds:{left:100,top:100,right:240,bottom:180},
  expiresAt,
});

test("a nearby stroke can reopen an unconfirmed recent equation",()=>{
  const conversions=new Map([["math-1",conversion(40_000)]]);
  assert.equal(findReopenableMathConversion(conversions,{x:250,y:150},10_000),"math-1");
});

test("confirming math prevents every recent equation from reopening",()=>{
  const conversions=new Map([
    ["math-1",conversion(40_000)],
    ["math-2",{...conversion(40_000),bounds:{left:400,top:100,right:520,bottom:180}}],
  ]);
  assert.equal(confirmAllRecentMathConversions(conversions),2);
  assert.equal(findReopenableMathConversion(conversions,{x:250,y:150},10_000),null);
  assert.equal(findReopenableMathConversion(conversions,{x:530,y:150},10_000),null);
});

test("an expired equation is no longer reopenable",()=>{
  const conversions=new Map([["math-1",conversion(9_999)]]);
  assert.equal(findReopenableMathConversion(conversions,{x:150,y:140},10_000),null);
});
