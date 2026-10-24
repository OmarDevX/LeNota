import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const app=fileURLToPath(new URL('../',import.meta.url));
const browser=await chromium.launch({headless:true,executablePath:process.env.LENOTA_BROWSER || '/usr/bin/chromium',args:['--no-sandbox']});
let assertions=0;
try {
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const now='2026-10-18T08:00:00Z';
    const summary={id:'perf1',sectionId:'sec1',title:'Performance test page',preview:'',isFavorite:false,parentPageId:null,tags:[],createdAt:now,updatedAt:now};
    const containers=Array.from({length:240},(_,i)=>({
      id:`note-${i}`,x:(i%24)*480,y:Math.floor(i/24)*320,width:380,minHeight:120,zIndex:i+1,
      plainText:`Lecture ${i} preserved`,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:`Lecture ${i} preserved`}]}]},
    }));
    const ink=Array.from({length:1200},(_,i)=>({id:`ink-${i}`,tool:'pen',color:'#222222',width:2,points:[
      {x:(i%24)*480+20,y:Math.floor(i/24)*75+40},{x:(i%24)*480+90,y:Math.floor(i/24)*75+60}
    ]}));
    const shapes=Array.from({length:320},(_,i)=>({id:`shape-${i}`,kind:'rectangle',x1:(i%24)*480+140,y1:Math.floor(i/24)*260+50,x2:(i%24)*480+200,y2:Math.floor(i/24)*260+100,stroke:'#777777',fill:'transparent',strokeWidth:2,zIndex:i}));
    const document={type:'lenota-canvas',version:3,viewport:{x:0,y:0,zoom:1},containers,ink,shapes,background:{pattern:'plain',color:'#ffffff',spacing:24},aiMemory:[]};
    const note={...summary,contentJson:JSON.stringify(document),plainText:containers.map(i=>i.plainText).join('\n')};
    const tree={notebooks:[{id:'nb1',name:'Notebook',color:'#7c3aed',createdAt:now,updatedAt:now,sectionGroups:[],sections:[{id:'sec1',notebookId:'nb1',sectionGroupId:null,defaultTemplateId:null,name:'Physics',color:'#a78bfa',createdAt:now,updatedAt:now,pages:[summary]}]}]};
    let next=1;const callbacks=new Map();
    window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:fn=>{callbacks.set(next,fn);return next++;},unregisterCallback:id=>callbacks.delete(id),convertFileSrc:path=>path,invoke:async(command,args)=>{
      if(command==='load_workspace')return tree;
      if(command==='get_page')return {...note};
      if(command==='update_page'){Object.assign(note,{title:args.title,contentJson:args.contentJson,plainText:args.plainText});window.__savedPage={...note};return;}
      if(command==='cloud_ai_status')return {configured:false,provider:'Gemini'};
      if(['list_tags','list_attachments','list_trash','list_backups','list_page_revisions','search_pages','list_recent_pages','list_favorite_pages'].includes(command))return [];
      if(command==='plugin:event|listen')return next++;
      return null;
    }};
    window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
    window.__expectedDocument=document;
    localStorage.setItem('lenota:appearance:theme','dark');
    localStorage.setItem('lenota:canvas:v026:fitted:perf1','1');
  });
  await page.route('http://127.0.0.1:1420/**',async route=>{
    const url=new URL(route.request().url());const filename=path.join(app,'dist',url.pathname==='/'?'index.html':url.pathname);
    try{const body=await readFile(filename);await route.fulfill({status:200,body,contentType:filename.endsWith('.html')?'text/html':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'application/octet-stream'});}
    catch{await route.fulfill({status:404,body:'not found'});}
  });
  await page.goto('http://127.0.0.1:1420/');
  await page.locator('.note-canvas').waitFor();
  await page.locator('[data-note-container-id="note-0"]').waitFor({timeout:12000});
  const original=await page.evaluate(()=>window.__expectedDocument);
  assert.equal(original.containers.length,240);assertions++;
  const firstNotes=await page.locator('[data-note-container-id]').count();
  const firstInk=await page.locator('.canvas-ink-layer > g:not([data-live-ink-preview-group]) path').count();
  const firstShapes=await page.locator('.canvas-shapes-layer .canvas-shape').count();
  assert.ok(firstNotes<50,`Expected note virtualization, mounted ${firstNotes}`);assertions++;
  assert.ok(firstInk<300,`Expected ink virtualization, mounted ${firstInk}`);assertions++;
  assert.ok(firstShapes<100,`Expected shape virtualization, mounted ${firstShapes}`);assertions++;
  await page.locator('[data-note-container-id="note-0"] .ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' EDIT SAVED');
  await page.waitForFunction(()=>window.__savedPage?.contentJson.includes('EDIT SAVED'));
  assertions++;
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const canvas=page.locator('.note-canvas');const bounds=await canvas.boundingBox();
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  for(let i=0;i<13;i++)await page.mouse.wheel(150,0);
  await page.waitForTimeout(400);
  const moved=await page.locator('[data-note-container-id]').count();
  assert.ok(moved<50,`After pan mounted ${moved} notes`);assertions++;
  assert.equal((await page.locator('[data-note-container-id="note-0"]').count()),0,'Distant, non-selected note should unmount');assertions++;
  await page.mouse.wheel(-150,0);
  for(let i=0;i<12;i++)await page.mouse.wheel(-150,0);
  await page.waitForTimeout(450);
  await page.locator('[data-note-container-id="note-0"]').waitFor();
  assert.match(await page.locator('[data-note-container-id="note-0"]').innerText(),/EDIT SAVED/);assertions++;
  // Rendering must not remove document content from persistence.
  const saved=JSON.parse(await page.evaluate(()=>window.__savedPage.contentJson));
  assert.equal(saved.containers.length,240);assert.equal(saved.ink.length,1200);assert.equal(saved.shapes.length,320);assertions+=3;
  assert.deepEqual(errors,[],'No React errors or runtime exceptions');assertions++;
  console.log(`${assertions} Chromium virtualization assertions passed. Initially ${firstNotes} notes, ${firstInk} ink paths, ${firstShapes} shapes; after pan ${moved} notes.`);
}finally{await browser.close();}
