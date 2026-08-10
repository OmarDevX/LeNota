import assert from "node:assert/strict";
import test from "node:test";
import { buildPageAiContext, prunePageAiMemory, renderPageContentForAi } from "../src/features/editor/page-ai-context.ts";

test("includes page text, equations, tables, and canvas reading order",()=>{
  const context=buildPageAiContext("Electromagnetism",[
    {id:"second",x:20,y:500,content:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Later note"}]}]}},
    {id:"first",x:10,y:20,content:{type:"doc",content:[
      {type:"heading",attrs:{level:2},content:[{type:"text",text:"Gauss's law"}]},
      {type:"paragraph",content:[{type:"mathExpression",attrs:{latex:"\\oint_S \\mathbf{E}\\cdot d\\mathbf{A}=q/\\varepsilon_0"}}]},
      {type:"table",content:[{type:"tableRow",content:[
        {type:"tableHeader",content:[{type:"paragraph",content:[{type:"text",text:"Symbol"}]}]},
        {type:"tableHeader",content:[{type:"paragraph",content:[{type:"text",text:"Meaning"}]}]},
      ]}]},
    ]}},
  ],[{prompt:"What does this equation mean?",answer:"Gauss's law",createdAt:1,containerId:"first"}]);
  assert.match(context,/Current page: Electromagnetism/);
  assert.ok(context.indexOf("Gauss's law")<context.indexOf("Later note"));
  assert.match(context,/Equation LaTeX: \\oint_S/);
  assert.match(context,/\| Symbol \| Meaning \|/);
  assert.match(context,/User asked: What does this equation mean\?/);
  assert.match(context,/Assistant answered: Gauss's law/);
});

test("renders an inserted answer for persistent conversation memory",()=>{
  assert.equal(renderPageContentForAi([
    {type:"paragraph",content:[{type:"text",text:"The result is"}]},
    {type:"paragraph",content:[{type:"mathExpression",attrs:{latex:"E=mc^2"}}]},
  ]),"The result is\n[Equation LaTeX: E=mc^2]");
});

test("marks safely truncated page memory",()=>{
  const context=buildPageAiContext("Large",[{id:"one",x:0,y:0,content:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"x".repeat(500)}]}]}}],[],120);
  assert.equal(context.length,120);
  assert.match(context,/Page context truncated/);
});

test("forgets memory when its answer container or answer is deleted",()=>{
  const containers=[{id:"answer",x:0,y:0,content:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"The saved AI answer"}]}]}}];
  const memory=[{prompt:"Question",answer:"The saved AI answer",createdAt:1,containerId:"answer"}];
  assert.equal(prunePageAiMemory(containers,memory).length,1);
  assert.equal(prunePageAiMemory([],memory).length,0);
  assert.equal(prunePageAiMemory([{...containers[0],content:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"User replaced it"}]}]}}],memory).length,0);
});

test("links valid legacy memory and drops unmatched legacy memory",()=>{
  const containers=[{id:"answer",x:0,y:0,content:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Still on page"}]}]}}];
  assert.deepEqual(prunePageAiMemory(containers,[{prompt:"Q",answer:"Still on page",createdAt:1}])[0]?.containerId,"answer");
  assert.equal(prunePageAiMemory(containers,[{prompt:"Old",answer:"Deleted answer",createdAt:2}]).length,0);
});

test("includes locally rendered math graph relations in page memory",()=>{
  const content={type:"doc",content:[{type:"mathGraph",attrs:{relationLatex:"x^2+y^2=1",xMin:-2,xMax:2,yMin:-2,yMax:2,title:"Unit circle"}}]};
  const context=buildPageAiContext("Graphs",[{id:"g1",x:0,y:0,content}],[]);
  assert.match(context,/Graph relation LaTeX: x\^2\+y\^2=1/);
  assert.match(context,/x -2 to 2; y -2 to 2/);
});
