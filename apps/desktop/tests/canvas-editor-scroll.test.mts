import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Schema } from "@tiptap/pm/model";
import { EditorState, NodeSelection } from "@tiptap/pm/state";
import { keepAskAnswerAtStart, revealLocalEditorSelection, selectionRevealDelta, viewportToRevealSelection } from "../src/features/editor/canvas-editor-scroll.ts";
import { paddedSurfaceBounds, paperPresentation, viewportWorldBounds } from "../src/features/editor/viewport-surfaces.ts";

const port={left:200,top:150,right:920,bottom:630};
const view={x:88,y:72,zoom:1};

test("typing inside the window does not move or replace the viewport",()=>{
  assert.strictEqual(viewportToRevealSelection(view,port,{left:300,right:300,top:260,bottom:284}),view);
  assert.deepEqual(selectionRevealDelta({left:224,right:224,top:582,bottom:606},port),{x:0,y:0});
});

test("vertical caret following moves paper and the complete scene together across zooms",()=>{
  for(const zoom of [.35,.5,1,1.75,2.5]){
    const current={...view,zoom};
    const caret={left:480,right:480,top:780,bottom:804};
    const next=viewportToRevealSelection(current,port,caret);
    assert.equal(next.y-current.y,-198);
    assert.equal(next.x,current.x);
    assert.equal(next.zoom,zoom);
    assert.equal(caret.bottom+next.y-current.y,port.bottom-24);
    // Every independent world object receives exactly the same screen delta.
    for(const point of [{x:15,y:30},{x:350,y:900},{x:-800,y:17000}]){
      assert.equal(point.y*zoom+next.y-(point.y*zoom+current.y),-198);
    }
    const paper=paperPresentation("grid",26,next),period=26*zoom;
    assert.ok(Math.abs(paper.y-((next.y%period+period)%period))<1e-8);
    const bounds=paddedSurfaceBounds(next,{width:720,height:480});
    const visible=viewportWorldBounds(next,{width:720,height:480});
    assert.ok(bounds.top<=visible.top&&bounds.bottom>=visible.bottom);
  }
});

test("horizontal and diagonal overflow use canvas translation with stable zoom",()=>{
  const next=viewportToRevealSelection(view,port,{left:1100,right:1100,top:710,bottom:734});
  assert.deepEqual(next,{x:-116,y:-56,zoom:1});
  assert.deepEqual(selectionRevealDelta({left:120,right:120,top:80,bottom:104},port),{x:104,y:94});
});

test("oversized visible graph/PDF atoms do not make the viewport bounce",()=>{
  assert.strictEqual(viewportToRevealSelection(view,port,{left:220,right:1600,top:180,bottom:5000}),view);
  const next=viewportToRevealSelection(view,port,{left:1600,right:2980,top:180,bottom:5000});
  assert.equal(next.x-view.x,224-1600);
  assert.equal(next.y,view.y);
});

test("invalid or collapsed viewports cannot introduce non-finite movement",()=>{
  assert.deepEqual(selectionRevealDelta({left:NaN,right:NaN,top:10,bottom:20},{left:0,right:0,top:0,bottom:0}),{x:0,y:0});
});

test("local code scrolling respects zoom and never changes canvas/layout scroll offsets",()=>{
  for(const zoom of [.35,1,2.5]){
    let localLeft=0;
    const ancestor:any={scrollTop:0,scrollLeft:0};
    Object.defineProperty(ancestor,"scrollTop",{set(){throw new Error("native canvas scroll is forbidden");}});
    Object.defineProperty(ancestor,"scrollLeft",{set(){throw new Error("native canvas scroll is forbidden");}});
    const dom:any={contains:(node:any)=>node===pre||node===dom,parentElement:ancestor};
    const pre:any={nodeType:1,parentElement:dom,offsetWidth:300,offsetHeight:60,clientWidth:300,clientHeight:60,
      clientLeft:0,clientTop:0,scrollWidth:1200,scrollHeight:60,scrollTop:0,
      matches:()=>true,getBoundingClientRect:()=>({left:250,top:220,width:300*zoom,height:60*zoom})};
    Object.defineProperty(pre,"scrollLeft",{get:()=>localLeft,set:(v:number)=>{localLeft=Math.max(0,Math.min(900,v));}});
    dom.ownerDocument={defaultView:{getComputedStyle:()=>({overflowX:"auto",overflowY:"hidden"})}};
    dom.matches=()=>false;
    const editor:any={dom,state:{selection:{head:10}},domAtPos:()=>({node:pre,offset:0}),
      coordsAtPos:()=>({left:250+(800-localLeft)*zoom,right:250+(800-localLeft)*zoom,top:225,bottom:240})};
    const caret=revealLocalEditorSelection(editor);
    assert.ok(localLeft>0);
    assert.ok(caret.right<=250+300*zoom-8+1e-8);
    assert.equal(pre.scrollTop,0);
  }
});

