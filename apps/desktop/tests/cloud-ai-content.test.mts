import assert from "node:assert/strict";
import test from "node:test";
import { cloudBlocksToTiptap, parseAskDirective, parseCloudInlineMath } from "../src/features/editor/cloud-ai-content.ts";

test("parses a complete /ask directive",()=>{
  assert.equal(parseAskDirective("/ask add Gauss's law"),"add Gauss's law");
  assert.equal(parseAskDirective("ordinary note"),null);
  assert.equal(parseAskDirective("/ask   "),null);
});

test("converts Gemini math to an editable LaTeX node",()=>{
  const content=cloudBlocksToTiptap([{type:"math",latex:"\\nabla \\cdot \\mathbf{E}=\\rho/\\varepsilon_0"}]);
  assert.equal(content[0].content?.[0].type,"mathExpression");
  assert.equal(content[0].content?.[0].attrs?.latex,"\\nabla \\cdot \\mathbf{E}=\\rho/\\varepsilon_0");
});

test("strips accidental delimiters from dedicated math blocks",()=>{
  const content=cloudBlocksToTiptap([{type:"math",latex:String.raw`\(\int_0^1 x^2\,dx\)`}]);
  assert.equal(content[0].content?.[0].attrs?.latex,String.raw`\int_0^1 x^2\,dx`);
  assert.equal(content[0].content?.[0].attrs?.display,true);
});

test("converts a structured table to Tiptap table nodes",()=>{
  const content=cloudBlocksToTiptap([{type:"table",headers:["Law","Formula"],rows:[["Gauss","Flux"]]}]);
  assert.equal(content[0].type,"table");
  assert.equal(content[0].content?.[0].content?.[0].type,"tableHeader");
  assert.equal(content[0].content?.[1].content?.[0].type,"tableCell");
});

test("renders Gemini inline \\(LaTeX\\) inside ordered-list questions",()=>{
  const content=cloudBlocksToTiptap([{type:"orderedList",items:[
    String.raw`Evaluate the definite integral: \(\int_{0}^{3} (2x+1)\,dx\)`,
    String.raw`Evaluate: \(\int_{1}^{2} \frac{1}{x}\,dx\)`,
  ]}]);
  const firstParagraph=content[0].content?.[0].content?.[0];
  assert.equal(firstParagraph?.type,"paragraph");
  assert.deepEqual(firstParagraph?.content?.map(node=>node.type),["text","mathExpression"]);
  assert.equal(firstParagraph?.content?.[1].attrs?.latex,String.raw`\int_{0}^{3} (2x+1)\,dx`);
  assert.equal(firstParagraph?.content?.[1].attrs?.display,false);
});

test("normalizes all common inline math delimiter styles",()=>{
  const pieces=parseCloudInlineMath(String.raw`A \(x^2\), B $y=2x$, C \[\int_0^1 x\,dx\], D $$z=3$$.`);
  assert.deepEqual(pieces.filter(piece=>piece.kind==="math").map(piece=>piece.kind==="math"?piece.latex:""),[
    "x^2","y=2x",String.raw`\int_0^1 x\,dx`,"z=3",
  ]);
});

test("uses structured text/math segments when Gemini provides them",()=>{
  const content=cloudBlocksToTiptap([{type:"orderedList",items:[{
    segments:[
      {type:"text",text:"Evaluate "},
      {type:"math",latex:String.raw`\int_0^2 3x^2\,dx`},
      {type:"text",text:" exactly."},
    ],
  }]}]);
  const nodes=content[0].content?.[0].content?.[0].content??[];
  assert.deepEqual(nodes.map(node=>node.type),["text","mathExpression","text"]);
  assert.equal(nodes[1].attrs?.latex,String.raw`\int_0^2 3x^2\,dx`);
});

test("supports inline math inside table cells",()=>{
  const content=cloudBlocksToTiptap([{type:"table",headers:["Problem"],rows:[[
    String.raw`Find \(x\) if \(2x+1=5\)`,
  ]]}]);
  const cellParagraph=content[0].content?.[1].content?.[0].content?.[0];
  assert.deepEqual(cellParagraph?.content?.map(node=>node.type),["text","mathExpression","text","mathExpression"]);
});

test("does not mistake ordinary currency text for inline math",()=>{
  const content=cloudBlocksToTiptap([{type:"paragraph",text:"It costs $5 and the other one costs $10."}]);
  assert.deepEqual(content[0].content?.map(node=>node.type),["text"]);
  assert.equal(content[0].content?.[0].text,"It costs $5 and the other one costs $10.");
});

test("repairs JSON-escaped control characters before creating a math node",()=>{
  const corrupted=String.raw`\left(\frac{1}{x}`+"\r"+"ight) + "+"\t"+"ext{ok}";
  const content=cloudBlocksToTiptap([{type:"math",latex:corrupted}]);
  assert.equal(content[0].content?.[0].attrs?.latex,String.raw`\left(\frac{1}{x}\right) + \text{ok}`);
});
