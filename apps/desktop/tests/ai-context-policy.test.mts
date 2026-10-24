import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScopedAiContext, parseAiContextOptions, DEFAULT_AI_CONTEXT_OPTIONS,
} from "../src/features/editor/ai-context-policy.ts";

const note=(id:string,text:string,y:number)=>({id,x:10,y,content:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text}]}]}});
const containers=[
  note("italian","Italian passato prossimo\n/ask explain this tense",0),
  note("biology","Private cardiology lecture about cardiac output",100),
  note("statistics","Statistics: standard deviation formula",200),
];
const memory=[
  {containerId:"italian",prompt:"Previous question",answer:"Italian passato prossimo",createdAt:1},
  {containerId:"biology",prompt:"Private question",answer:"Private cardiology lecture",createdAt:2},
];

test("safe defaults: this note only, no history, with review on",()=>{
  assert.deepEqual(parseAiContextOptions(null),DEFAULT_AI_CONTEXT_OPTIONS);
  assert.equal(DEFAULT_AI_CONTEXT_OPTIONS.scope,"note");
  assert.equal(DEFAULT_AI_CONTEXT_OPTIONS.reviewBeforeSend,true);
  assert.equal(DEFAULT_AI_CONTEXT_OPTIONS.includeHistory,false);
  const {context,containerCount}=buildScopedAiContext({title:"Mixed lectures",containers,memory,scope:"note",anchorId:"italian",question:"explain this tense"});
  assert.equal(containerCount,1);
  assert.match(context,/Italian passato prossimo/);
  assert.doesNotMatch(context,/Private cardiology|Statistics:|Previous question|\/ask explain this tense/);
});

test("chosen notes contain exactly the requested containers, even out of spatial order",()=>{
  const {context,containerCount}=buildScopedAiContext({title:"All notes",containers,memory,scope:"chosen",chosenIds:["statistics","italian"],anchorId:"italian"});
  assert.equal(containerCount,2);
  assert.ok(context.indexOf("Italian")<context.indexOf("Statistics"));
  assert.doesNotMatch(context,/Private cardiology|Private question/);
});

test("whole-page is explicitly opt-in and includes all notes",()=>{
  const {context,containerCount}=buildScopedAiContext({title:"All notes",containers,memory,scope:"page"});
  assert.equal(containerCount,3);
  assert.match(context,/Italian/);assert.match(context,/Private cardiology/);assert.match(context,/Statistics/);
  assert.doesNotMatch(context,/Previous question|Private question/);
});

test("history is opt-in and limited to the included note",()=>{
  const {context}=buildScopedAiContext({title:"Italian",containers,memory,scope:"note",anchorId:"italian",includeHistory:true});
  assert.match(context,/Previous question/);
  assert.doesNotMatch(context,/Private question|Private cardiology/);
});

test("no context sends an empty context string regardless of notes",()=>{
  assert.deepEqual(buildScopedAiContext({title:"All",containers,memory,scope:"none",includeHistory:true}),{context:"",containerCount:0,truncated:false});
});

test("large included context has the same safety limit and a visible truncation warning",()=>{
  const big=Array.from({length:8},(_,i)=>note(`a${i}`,`Part ${i}: `+"T".repeat(30_000),i*100));
  const result=buildScopedAiContext({title:"Long",containers:big,scope:"page"});
  assert.ok(result.context.length<=120_000);
  assert.equal(result.truncated,true);
  assert.match(result.context,/Page context truncated/);
});

test("malformed preference data defaults safely",()=>{
  assert.equal(parseAiContextOptions("not json").scope,"note");
  assert.equal(parseAiContextOptions(JSON.stringify({scope:"unexpected",includeHistory:"yes",reviewBeforeSend:"off"})).scope,"note");
  assert.equal(parseAiContextOptions(JSON.stringify({scope:"page",includeHistory:true,reviewBeforeSend:false})).scope,"page");
});
