import assert from "node:assert/strict";
import test from "node:test";
import { repairDuplicateLargeOperatorScripts, repairUnclosedLatexGroups } from "../src/features/editor/latex-repair.ts";

test("removes the extra nested subscript from the reported malformed sum",()=>{
  const input="\\sum_{i=1}^{n}_{1_{\\leftharpoonup}} x_i";
  assert.deepEqual(repairDuplicateLargeOperatorScripts(input),{
    latex:"\\sum_{i=1}^{n} x_i",
    repaired:true,
  });
});

test("turns two same-kind OCR limits into upper then lower",()=>{
  assert.deepEqual(repairDuplicateLargeOperatorScripts("\\int_{b}_{a} f(x)dx"),{
    latex:"\\int_{a}^{b} f(x)dx",
    repaired:true,
  });
});

test("preserves valid nested scripts and ordinary variable scripts",()=>{
  const valid="\\sum_{k_{0}=1}^{n+1} x_{k}^{2}";
  assert.deepEqual(repairDuplicateLargeOperatorScripts(valid),{latex:valid,repaired:false});
});

test("closes the unfinished denominator from the reported malformed OCR",()=>{
  assert.deepEqual(repairUnclosedLatexGroups("\\frac{0}{\\sum_{5}"),{
    latex:"\\frac{0}{\\sum_{5}}",
    repaired:true,
  });
});

test("does not guess when OCR contains an unmatched closing brace",()=>{
  const malformed="x_{1}}+y";
  assert.deepEqual(repairUnclosedLatexGroups(malformed),{latex:malformed,repaired:false});
});

test("ignores escaped literal braces while balancing groups",()=>{
  const input="\\text{set \\{x";
  assert.deepEqual(repairUnclosedLatexGroups(input),{latex:"\\text{set \\{x}",repaired:true});
});

import { repairGeneratedLatexSource, repairJsonEscapedLatexControls, repairUnmatchedLeftRight } from "../src/features/editor/latex-repair.ts";

test("restores LaTeX commands corrupted by JSON control escapes",()=>{
  const corrupted="\\int_0^1 "+"\f"+"rac{1}{x} "+"\r"+"ight) "+"\t"+"ext{ok}";
  assert.equal(repairJsonEscapedLatexControls(corrupted).latex,String.raw`\int_0^1 \frac{1}{x} \right) \text{ok}`);
});

test("repairs the reported missing right delimiter without discarding the expression",()=>{
  assert.deepEqual(repairUnmatchedLeftRight(String.raw`\left(\frac{1}{x}`),{
    latex:String.raw`\left(\frac{1}{x}\right.`,repaired:true,
  });
});

test("generated repair combines JSON-control and brace/delimiter repair",()=>{
  const corrupted=String.raw`\left( x+`+"\f"+"rac{1}{2";
  assert.equal(repairGeneratedLatexSource(corrupted).latex,String.raw`\left( x+\frac{1}{2}\right.`);
});
