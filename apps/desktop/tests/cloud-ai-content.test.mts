import assert from "node:assert/strict";
import test from "node:test";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { ASK_TABLE_MAX_COLUMNS, ASK_TABLE_MAX_ROWS, cloudBlocksToTiptap, parseAskDirective, parseCloudInlineMath, routeAskImageRequest } from "../src/features/editor/cloud-ai-content.ts";
import { buildMathGraphGeometry } from "../src/features/editor/math-graph.ts";

test("parses a complete /ask directive",()=>{
  assert.equal(parseAskDirective("/ask add Gauss's law"),"add Gauss's law");
  assert.equal(parseAskDirective("ordinary note"),null);
  assert.equal(parseAskDirective("/ask   "),null);
});

test("/image is an explicit, persistent image-generation directive",()=>{
  assert.equal(parseAskDirective("/image   a labeled anatomical illustration"),"/image a labeled anatomical illustration");
  assert.equal(parseAskDirective("/ask /image a cat"),"/image a cat");
  assert.equal(parseAskDirective("/image "),null);
});

test("paid /raster must be explicitly requested, never inferred",()=>{
  assert.equal(parseAskDirective("/raster  a photograph of a heart"),"/raster a photograph of a heart");
  assert.equal(routeAskImageRequest("make an image of a heart"),"/image make an image of a heart");
});

test("natural image generation via /ask and Ask selection does not need /image",()=>{
  const images=[
    "make image of a cute dog",
    "create an image of the human heart",
    "Please generate a labeled anatomical diagram of the lungs",
    "Could you draw a picture of the bloodstream?",
    "draw the human heart",
    "paint a mountain landscape",
    "turn this selection into a clean diagram",
    "redraw this as a medical illustration",
    "show me an image of DNA",
  ];
  for(const prompt of images){
    assert.equal(routeAskImageRequest(prompt),`/image ${prompt}`,prompt);
    assert.equal(routeAskImageRequest(routeAskImageRequest(prompt)),`/image ${prompt}`,prompt);
    assert.equal(parseAskDirective(`/ask ${prompt}`),prompt);
  }
  const textRequests=[
    "Explain the heart's anatomy",
    "Can you describe the image?",
    "How do I create an image in my app?",
    "draw a graph of y=x^2",
    "sketch the graph of y=x^2",
    "plot the function y=sin(x)",
    "create a table of the heart chambers",
    "draw a conclusion from this table",
    "Compare these two pictures",
    "describe this selection",
    "create an animated image showing current flowing through a circuit",
    "make an SVG diagram of electron movement",
  ];
  for(const prompt of textRequests) assert.equal(routeAskImageRequest(prompt),prompt,prompt);
});

test("AI image replies use only managed attachments, never raw provider URLs",()=>{
  const attachment={id:"picture-1",pageId:"page-1",storedPath:"/managed/picture.png",mimeType:"image/png",fileName:"Generated.png",sizeBytes:100,createdAt:"today"};
  const node=cloudBlocksToTiptap([{type:"image",attachment,alt:"a rabbit"}],file=>({type:"image",attrs:{src:"",attachmentId:file.id}}));
  assert.equal(node[0].type,"image");
  assert.equal(node[0].attrs?.attachmentId,"picture-1");
  assert.equal(node[0].attrs?.alt,"a rabbit");
  assert.throws(()=>cloudBlocksToTiptap([{type:"image",image_url:"https://untrusted.example/picture.png"}],()=>({type:"image"})),/managed PNG/);
  assert.throws(()=>cloudBlocksToTiptap([{type:"image",attachment:{...attachment,mimeType:"text/html"}}],()=>({type:"image"})),/managed PNG/);
});

test("converts Gemini math to an editable LaTeX node",()=>{
  const content=cloudBlocksToTiptap([{type:"math",latex:"\\nabla \\cdot \\mathbf{E}=\\rho/\\varepsilon_0"}]);
  assert.equal(content[0].content?.[0].type,"mathExpression");
  assert.equal(content[0].content?.[0].attrs?.latex,"\\nabla \\cdot \\mathbf{E}=\\rho/\\varepsilon_0");
});

test("strips accidental delimiters from dedicated math blocks",()=>{
  const content=cloudBlocksToTiptap([{type:"math",latex:String.raw`\(\int_0^1 x^2\,dx\)`}]);
  assert.equal(content[0].content?.[0].attrs?.latex,String.raw`\int_0^1 x^2\,dx`);
  assert.equal(content[0].content?.[0].attrs?.display,true);
});

