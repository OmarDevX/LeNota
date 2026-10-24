/** Synthetic index benchmark. Not a substitute for real Tauri frame-time profiling. */
import { performance } from 'node:perf_hooks';
import { SpatialIndex, estimatedNoteBounds } from '../src/features/editor/spatial-visibility.ts';
const notes=Array.from({length:25000},(_,i)=>({id:i,x:(i%500)*520,y:Math.floor(i/500)*310,width:420,minHeight:120,plainText:'A short lecture note'}));
const ink=Array.from({length:50000},(_,i)=>({id:i,x:(i%500)*520+20,y:Math.floor(i/500)*170+15}));
const start=performance.now();
const noteIndex=new SpatialIndex(notes,item=>estimatedNoteBounds(item));
const inkIndex=new SpatialIndex(ink,item=>({left:item.x,top:item.y,right:item.x+140,bottom:item.y+60}));
const indexed=performance.now();
let visibleNoteCount=0,visibleInkCount=0;
for(let i=0;i<250;i++){
  const left=(i%50)*520,top=Math.floor(i/50)*310;
  visibleNoteCount=noteIndex.query({left,top,right:left+1440,bottom:top+900}).length;
  visibleInkCount=inkIndex.query({left,top,right:left+1440,bottom:top+900}).length;
}
const queried=performance.now();
console.log(JSON.stringify({totalNotes:notes.length,totalInkStrokes:ink.length,indexMs:+(indexed-start).toFixed(1),queries:500,queryTotalMs:+(queried-indexed).toFixed(1),lastViewport:{notes:visibleNoteCount,ink:visibleInkCount}},null,2));
