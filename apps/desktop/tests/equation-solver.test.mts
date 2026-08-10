import assert from "node:assert/strict";
import test from "node:test";
import { analyzeLatexSolveCandidate, canSolveLatexEquationLocally, evaluateLatexRelationAt, solveLatexEquationLocally } from "../src/features/editor/equation-solver.ts";

function solved(latex:string):string|null {
  return solveLatexEquationLocally(latex)?.solvedLatex ?? null;
}

test("solves calculator-style arithmetic only when the RHS is blank",()=>{
  assert.equal(solved("1+1="),"1+1=2");
  assert.equal(solved(String.raw`\frac{1}{2}+\frac{1}{4}=`),String.raw`\frac{1}{2}+\frac{1}{4}=\frac{3}{4}`);
  assert.equal(solved(String.raw`\sqrt{16}=`),String.raw`\sqrt{16}=4`);
  assert.equal(solved("2+2=4"),null);
});

test("solves common one-variable linear equations",()=>{
  assert.equal(solved("2x+3=7"),String.raw`2x+3=7\quad\Rightarrow\quad x=2`);
  assert.equal(solved("2(x+1)=6"),String.raw`2(x+1)=6\quad\Rightarrow\quad x=2`);
  assert.equal(solved(String.raw`\frac{x}{2}+1=3`),String.raw`\frac{x}{2}+1=3\quad\Rightarrow\quad x=4`);
  assert.equal(solved("x=1+1"),String.raw`x=1+1\quad\Rightarrow\quad x=2`);
});

test("solves real quadratic equations and writes both roots into the same latex",()=>{
  assert.equal(solved("x^2-5x+6=0"),String.raw`x^2-5x+6=0\quad\Rightarrow\quad x=2,\;x=3`);
  assert.equal(solved("x^2=4"),String.raw`x^2=4\quad\Rightarrow\quad x=-2,\;x=2`);
});

test("does not advertise solve for already solved, ambiguous, or unsupported equations",()=>{
  for(const latex of [
    "x=2",
    "2=x",
    "a+b=c",
    "x^3=8",
    String.raw`\sin(x)=0`,
    String.raw`\sqrt[3]{8}=`,
    "hello=world",
    "1+1=2=2",
    "x^2+1=0",
  ]) assert.equal(canSolveLatexEquationLocally(latex),false,latex);
});


test("advanced math candidates fall back to cloud without advertising random prose",()=>{
  assert.equal(analyzeLatexSolveCandidate("1+1=")?.mode,"local");
  for(const latex of [
    "x^3=8",
    String.raw`\sin(x)=0`,
    String.raw`\int_0^1 x^2\,dx=`,
    String.raw`\frac{d}{dx}x^3=`,
    String.raw`(a+b)^2=a^2+2ab+b^2`,
    "a+b=c",
    "y=x^2",
  ]) assert.equal(analyzeLatexSolveCandidate(latex)?.mode,"cloud",latex);
  for(const latex of ["hello=world","x=2","plain text","abc=def"]) assert.equal(analyzeLatexSolveCandidate(latex),null,latex);
});

test("safe relation evaluator supports graphable explicit and implicit equations",()=>{
  assert.equal(evaluateLatexRelationAt("y=x^2",{x:2,y:4}),0);
  assert.equal(evaluateLatexRelationAt("x^2+y^2=1",{x:1,y:0}),0);
  assert.equal(evaluateLatexRelationAt(String.raw`y=\sin(x)`,{x:0,y:0}),0);
  assert.equal(evaluateLatexRelationAt("y=unknown(x)",{x:0,y:0}),null);
});