test("converts a structured table to Tiptap table nodes",()=>{
  const content=cloudBlocksToTiptap([{type:"table",headers:["Law","Formula"],rows:[["Gauss","Flux"]]}]);
  assert.equal(content[0].type,"table");
  assert.equal(content[0].content?.[0].content?.[0].type,"tableHeader");
  assert.equal(content[0].content?.[1].content?.[0].type,"tableCell");
});

test("renders Gemini inline \\(LaTeX\\) inside ordered-list questions",()=>{
  const content=cloudBlocksToTiptap([{type:"orderedList",items:[
    String.raw`Evaluate the definite integral: \(\int_{0}^{3} (2x+1)\,dx\)`,
    String.raw`Evaluate: \(\int_{1}^{2} \frac{1}{x}\,dx\)`,
  ]}]);
  const firstParagraph=content[0].content?.[0].content?.[0];
  assert.equal(firstParagraph?.type,"paragraph");
  assert.deepEqual(firstParagraph?.content?.map(node=>node.type),["text","mathExpression"]);
  assert.equal(firstParagraph?.content?.[1].attrs?.latex,String.raw`\int_{0}^{3} (2x+1)\,dx`);
  assert.equal(firstParagraph?.content?.[1].attrs?.display,false);
});

test("normalizes all common inline math delimiter styles",()=>{
  const pieces=parseCloudInlineMath(String.raw`A \(x^2\), B $y=2x$, C \[\int_0^1 x\,dx\], D $$z=3$$.`);
  assert.deepEqual(pieces.filter(piece=>piece.kind==="math").map(piece=>piece.kind==="math"?piece.latex:""),[
    "x^2","y=2x",String.raw`\int_0^1 x\,dx`,"z=3",
  ]);
});

test("uses structured text/math segments when Gemini provides them",()=>{
  const content=cloudBlocksToTiptap([{type:"orderedList",items:[{
    segments:[
      {type:"text",text:"Evaluate "},
      {type:"math",latex:String.raw`\int_0^2 3x^2\,dx`},
      {type:"text",text:" exactly."},
    ],
  }]}]);
  const nodes=content[0].content?.[0].content?.[0].content??[];
  assert.deepEqual(nodes.map(node=>node.type),["text","mathExpression","text"]);
  assert.equal(nodes[1].attrs?.latex,String.raw`\int_0^2 3x^2\,dx`);
});

test("supports inline math inside table cells",()=>{
  const content=cloudBlocksToTiptap([{type:"table",headers:["Problem"],rows:[[
    String.raw`Find \(x\) if \(2x+1=5\)`,
  ]]}]);
  const cellParagraph=content[0].content?.[1].content?.[0].content?.[0];
  assert.deepEqual(cellParagraph?.content?.map(node=>node.type),["text","mathExpression","text","mathExpression"]);
});

test("does not mistake ordinary currency text for inline math",()=>{
  const content=cloudBlocksToTiptap([{type:"paragraph",text:"It costs $5 and the other one costs $10."}]);
  assert.deepEqual(content[0].content?.map(node=>node.type),["text"]);
  assert.equal(content[0].content?.[0].text,"It costs $5 and the other one costs $10.");
});

test("repairs JSON-escaped control characters before creating a math node",()=>{
  const corrupted=String.raw`\left(\frac{1}{x}`+"\r"+"ight) + "+"\t"+"ext{ok}";
  const content=cloudBlocksToTiptap([{type:"math",latex:corrupted}]);
  assert.equal(content[0].content?.[0].attrs?.latex,String.raw`\left(\frac{1}{x}\right) + \text{ok}`);
});

test("Ask sketches become actual graph nodes with plotted geometry and preserved axes",()=>{
  for(const relation of ["y=x^2","x^2+y^2=4",String.raw`y=\sin(x)`,String.raw`y=\frac{1}{x}`]){
    const nodes=cloudBlocksToTiptap([{type:"paragraph",text:"Sketch:"},
      {type:"graph",relation_latex:relation,x_min:-5,x_max:5,y_min:-2,y_max:25,title:"Function"}]);
    assert.equal(nodes[1].type,"mathGraph");
    assert.deepEqual(nodes[1].attrs,{relationLatex:relation,xMin:-5,xMax:5,yMin:-2,yMax:25,title:"Function"});
    const geometry=buildMathGraphGeometry(nodes[1].attrs as any);
    assert.equal(geometry.supported,true,relation);
    assert.match(geometry.path,/^M.+L/);
  }
});

test("Ask graph conversion rejects unsupported syntax and generated code rather than losing the graph",()=>{
  for(const relation of ["f(x)=x^2","y=a*x", "y=alert(x)","y=unknown(x)",String.raw`y=\int x dx`]){
    assert.throws(()=>cloudBlocksToTiptap([{type:"paragraph",text:"Graph below"},
      {type:"graph",relation_latex:relation}]),/cannot be plotted locally/);
  }
});

