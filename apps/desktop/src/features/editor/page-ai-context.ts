import type { JSONContent } from "@tiptap/core";

export interface PageContextContainer {
  id:string;
  x:number;
  y:number;
  content:JSONContent;
}

export interface PageAiMemoryEntry {
  prompt:string;
  answer:string;
  createdAt:number;
  containerId?:string;
}

const clean=(value:unknown,limit=32_000)=>String(value??"").replace(/\u0000/g,"").slice(0,limit);

function inlineText(node:JSONContent):string {
  if(node.type==="text")return clean(node.text);
  if(node.type==="hardBreak")return "\n";
  if(node.type==="mathExpression")return `[Equation LaTeX: ${clean(node.attrs?.latex)}]`;
  if(node.type==="mathGraph")return `[Graph relation LaTeX: ${clean(node.attrs?.relationLatex)}; x ${clean(node.attrs?.xMin,40)} to ${clean(node.attrs?.xMax,40)}; y ${clean(node.attrs?.yMin,40)} to ${clean(node.attrs?.yMax,40)}]`;
  if(node.type==="image")return `[Image${node.attrs?.alt?`: ${clean(node.attrs.alt,1000)}`:""}]`;
  if(node.type==="attachmentCard")return `[Attachment: ${clean(node.attrs?.fileName||node.attrs?.name||"file",1000)}]`;
  if(node.type==="audioCard")return `[Audio note${node.attrs?.fileName?`: ${clean(node.attrs.fileName,1000)}`:""}]`;
  return (node.content??[]).map(inlineText).join("");
}

function renderBlock(node:JSONContent):string {
  if(node.type==="doc")return (node.content??[]).map(renderBlock).filter(Boolean).join("\n");
  if(node.type==="heading")return `${"#".repeat(Math.max(1,Math.min(3,Number(node.attrs?.level)||2)))} ${inlineText(node)}`.trim();
  if(node.type==="paragraph")return inlineText(node).trim();
  if(node.type==="mathExpression"||node.type==="mathGraph")return inlineText(node);
  if(node.type==="codeBlock")return `\`\`\`${clean(node.attrs?.language,80)}\n${inlineText(node)}\n\`\`\``;
  if(node.type==="blockquote")return renderBlock({type:"doc",content:node.content}).split("\n").map(line=>`> ${line}`).join("\n");
  if(node.type==="bulletList"||node.type==="orderedList"){
    return (node.content??[]).map((item,index)=>{
      const body=(item.content??[]).map(renderBlock).filter(Boolean).join(" ");
      return `${node.type==="orderedList"?`${index+1}.`:"-"} ${body}`;
    }).join("\n");
  }
  if(node.type==="table"){
    return (node.content??[]).map(row=>`| ${(row.content??[]).map(cell=>inlineText(cell).trim()).join(" | ")} |`).join("\n");
  }
  if(node.type==="horizontalRule")return "---";
  const children=(node.content??[]).map(renderBlock).filter(Boolean).join("\n");
  return children||inlineText(node).trim();
}

export function renderPageContentForAi(nodes:JSONContent|JSONContent[]):string {
  const root=Array.isArray(nodes)?{type:"doc",content:nodes}:nodes;
  return renderBlock(root).trim();
}

const comparable=(value:string)=>value.replace(/\s+/g," ").trim();

/** Keep conversation history only while its generated answer still exists in
 * the page container that owns it. Legacy entries are linked by matching their
 * saved answer against current container content; unmatched history is stale
 * and is discarded. */
export function prunePageAiMemory(containers:PageContextContainer[],memory:PageAiMemoryEntry[]):PageAiMemoryEntry[] {
  const rendered=new Map(containers.map(container=>[container.id,comparable(renderBlock(container.content))]));
  return memory.slice(-50).flatMap(entry=>{
    const answer=comparable(clean(entry.answer,40_000));
    if(!answer)return [];
    if(entry.containerId){
      const body=rendered.get(entry.containerId);
      return body?.includes(answer)?[{...entry,containerId:entry.containerId}]:[];
    }
    const match=[...rendered].find(([,body])=>body.includes(answer));
    return match?[{...entry,containerId:match[0]}]:[];
  });
}

export function buildPageAiContext(title:string,containers:PageContextContainer[],memory:PageAiMemoryEntry[]=[],maxCharacters=120_000):string {
  const ordered=[...containers].sort((a,b)=>a.y-b.y||a.x-b.x||a.id.localeCompare(b.id));
  const sections=ordered.map((container,index)=>{
    const body=renderBlock(container.content).trim()||"[Empty note]";
    return `## Note ${index+1} at canvas position (${Math.round(container.x)}, ${Math.round(container.y)})\n${body}`;
  });
  const conversations=prunePageAiMemory(containers,memory).map((entry,index)=>
    `### Exchange ${index+1}\nUser asked: ${clean(entry.prompt,20_000)}\nAssistant answered: ${clean(entry.answer,40_000)}`
  );
  const memorySection=conversations.length?`\n\n# Earlier /ask exchanges on this page\n${conversations.join("\n\n")}`:"";
  const full=`# Current page: ${clean(title,4000)||"Untitled page"}\n${sections.join("\n\n")}${memorySection}`;
  if(full.length<=maxCharacters)return full;
  const suffix="\n\n[Page context truncated because it exceeded the safety limit.]";
  return full.slice(0,Math.max(0,maxCharacters-suffix.length))+suffix;
}
