import type { JSONContent } from "@tiptap/core";
import type { Attachment } from "@/types/domain";
import { repairGeneratedLatexSource } from "./latex-repair.ts";
import { normalizeMathGraphSpec } from "./math-graph.ts";
import { compileLatexRelation } from "./equation-solver.ts";

// Keep in sync with cloud_ai_worker.py. Larger collections use multiple tables.
export const ASK_TABLE_MAX_ROWS=200;
export const ASK_TABLE_MAX_COLUMNS=12;

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
  relation_latex?:unknown;
  x_min?:unknown;
  x_max?:unknown;
  y_min?:unknown;
  y_max?:unknown;
  title?:unknown;
  attachment?:unknown;
  alt?:unknown;
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

/**
 * Natural-language image requests use the free SVG /image pipeline.
 * Do not route ordinary descriptions or math graphs to the SVG generator.
 * The user never needs to type /image; it remains an unambiguous override.
 */
export function routeAskImageRequest(request:string):string {
  const prompt=request.trim();
  if(!prompt||/^\/image(?:\s|$)/i.test(prompt))return prompt;
  // Animated SVG requests must stay in the structured /ask route. The /image
  // path can animate, but explicit SVG requests already use /ask.
  if(/\b(?:svg|animated|animate|animation|looping)\b/i.test(prompt))return prompt;
  // Requests can include a polite preface, but must still have a clear visual
  // action: references to images in ordinary questions aren't sufficient.
  const phrase=prompt.replace(/^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|(?:i'd|i would)\s+like\s+you\s+to\s+|i want you to\s+)/i,"").trim();
  const visualNoun=/(?:(?:an?|the|some|my)\s+)?(?:(?:high[- ]quality|clean|detailed|realistic|labeled|labelled|simple|medical|anatomical|colorful|scientific|3d|high-resolution|photorealistic)\s+)*(?:image|picture|illustration|drawing|diagram|infographic|photograph|photo|portrait|artwork|visualization)\b/i;
  // "make an image of ...", "generate a diagram ...", "render a picture..."
  const creation=phrase.match(/^(?:make|create|generate|produce|render|design|draw|paint|sketch|illustrate)\s+(.*)$/i);
  if(creation&&visualNoun.test(creation[1]))return `/image ${prompt}`;
  // "draw the heart" and "paint a mountain" are image requests too, but
  // "draw a graph/plot/chart" should keep the editable math-graph renderer.
  if(/^(?:draw|paint)\s+(?:(?:me|us)\s+)?(?!((?:(?:an?|the)\s+)?(?:graph|plot|chart|table|conclusion|comparison)\b))/i.test(phrase)){
    return `/image ${prompt}`;
  }
  // "turn this selection into a diagram", "redraw this as an illustration"
  if(/^(?:turn|convert|transform|recreate|redraw)\s+.+?\b(?:into|as)\s+/i.test(phrase)&&visualNoun.test(phrase)){
    return `/image ${prompt}`;
  }
  // "show me an image of ..." requests a real visual, not a description.
  if(/^(?:show|give)\s+(?:me|us)\s+/i.test(phrase)&&visualNoun.test(phrase)){
    return `/image ${prompt}`;
  }
  return prompt;
}

export function parseAskDirective(text:string):string|null {
  // /image creates a rendered SVG via a text model. /raster is a separate
  // explicit, paid opt-in which requires an image API key.
  const image=text.match(/^\s*\/image(?:\s+)([\s\S]*\S)\s*$/i);
  if(image)return "/image "+image[1].trim();
  const raster=text.match(/^\s*\/raster(?:\s+)([\s\S]*\S)\s*$/i);
  if(raster)return "/raster "+raster[1].trim();
  const match=text.match(/^\s*\/ask(?:\s+)([\s\S]*\S)\s*$/i);
  return match?.[1]?.trim()||null;
}

/** Some providers put a fenced SVG inside a paragraph instead of a code
 * block. Split that content into ordinary prose and a real (previewable) code
 * block without altering other Markdown/code formats. */
function paragraphWithSvgFences(value:unknown,segments:unknown):JSONContent[]|null {
  if(typeof value!=="string"||Array.isArray(segments)||!value.includes("```"))return null;
  const pattern=/(^|\r?\n)```(?:svg|svg\+xml)\s*\r?\n([\s\S]*?)\r?\n```(?=\s*(?:\r?\n|$))/gim;
  const nodes:JSONContent[]=[];
  let previous=0,match:RegExpExecArray|null;
  while((match=pattern.exec(value))!==null){
    const svg=match[2].trim();
    if(!/^<svg(?=[\s>])[\s\S]*<\/svg\s*>$/i.test(svg))continue;
    const before=value.slice(previous,match.index).trim();
    if(before)nodes.push(paragraph(before));
    nodes.push({type:"codeBlock",attrs:{language:"svg"},content:[textNode(svg)]});
    previous=pattern.lastIndex;
  }
  if(!nodes.length)return null;
  const after=value.slice(previous).trim();
  if(after)nodes.push(paragraph(after));
  return nodes;
}

export function cloudBlocksToTiptap(rawBlocks:unknown,imageNode?:(attachment:Attachment)=>JSONContent):JSONContent[] {
  if(!Array.isArray(rawBlocks))throw new Error("Gemini returned invalid note blocks.");
  const result:JSONContent[]=[];
  for(const raw of rawBlocks.slice(0,100)){
    if(!raw||typeof raw!=="object")continue;
    const block=raw as CloudBlock;
    const type=String(block.type??"");
    if(type==="paragraph"){
      result.push(...(paragraphWithSvgFences(block.text,block.segments)??[paragraph(block.text,block.segments)]));
    }else if(type==="heading"){
      const level=Math.max(1,Math.min(3,Math.round(Number(block.level)||2))) as 1|2|3;
      const content=richInline(block.text,block.segments,false);
      if(content.length)result.push({type:"heading",attrs:{level},content});
    }else if(type==="math"){
      const latex=stripOuterMathDelimiters(block.latex);
      if(latex)result.push({type:"paragraph",content:[mathNode(latex,true)]});
    }else if(type==="image"){
      // Never render provider-supplied URLs, data URIs or local paths. Only
      // backend-verified image attachments are accepted into persistent notes.
      const attachment=block.attachment as Partial<Attachment>|undefined;
      if(!imageNode||!attachment||typeof attachment.id!=="string"||!attachment.id||
         typeof attachment.storedPath!=="string"||!attachment.storedPath||attachment.mimeType!=="image/png"){
        throw new Error("AI returned an image without a managed PNG attachment.");
      }
      const node=imageNode(attachment as Attachment);
      if(node.type!=="image")throw new Error("AI returned an invalid image attachment.");
      result.push({...node,attrs:{...node.attrs,alt:boundedText(block.alt,500)||"ChatGPT-generated image"}});
    }else if(type==="graph"){
      const relationLatex=repairGeneratedLatexSource(stripOuterMathDelimiters(block.relation_latex)).latex;
      if(!compileLatexRelation(relationLatex))throw new Error("Gemini returned a graph relation that cannot be plotted locally.");
      const spec=normalizeMathGraphSpec({relationLatex,xMin:Number(block.x_min),xMax:Number(block.x_max),
        yMin:Number(block.y_min),yMax:Number(block.y_max),title:boundedText(block.title,180)});
      result.push({type:"mathGraph",attrs:{...spec,title:spec.title||"Graph"}});
    }else if(type==="bulletList"||type==="orderedList"){
      const items=Array.isArray(block.items)?block.items.slice(0,100):[];
      const content=items.map(item=>richParagraph(item)).filter(item=>Boolean(item.content?.length));
      if(content.length)result.push({type:type==="bulletList"?"bulletList":"orderedList",content:content.map(item=>({type:"listItem",content:[item]}))});
    }else if(type==="table"){
      const headers=block.headers??[];
      const rawRows=block.rows??[];
      if(!Array.isArray(headers)||!Array.isArray(rawRows)||rawRows.some(row=>!Array.isArray(row))){
        throw new Error("Gemini returned an invalid table structure.");
      }
      if(rawRows.length>ASK_TABLE_MAX_ROWS||headers.length>ASK_TABLE_MAX_COLUMNS||rawRows.some(row=>row.length>ASK_TABLE_MAX_COLUMNS)){
        throw new Error(`Gemini returned a table exceeding ${ASK_TABLE_MAX_ROWS} rows or ${ASK_TABLE_MAX_COLUMNS} columns. Split it into multiple tables.`);
      }
      // Never silently drop later vocabulary words or columns at this boundary.
      const rows=rawRows as unknown[][];
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