test("Ask graph nodes repair LaTeX and normalize invalid axis ranges",()=>{
  const nodes=cloudBlocksToTiptap([{type:"graph",relation_latex:"y="+"\f"+"rac{1}{x}",
    x_min:10,x_max:-10,y_min:"NaN",y_max:Infinity}]);
  assert.equal(nodes[0].attrs?.relationLatex,String.raw`y=\frac{1}{x}`);
  assert.equal(nodes[0].attrs?.xMin,-10);
  assert.equal(nodes[0].attrs?.yMax,10);
});

test("100-word vocabulary tables retain every entry, numeric rank, gender, and Unicode after saving",()=>{
  const rows=Array.from({length:100},(_,i)=>[i+1,i%2?"la città":"il libro",i%2?"femminile":"maschile",`Entry ${i+1}`]);
  const content=cloudBlocksToTiptap([{type:"table",headers:["#","Italiano","Genere","Meaning"],rows}]);
  const saved=JSON.parse(JSON.stringify({type:"doc",content}));
  const schema=getSchema([StarterKit,TableKit.configure({table:{resizable:true}})]);
  const actual=schema.nodeFromJSON(saved);
  actual.check();
  assert.equal(actual.firstChild?.childCount,101);
  assert.equal(actual.firstChild?.lastChild?.lastChild?.textContent,"Entry 100");
  const tableRows=saved.content[0].content;
  assert.equal(tableRows.length,101,"100 entries plus the header must remain");
  for(let i=0;i<100;i++){
    assert.deepEqual(tableRows[i+1].content.map((cell:any)=>cell.content[0].content[0].text),rows[i].map(String));
  }
});

test("Ask tables preserve the full row limit and reject overflow rather than silently dropping rows",()=>{
  const rows=Array.from({length:ASK_TABLE_MAX_ROWS},(_,i)=>[String(i+1)]);
  const table=cloudBlocksToTiptap([{type:"table",headers:["Entry"],rows}])[0];
  assert.equal(table.content?.length,ASK_TABLE_MAX_ROWS+1);
  assert.equal(table.content?.at(-1)?.content?.[0].content?.[0].content?.[0].text,String(ASK_TABLE_MAX_ROWS));
  assert.throws(()=>cloudBlocksToTiptap([{type:"table",rows:[...rows,["extra"]]}]),/exceeding 200 rows/);
});

test("large collections can span consecutive tables without losing later entries",()=>{
  const nodes=cloudBlocksToTiptap(Array.from({length:3},(_,part)=>({type:"table",headers:["Entry"],
    rows:Array.from({length:100},(_,i)=>[part*100+i+1])})));
  const entries=nodes.flatMap(node=>node.content!.slice(1).map(row=>row.content![0].content![0].content![0].text));
  assert.deepEqual(entries,Array.from({length:300},(_,i)=>String(i+1)));
});

test("malformed or over-wide tables fail explicitly without deleting columns",()=>{
  for(const block of [
    {type:"table",headers:Array(ASK_TABLE_MAX_COLUMNS+1).fill("h"),rows:[["v"]]},
    {type:"table",rows:[Array(ASK_TABLE_MAX_COLUMNS+1).fill("v")]},
    {type:"table",rows:["not a row"]},
  ])assert.throws(()=>cloudBlocksToTiptap([block]),/table/);
});


test("/ask fenced SVG inside a paragraph is split into visible code and surrounding prose",()=>{
  const blocks=cloudBlocksToTiptap([{type:"paragraph",text:"Electric current moving through a circuit\n\n```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"2\"/></svg>\n```\n\nThe moving dots represent current."}]);
  assert.deepEqual(blocks.map(block=>block.type),["paragraph","codeBlock","paragraph"]);
  assert.equal(blocks[1].attrs?.language,"svg");
  assert.match(String(blocks[1].content?.[0].text),/^<svg /);
  assert.equal(blocks[2].content?.[0].text,"The moving dots represent current.");
});

test("/ask regular code and plain discussion of SVG are unaffected",()=>{
  const blocks=cloudBlocksToTiptap([{type:"paragraph",text:"SVG is a vector image format."},
    {type:"code",language:"python",text:"print('Hello')"}]);
  assert.equal(blocks[0].content?.[0].text,"SVG is a vector image format.");
  assert.deepEqual(blocks[1],{type:"codeBlock",attrs:{language:"python"},content:[{type:"text",text:"print('Hello')"}]});
});
