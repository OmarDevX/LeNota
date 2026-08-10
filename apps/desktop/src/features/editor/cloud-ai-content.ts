import type { JSONContent } from "@tiptap/core";
import { repairGeneratedLatexSource } from "./latex-repair.ts";

type CloudBlock={
  type?:unknown;
  text?:unknown;
  segments?:unknown;
  level?:unknown;
  latex?:unknown;
  language?:unknown;
  items?:unknown;
  headers?:unknown;
  rows?:unknown;
};

type CloudInlineSegment={
  type?:unknown;
  text?:unknown;
  latex?:unknown;
};

type InlinePiece=
  | {kind:"text";text:string}
  | {kind:"math";latex:string;display:boolean};

const boundedText=(value:unknown,limit=32_000)=>String(value??"").replace(/\u0000/g,"").slice(0,limit);
const textNode=(text:string):JSONContent=>({type:"text",text});
const mathNode=(latex:string,display=false):JSONContent=>({
  type:"mathExpression",
  attrs:{latex:repairGeneratedLatexSource(latex).latex,display,fontSize:24,autoFit:false},
});

function isEscapedAt(source:string,index:number):boolean {
  let slashes=0;
  for(let cursor=index-1;cursor>=0&&source[cursor]==="\\";cursor-=1)slashes+=1;
  return slashes%2===1;
}

function stripOuterMathDelimiters(value:unknown):string {
  let latex=boundedText(value).trim();
  for(let pass=0;pass<2;pass+=1){
    if(latex.startsWith("$$")&&latex.endsWith("$$")&&latex.length>4)latex=latex.slice(2,-2).trim();
    else if(latex.startsWith("$")&&latex.endsWith("$")&&latex.length>2)latex=latex.slice(1,-1).trim();
    else if(latex.startsWith("\\[")&&latex.endsWith("\\]")&&latex.length>4)latex=latex.slice(2,-2).trim();
    else if(latex.startsWith("\\(")&&latex.endsWith("\\)")&&latex.length>4)latex=latex.slice(2,-2).trim();
    else break;
  }
  return latex;
}

function plausibleDollarMath(value:string):boolean {
  const latex=value.trim();
  if(!latex||latex.length>12_000||/\r|\n/.test(latex))return false;
  if(/\\[A-Za-z]+/.test(latex))return true;
  if(/[=+\-*/^_{}<>≤≥≠≈∫∑∏√∞πθαβγδλμσω]/.test(latex))return true;
  if(/^[A-Za-z](?:_[A-Za-z0-9]+|\^[A-Za-z0-9]+)?$/.test(latex))return true;
  if(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(latex))return true;
  return false;
}

function findDollarClose(source:string,from:number,double:boolean):number {
  const token=double?"$$":"$";
  for(let index=from;index<source.length;index+=1){
    if(!source.startsWith(token,index)||isEscapedAt(source,index))continue;
    if(!double&&(source[index-1]==="$"||source[index+1]==="$"))continue;
    return index;
  }
  return -1;
}

/**
 * Gemini can legally return mixed prose/math in several common Markdown/TeX
 * forms even when asked for structured JSON. Normalize all of those forms at
 * the app boundary so presentation never depends on which delimiter Gemini
 * happened to choose for a particular answer.
 */
export function parseCloudInlineMath(value:unknown):InlinePiece[] {
  const source=boundedText(value);
  const pieces:InlinePiece[]=[];
  let textStart=0,index=0;
  const pushText=(end:number)=>{
    if(end>textStart)pieces.push({kind:"text",text:source.slice(textStart,end)});
  };

  while(index<source.length){
    let open="",close="",display=false,closing=-1;
    if(source.startsWith("\\(",index)&&!isEscapedAt(source,index)){
      open="\\(";close="\\)";display=false;closing=source.indexOf(close,index+open.length);
    }else if(source.startsWith("\\[",index)&&!isEscapedAt(source,index)){
      open="\\[";close="\\]";display=true;closing=source.indexOf(close,index+open.length);
    }else if(source.startsWith("$$",index)&&!isEscapedAt(source,index)){
      open="$$";close="$$";display=true;closing=findDollarClose(source,index+2,true);
    }else if(source[index]==="$"&&!isEscapedAt(source,index)&&source[index-1]!=="$"&&source[index+1]!=="$"){
      open="$";close="$";display=false;closing=findDollarClose(source,index+1,false);
    }

    if(!open||closing<0){index+=1;continue;}
    const candidate=source.slice(index+open.length,closing).trim();
    if(!candidate||(open==="$"&&!plausibleDollarMath(candidate))){index+=open.length;continue;}
    pushText(index);
    pieces.push({kind:"math",latex:candidate,display});
    index=closing+close.length;
    textStart=index;
  }
  pushText(source.length);
  return pieces.length?pieces:[{kind:"text",text:source}];
}

function mergeAdjacentText(nodes:JSONContent[]):JSONContent[] {
  const result:JSONContent[]=[];
  for(const node of nodes){
    const previous=result[result.length-1];
    if(node.type==="text"&&previous?.type==="text"){
      previous.text=String(previous.text??"")+String(node.text??"");
    }else result.push(node);
  }
  return result.filter(node=>node.type!=="text"||Boolean(String(node.text??"")));
}