const schema=new Schema({nodes:{
  doc:{content:"block+"},text:{group:"inline"},paragraph:{group:"block",content:"inline*"},
  heading:{group:"block",content:"inline*"},bulletList:{group:"block",content:"listItem+"},
  listItem:{content:"paragraph block*"},table:{group:"block",content:"tableRow+"},
  tableRow:{content:"tableCell+"},tableCell:{content:"block+"},mathGraph:{group:"block",atom:true},
}});
const paragraph=(text:string)=>schema.nodes.paragraph.create(null,schema.text(text));

test("long Ask replacement retains all content and leaves the caret at the answer's beginning",()=>{
  const before=paragraph("Keep this"),command=paragraph("/ask explain"),after=paragraph("Keep that");
  const state=EditorState.create({schema,doc:schema.nodes.doc.create(null,[before,command,after])});
  const answer=Array.from({length:80},(_,i)=>paragraph(`Answer paragraph ${i}`));
  const tr=state.tr.replaceWith(before.nodeSize,before.nodeSize+command.nodeSize,answer);
  const expected=tr.doc.toJSON();
  keepAskAnswerAtStart(tr,before.nodeSize);
  assert.equal(tr.selection.head,before.nodeSize+1);
  assert.equal(tr.selection.$head.parent.textContent,"Answer paragraph 0");
  assert.deepEqual(tr.doc.toJSON(),expected);
  assert.equal(tr.scrolledIntoView,false);
  assert.equal(tr.doc.childCount,82);
});

test("Ask starts at headings, nested lists/tables, and the first graph atom",()=>{
  const command=paragraph("/ask something");
  const cases=[schema.nodes.heading.create(null,schema.text("Heading")),
    schema.nodes.bulletList.create(null,[schema.nodes.listItem.create(null,[paragraph("First bullet")])]),
    schema.nodes.table.create(null,[schema.nodes.tableRow.create(null,[schema.nodes.tableCell.create(null,[paragraph("First cell")])])]),
    schema.nodes.mathGraph.create()];
  for(const answer of cases){
    const state=EditorState.create({schema,doc:schema.nodes.doc.create(null,[command,paragraph("Unrelated tail")])});
    const tr=state.tr.replaceWith(0,command.nodeSize,[answer]);
    keepAskAnswerAtStart(tr,0);
    assert.ok(tr.selection.head<=answer.nodeSize,"selection must stay inside the generated answer");
    if(answer.type.name==="mathGraph"){
      assert.ok(tr.selection instanceof NodeSelection);
      assert.equal(tr.selection.from,0);
    }else assert.match(tr.selection.$head.parent.textContent,/Heading|First bullet|First cell/);
    assert.equal(tr.scrolledIntoView,false);
  }
});

test("all note editors route scrolling to the canvas and native layout scroll is blocked only on screen",()=>{
  const source=readFileSync(new URL("../src/features/editor/page-editor.tsx",import.meta.url),"utf8");
  const css=readFileSync(new URL("../src/styles.css",import.meta.url),"utf8");
  assert.match(source,/handleScrollToSelection: view=>\{onRevealSelection\(view\);return true;\}/);
  assert.match(source,/onRevealSelection=\{actions.revealSelection\}/);
  assert.match(source,/revealSelection:revealEditorSelection/);
  assert.match(source,/flushViewportDom\(\);\s*const rect=revealLocalEditorSelection\(view\)/);
  assert.match(source,/previewViewport\(next\);\s*flushViewportDom\(\);\s*scheduleViewportCommit\(\)/);
  assert.match(source,/focus\(null,\{scrollIntoView:false\}\)\.insertContentAt\(range,content,\{updateSelection:false\}\)/);
  assert.match(css,/@media screen \{\s*html, body, #root, .app-shell, .app-shell > main,\s*.editor-shell, .editor-stage, .editor-shell .note-canvas \{\s*overflow: clip !important;/);
  assert.match(css,/\.tiptap pre \{\s*overflow-x: auto;/);
  assert.match(css,/\.tiptap \.tableWrapper \{[\s\S]*?overflow-x: auto;/);
  assert.match(css,/@media print \{[\s\S]*?\.note-canvas \{ overflow: visible !important;/);
});
