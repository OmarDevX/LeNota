import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { captureCanvasSnapshot, createCanvasSerializer } from '../src/features/editor/canvas-persistence.ts';
import type { InkStroke } from '../src/features/editor/pen-input.ts';

const ink:InkStroke[]=Array.from({length:500},(_,stroke)=>({id:`stroke-${stroke}`,tool:'pen',color:'#d4d4d8',width:2.5,pressureEnabled:true,smoothing:.86,
  points:Array.from({length:150},(_,i)=>({x:stroke*3+i*.7,y:stroke*.4+Math.sin(i*.05)*20,pressure:.1+(i%17)/20}))}));
const page={type:'lenota-canvas',version:3,viewport:{x:88,y:72,zoom:1},containers:[{id:'note',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Benchmark note'}]}]}}],
  ink,shapes:[],background:{pattern:'grid',color:'#fff',spacing:24},aiMemory:[]};
const parts=captureCanvasSnapshot(page);
const encode=createCanvasSerializer();
assert.equal(encode(page),JSON.stringify(page));
function median(run:()=>unknown) {
  const times:number[]=[];
  for(let i=0;i<15;i++){const start=performance.now();run();times.push(performance.now()-start);}
  return times.sort((a,b)=>a-b)[Math.floor(times.length/2)];
}
const beforeHistory=median(()=>JSON.parse(JSON.stringify(parts)).ink.length);
const afterHistory=median(()=>captureCanvasSnapshot(page).ink.length);
let edit=0;
const beforeSave=median(()=>Buffer.byteLength(JSON.stringify({...page,viewport:{...page.viewport,x:++edit}})));
const afterSave=median(()=>Buffer.byteLength(encode({...page,viewport:{...page.viewport,x:++edit}})));
console.log(JSON.stringify({fixture:{strokes:500,points:75000,jsonBytes:Buffer.byteLength(JSON.stringify(page))},
  undoCaptureMedianMs:{before:beforeHistory,after:afterHistory},repeatedSerializationMedianMs:{before:beforeSave,after:afterSave},
  note:'Synthetic JavaScript workload; these are operation timings, not native app FPS.'},null,2));