function inlineFromDelimitedText(value:unknown,allowDisplay:boolean):JSONContent[] {
  const pieces=parseCloudInlineMath(value);
  const meaningful=pieces.filter(piece=>piece.kind==="math"||(piece.kind==="text"&&piece.text.trim()));
  const onlyDisplayMath=meaningful.length===1&&meaningful[0]?.kind==="math"&&meaningful[0].display;
  return mergeAdjacentText(pieces.flatMap(piece=>{
    if(piece.kind==="text")return piece.text?[textNode(piece.text)]:[];
    const latex=stripOuterMathDelimiters(piece.latex);
    return latex?[mathNode(latex,Boolean(allowDisplay&&onlyDisplayMath))]:[];
  }));
}

function inlineFromSegments(rawSegments:unknown,allowDisplay:boolean):JSONContent[]|null {
  if(!Array.isArray(rawSegments))return null;
  const nodes:JSONContent[]=[];
  for(const raw of rawSegments.slice(0,200)){
    if(!raw||typeof raw!=="object")continue;
    const segment=raw as CloudInlineSegment;
    const type=String(segment.type??"");
    if(type==="text")nodes.push(...inlineFromDelimitedText(segment.text,false));
    else if(type==="math"){
      const latex=stripOuterMathDelimiters(segment.latex);
      if(latex)nodes.push(mathNode(latex,false));
    }
  }
  const merged=mergeAdjacentText(nodes);
  if(!merged.length)return [];
  if(allowDisplay&&merged.length===1&&merged[0].type==="mathExpression"){
    merged[0]={...merged[0],attrs:{...(merged[0].attrs??{}),display:true}};
  }
  return merged;
}

function richInline(value:unknown,rawSegments:unknown,allowDisplay=false):JSONContent[] {
  const structured=inlineFromSegments(rawSegments,allowDisplay);
  return structured!==null?structured:inlineFromDelimitedText(value,allowDisplay);
}

function richValue(value:unknown,allowDisplay=false):JSONContent[] {
  if(value&&typeof value==="object"&&!Array.isArray(value)){
    const item=value as {text?:unknown;segments?:unknown};
    return richInline(item.text,item.segments,allowDisplay);
  }
  return inlineFromDelimitedText(value,allowDisplay);
}

const paragraph=(value:unknown,segments?:unknown):JSONContent=>{
  const content=richInline(value,segments,true);
  return {type:"paragraph",content:content.length?content:undefined};
};
const richParagraph=(value:unknown):JSONContent=>{
  const content=richValue(value,true);
  return {type:"paragraph",content:content.length?content:undefined};
};

export function parseAskDirective(text:string):string|null {
  const match=text.match(/^\s*\/ask(?:\s+)([\s\S]*\S)\s*$/i);
  return match?.[1]?.trim()||null;
}

export function cloudBlocksToTiptap(rawBlocks:unknown):JSONContent[] {
  if(!Array.isArray(rawBlocks))throw new Error("Gemini returned invalid note blocks.");
  const result:JSONContent[]=[];
  for(const raw of rawBlocks.slice(0,100)){
    if(!raw||typeof raw!=="object")continue;
    const block=raw as CloudBlock;
    const type=String(block.type??"");
    if(type==="paragraph"){
      result.push(paragraph(block.text,block.segments));
    }else if(type==="heading"){
      const level=Math.max(1,Math.min(3,Math.round(Number(block.level)||2))) as 1|2|3;
      const content=richInline(block.text,block.segments,false);
      if(content.length)result.push({type:"heading",attrs:{level},content});
    }else if(type==="math"){
      const latex=stripOuterMathDelimiters(block.latex);
      if(latex)result.push({type:"paragraph",content:[mathNode(latex,true)]});
    }else if(type==="bulletList"||type==="orderedList"){
      const items=Array.isArray(block.items)?block.items.slice(0,100):[];
      const content=items.map(item=>richParagraph(item)).filter(item=>Boolean(item.content?.length));
      if(content.length)result.push({type:type==="bulletList"?"bulletList":"orderedList",content:content.map(item=>({type:"listItem",content:[item]}))});
    }else if(type==="table"){
      const headers=Array.isArray(block.headers)?block.headers.slice(0,12):[];
      const rows=Array.isArray(block.rows)?block.rows.slice(0,50).map(row=>Array.isArray(row)?row.slice(0,12):[]):[];
      const width=Math.max(headers.length,...rows.map(row=>row.length),0);
      if(width>0){
        const tableRows:JSONContent[]=[];
        if(headers.length)tableRows.push({type:"tableRow",content:Array.from({length:width},(_,index)=>({type:"tableHeader",content:[richParagraph(headers[index]??"")]}))});
        for(const row of rows)tableRows.push({type:"tableRow",content:Array.from({length:width},(_,index)=>({type:"tableCell",content:[richParagraph(row[index]??"")]}))});
        if(tableRows.length)result.push({type:"table",content:tableRows});
      }
    }else if(type==="code"){
      const text=boundedText(block.text,100_000);
      if(text)result.push({type:"codeBlock",attrs:{language:boundedText(block.language,80)||null},content:[{type:"text",text}]});
    }
  }
  if(!result.length)throw new Error("Gemini returned no usable note content.");
  return result;
}
