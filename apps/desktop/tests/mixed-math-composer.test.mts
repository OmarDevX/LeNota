import assert from "node:assert/strict";
import test from "node:test";
import { composeMixedMath, typedMathToLatex, type MixedMathPart } from "../src/features/editor/mixed-math-composer.ts";

const part=(id:string,latex:string,left:number,top:number,right:number,bottom:number,source:MixedMathPart["source"]="text"):MixedMathPart=>({id,latex,bounds:{left,top,right,bottom},source});

test("composes the reported drawn sum plus typed limits and body",()=>{
  const result=composeMixedMath([
    part("sum","\\sum",228,170,410,482,"ink"),
    part("upper","5",343,145,360,175),
    part("lower","k=10",400,548,455,578),
    part("body","x+20",627,348,690,378),
  ]);
  assert.equal(result.latex,"\\sum_{k=10}^{5} \\left(x+20\\right)");
  assert.deepEqual(result.upperIds,["upper"]);
  assert.deepEqual(result.lowerIds,["lower"]);
  assert.deepEqual(result.bodyIds,["body"]);
});

test("composes an existing integral symbol with typed bounds and function",()=>{
  const result=composeMixedMath([
    part("integral","\\int",100,120,145,310,"math"),
    part("upper","1",145,95,165,120),
    part("lower","0",140,315,160,340),
    part("body","x^2 dx",190,205,270,235),
  ]);
  assert.equal(result.latex,"\\int_{0}^{1} x^2 dx");
});

test("uses a selected bar with typed numerator and denominator as a fraction",()=>{
  const result=composeMixedMath([
    part("bar","\\frac",100,200,300,204,"ink"),
    part("numerator","x+1",160,150,210,178),
    part("denominator","x-1",160,230,210,258),
  ]);
  assert.equal(result.latex,"\\frac{x+1}{x-1}");
});

test("supports friendly typed math and existing function symbols",()=>{
  assert.equal(typedMathToLatex("sqrt(x+1)"),"\\sqrt{x+1}");
  assert.equal(typedMathToLatex("sin(x)"),"\\sin\\left(x\\right)");
  assert.equal(typedMathToLatex("k ≤ 10"),"k \\le 10");
  assert.equal(composeMixedMath([part("sin","\\sin",0,100,40,130,"math"),part("arg","x+1",60,100,105,130)]).latex,"\\sin\\left(x+1\\right)");
});

test("positions a separate typed exponent without AI",()=>{
  const result=composeMixedMath([
    part("base","x",100,200,125,235),
    part("power","2",126,175,140,195),
  ]);
  assert.equal(result.latex,"x^{2}");
});

test("combines an existing bounded LaTeX operator with newly typed text",()=>{
  const result=composeMixedMath([
    part("existing","\\sum_{k=1}^{n}",100,120,240,310,"math"),
    part("body","a_k",280,205,330,235),
  ]);
  assert.equal(result.latex,"\\sum_{k=1}^{n} a_k");
});
