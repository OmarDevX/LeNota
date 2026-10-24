/** Optional real-browser regression for the WebKit-independent Ask selection path.
 * Run with: node tests/visual-canvas-fallback-ui.mjs
 * Uses the system Chromium and no external services or AI keys. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import ts from 'typescript';

const source = readFileSync(new URL('../src/features/editor/visual-canvas-fallback.ts',import.meta.url),'utf8');
const js = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
  .replaceAll('export function ','function ');
const browser = await chromium.launch({executablePath:process.env.CHROME_BINARY || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try {
  const page=await browser.newPage({viewport:{width:500,height:350}});
  await page.setContent(`<!doctype html><style>body{margin:0;background:white}.canvas-world{position:relative;width:300px;height:200px}.note-container-editor{position:absolute;left:30px;top:40px;width:230px;font:20px sans-serif;color:#000}</style><div class="canvas-world"><div class="note-container-editor">Ask selection works</div><svg class="canvas-shapes-layer" width="300" height="200" style="position:absolute;left:0;top:0"><path d="M 10 145 L 290 145" fill="none" stroke="#d00000" stroke-width="8"/></svg><svg class="canvas-ink-layer" width="300" height="200" style="position:absolute;left:0;top:0"><path d="M 250 80 L 250 115" fill="none" stroke="#0010ff" stroke-width="7"/></svg></div>`);
  await page.addScriptTag({content:js+'\nwindow.askCanvasFallback={drawVisualNoteText,drawVisualVectorLayers};'});
  const result=await page.evaluate(()=>{
    const world=document.querySelector('.canvas-world');
    const canvas=document.createElement('canvas');canvas.width=300;canvas.height=200;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,300,200);
    const bounds={left:0,top:0,right:300,bottom:200,width:300,height:200};
    const text=window.askCanvasFallback.drawVisualNoteText(ctx,world,bounds,1,(x,y)=>({x,y}));
    const vector=window.askCanvasFallback.drawVisualVectorLayers(ctx,world,bounds,1);
    const pixel=(x,y)=>[...ctx.getImageData(x,y,1,1).data];
    return {text,vector,red:pixel(100,145),blue:pixel(250,95),background:pixel(300-1,200-1),png:canvas.toDataURL('image/png').slice(0,30)};
  });
  assert.ok(result.text>0,`No text painted: ${JSON.stringify(result)}`);
  assert.ok(result.vector>=2,`No vector ink painted: ${JSON.stringify(result)}`);
  assert.ok(result.red[0]>150&&result.red[1]<70&&result.red[2]<70,`Missing red stroke: ${JSON.stringify(result)}`);
  assert.ok(result.blue[2]>180&&result.blue[0]<70,`Missing blue ink: ${JSON.stringify(result)}`);
  assert.deepEqual(result.background,[255,255,255,255]);
  assert.ok(result.png.startsWith('data:image/png;base64,'));
  console.log('PASS: Ask selection native fallback captures typed text, ink, and shapes as a valid PNG.');
} finally { await browser.close(); }
