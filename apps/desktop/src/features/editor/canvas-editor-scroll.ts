import { NodeSelection, Selection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export interface ClientBounds { left:number; top:number; right:number; bottom:number }
export interface EditorViewport { x:number; y:number; zoom:number }

/** Client-space translation only: zoom and every object's world coordinates
 * remain unchanged. Oversized atoms already intersecting the window stay put. */
export function selectionRevealDelta(selection:ClientBounds, viewport:ClientBounds, margin=24) {
  const axis=(low:number,high:number,start:number,end:number)=>{
    if(![low,high,start,end].every(Number.isFinite)||end<=start||high<low)return 0;
    const padding=Math.min(Math.max(0,margin),(end-start)/4);
    const a=start+padding,b=end-padding;
    if(high-low>b-a){
      if(high<=a||low>=b)return a-low;
      return 0;
    }
    return low<a?a-low:high>b?b-high:0;
  };
  return {x:axis(selection.left,selection.right,viewport.left,viewport.right),
    y:axis(selection.top,selection.bottom,viewport.top,viewport.bottom)};
}

export function viewportToRevealSelection(current:EditorViewport, viewport:ClientBounds, selection:ClientBounds) {
  const delta=selectionRevealDelta(selection,viewport);
  return delta.x||delta.y?{...current,x:current.x+delta.x,y:current.y+delta.y}:current;
}

function selectionRect(view:EditorView):ClientBounds {
  if(view.state.selection instanceof NodeSelection){
    const node=view.nodeDOM(view.state.selection.from) as Element|null;
    if(node?.getBoundingClientRect)return node.getBoundingClientRect();
  }
  return view.coordsAtPos(view.state.selection.head,1);
}

/** Retain deliberate scrollbars inside code, tables, and math. Never walk
 * into canvas/layout ancestors as ProseMirror's default scroll handler does. */
export function revealLocalEditorSelection(view:EditorView):ClientBounds {
  const position=view.domAtPos(view.state.selection.head);
  let element=position.node.nodeType===1?position.node as HTMLElement:position.node.parentElement;
  const win=view.dom.ownerDocument.defaultView;
  let rect=selectionRect(view);
  while(element&&view.dom.contains(element)){
    if(element.matches("pre, .tableWrapper, .lenota-math-render")&&win){
      const style=win.getComputedStyle(element);
      const box=element.getBoundingClientRect();
      const sx=element.offsetWidth>0?box.width/element.offsetWidth:1;
      const sy=element.offsetHeight>0?box.height/element.offsetHeight:1;
      if(sx>0&&sy>0){
        const left=box.left+element.clientLeft*sx,top=box.top+element.clientTop*sy;
        const delta=selectionRevealDelta(rect,{left,top,right:left+element.clientWidth*sx,bottom:top+element.clientHeight*sy},8);
        let changed=false;
        if(/^(auto|scroll)$/.test(style.overflowX)&&element.scrollWidth>element.clientWidth&&delta.x){
          const before=element.scrollLeft;
          // Let the browser apply its LTR/RTL scroll range and clamping.
          element.scrollLeft-=delta.x/sx;
          changed ||= element.scrollLeft!==before;
        }
        if(/^(auto|scroll)$/.test(style.overflowY)&&element.scrollHeight>element.clientHeight&&delta.y){
          const before=element.scrollTop;
          element.scrollTop-=delta.y/sy;
          changed ||= element.scrollTop!==before;
        }
        if(changed)rect=selectionRect(view);
      }
    }
    if(element===view.dom)break;
    element=element.parentElement;
  }
  return rect;
}

/** A long generated answer replaces /ask, but starts reading at its beginning.
 * Selection.near handles headings, nested lists/tables, and graph-only replies. */
export function keepAskAnswerAtStart(tr:Transaction, from:number) {
  const start=Math.max(0,Math.min(from,tr.doc.content.size));
  const first=tr.doc.nodeAt(start);
  if(first?.isBlock&&first.isAtom&&NodeSelection.isSelectable(first)){
    tr.setSelection(NodeSelection.create(tr.doc,start));
    return true;
  }
  const position=Math.min(start+1,tr.doc.content.size);
  tr.setSelection(Selection.near(tr.doc.resolve(position),1));
  return true;
}
