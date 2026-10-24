import assert from "node:assert/strict";
import test from "node:test";
import { askSafely } from "../src/features/editor/safe-ask.ts";
const answer = { blocks: [{type:"paragraph",text:"Model answer"}], engine: "Backup model" };

test("a hung transport times out; a late reply cannot become a second answer", async()=>{
  let finish!: (value: typeof answer)=>void;
  const controller=new AbortController();
  const result=askSafely(()=>new Promise(resolve=>{finish=resolve;}),controller.signal,5);
  await assert.rejects(result,/timed out/);
  await assert.rejects(askSafely(async()=>answer,new AbortController().signal),/previous AI request/);
  finish(answer); await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal((await askSafely(async()=>answer,new AbortController().signal)).engine,"Backup model");
});
test("cancel releases the UI immediately while the native job is safely drained",async()=>{
  let finish!: (value: typeof answer)=>void;
  const controller=new AbortController();
  const result=askSafely(()=>new Promise(resolve=>{finish=resolve;}),controller.signal);
  await Promise.resolve(); controller.abort();
  await assert.rejects(result,{name:"AbortError"});
  finish(answer); await new Promise(resolve=>setTimeout(resolve,0));
});
test("invalid model content is rejected and later requests still work",async()=>{
  await assert.rejects(askSafely(async()=>({blocks:[],engine:"bad"}),new AbortController().signal),/invalid/);
  assert.deepEqual(await askSafely(async()=>answer,new AbortController().signal),answer);
});
