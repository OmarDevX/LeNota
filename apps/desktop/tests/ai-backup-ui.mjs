import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import {readFile,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const app=fileURLToPath(new URL('../',import.meta.url));
const out=process.env.LENOTA_SCREENSHOTS??path.join(app,'test-results/ai');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.LENOTA_BROWSER?{executablePath:process.env.LENOTA_BROWSER}:{}),args:['--no-sandbox']});
let assertions=0;
try {
  for(const [width,height] of [[1440,900],[390,844]]){
    const page=await browser.newPage({viewport:{width,height}});
    const errors=[],dialogs=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
    const initMock = ({mobile})=>{
      window.__LENOTA_PLATFORM__=mobile?'android':'linux';
      const now='2026-10-13T12:00:00Z';
      let note={id:'p1',sectionId:'s1',title:'Study notes',plainText:'/ask explain gravity',contentJson:JSON.stringify({type:'lenota-canvas',version:3,viewport:{x:0,y:0,zoom:1},containers:[
        {id:'gravity',x:180,y:180,width:540,minHeight:170,zIndex:1,plainText:'/ask explain gravity',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'/ask explain gravity'}]}]}},
        {id:'private',x:180,y:620,width:540,minHeight:170,zIndex:2,plainText:'Cardiology separate lecture',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Private unrelated cardiology lecture content'}]}]}},
        {id:'physics',x:180,y:950,width:540,minHeight:170,zIndex:3,plainText:'Physics F=ma',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Physics F=ma'}]}]}}
      ],ink:[],shapes:[],aiMemory:[]}),isFavorite:false,parentPageId:null,tags:[],createdAt:now,updatedAt:now};
      let keys={openrouterConfigured:false};let chatgpt={connected:false,email:""};
      window.__calls=[];window.__requests=[];window.__aiCount=0;
      const callbacks=new Map();let next=1;
      window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:callback=>{const id=next++;callbacks.set(id,callback);return id;},unregisterCallback:id=>callbacks.delete(id),convertFileSrc:path=>path,invoke:async(command,args)=>{
        window.__calls.push(command);
        if(command==='load_workspace')return {notebooks:[{id:'n1',name:'Notebook',color:'#7c3aed',createdAt:now,updatedAt:now,sectionGroups:[],sections:[{id:'s1',notebookId:'n1',sectionGroupId:null,defaultTemplateId:null,name:'Section',color:'#a78bfa',createdAt:now,updatedAt:now,pages:[{...note,preview:note.plainText}]}]}]};
        if(command==='get_page')return {...note};
        if(command==='update_page'){note={...note,title:args.title,plainText:args.plainText,contentJson:args.contentJson};window.__savedNote={...note};return;}
        if(command==='sync_status')return {signedIn:false,email:null,serverUrl:null,lastSyncedAt:null,pending:false,allowHttp:false};
        if(command==='cloud_ai_status')return {configured:chatgpt.connected||keys.openrouterConfigured,provider:'ChatGPT → Gemini → OpenRouter'};
        if(command==='ai_backup_status')return {...keys};
        if(command==='chatgpt_status')return {...chatgpt};
        if(command==='chatgpt_connect'){chatgpt={connected:true,email:'study@example.test'};return {...chatgpt};}
        if(command==='chatgpt_disconnect'){chatgpt={connected:false,email:''};return {connected:false,remoteRevoked:true};}
        if(command==='configure_ai_backups'){
          if(args.removeOpenrouter)keys.openrouterConfigured=false;else if(args.openrouterKey)keys.openrouterConfigured=true;
          return {...keys};
        }
        if(command==='test_ai_backup')return {engine:'OpenRouter Free · nvidia/nemotron-3-ultra-550b-a55b:free',blocks:[{type:'paragraph',text:'2'}]};
        if(command==='cloud_ask'){
          window.__requests.push({prompt:args.prompt,pageContext:args.pageContext});
          window.__aiCount++;
          if(window.__holdAI)await new Promise(resolve=>{window.__resolveAI=resolve;});
          if(window.__failAI)throw new Error('All providers returned HTTP 503');
          return {engine:'ChatGPT Plus · gpt-6.1-sol',blocks:[{type:'paragraph',text:'Gravity is an attractive force.'}]};
        }
        if(['list_tags','list_attachments','list_trash','list_backups','list_page_revisions','search_pages','list_recent_pages','list_favorite_pages'].includes(command))return [];
        if(command==='plugin:event|listen')return next++;
        return null;
      }};
      window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
      localStorage.setItem('lenota:appearance:theme','dark');
    };
    await page.addInitScript(initMock,{mobile:width<900});
    await page.route('http://lenota.test/**',async route=>{
      const url=new URL(route.request().url());
      const file=path.join(app,'dist',url.pathname==='/'?'index.html':url.pathname);
      try{await route.fulfill({status:200,body:await readFile(file),contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream'});}catch{await route.fulfill({status:404,body:'missing'});}
    });
    await page.evaluate(() => {
      const values = new Map();
      Object.defineProperty(window,'localStorage',{configurable:true,value:{
        getItem:key=>values.has(key)?values.get(key):null,
        setItem:(key,value)=>values.set(key,String(value)),
        removeItem:key=>values.delete(key),clear:()=>values.clear(),key:index=>[...values.keys()][index]??null,
        get length(){return values.size;},
      }});
    });
    await page.evaluate(initMock,{mobile:width<900});
    await page.setContent('<!doctype html><html><head><title>LeNota</title></head><body><div id="root"></div></body></html>');
    const assets=await readdir(path.join(app,'dist/assets'));
    const css=assets.find(name=>/^index-.*\.css$/.test(name));
    const js=assets.find(name=>/^index-.*\.js$/.test(name));
    if(css)await page.addStyleTag({content:await readFile(path.join(app,'dist/assets',css),'utf8')});
    if(js)await page.addScriptTag({content:await readFile(path.join(app,'dist/assets',js),'utf8'),type:'module'});
    await page.locator('.ProseMirror').first().waitFor();
    await page.getByRole('button',{name:'AI providers',exact:true}).first().click();
    const dialog=page.getByRole('dialog',{name:'AI providers'});
    await dialog.waitFor();
    await dialog.getByText('1. ChatGPT Plus · preferred').waitFor();assertions++;
    if(width>900){
      await dialog.getByRole('button',{name:'Continue with ChatGPT'}).click();
      await dialog.getByText(/ChatGPT connected/).waitFor();assertions++;
      await dialog.getByRole('button',{name:'Disconnect ChatGPT'}).waitFor();assertions++;
    }else{
      await dialog.getByText(/desktop only/).waitFor();assertions++;
    }
    await dialog.getByLabel('OpenRouter API key',{exact:true}).fill('sk-or_synthetic-test-key-123456789');
    await dialog.getByRole('button',{name:'Save OpenRouter',exact:true}).click();
    await dialog.getByText('OpenRouter settings saved.',{exact:true}).waitFor();
    assert.equal(await dialog.getByLabel('OpenRouter API key',{exact:true}).inputValue(),'');assertions++;
    assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('synthetic-test-key')),false);assertions++;
    await dialog.getByRole('button',{name:'Test OpenRouter',exact:true}).click();
    await dialog.getByText(/Connected: OpenRouter Free/).waitFor();assertions++;
    const providerBox=await dialog.boundingBox();
    assert.ok(providerBox&&providerBox.width<=Math.min(490,width-12),`Provider dialog too wide: ${providerBox?.width}`);assertions++;
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assertions++;
    await page.screenshot({path:path.join(out,`ai-providers-${width}.png`)});
    await dialog.getByRole('button',{name:'Close AI providers',exact:true}).click();
    if(width>900)await page.getByRole('button',{name:'AI context developer options'}).click();
    else {await page.getByRole('button',{name:'AI providers',exact:true}).first().click();await page.getByRole('button',{name:'AI context · developer options'}).click();}
    const settingsDialog=page.getByRole('dialog',{name:'AI context and request preview'});
    await settingsDialog.waitFor();
    const contextBox=await settingsDialog.boundingBox();
    assert.ok(contextBox&&contextBox.width<=Math.min(730,width-12),`Context dialog too wide: ${contextBox?.width}`);assertions++;
    assert.equal(await settingsDialog.getByLabel('AI context scope').inputValue(),'note');assertions++;
    await settingsDialog.getByRole('button',{name:'Save defaults'}).click();
    // Clicking a note's checkmark must be independent from ordinary canvas selection.
    const markGravity=page.locator('[data-ai-context-toggle="gravity"]');
    await markGravity.evaluate(el=>el.click());
    assert.equal(await markGravity.getAttribute('aria-pressed'),'true');assertions++;
    await page.evaluate(()=>document.querySelector('[data-ai-context-toggle="physics"]')?.click());
    assert.equal(await page.locator('[data-ai-context-toggle="physics"]').getAttribute('aria-pressed'),'true');assertions++;
    await page.evaluate(()=>document.querySelector('[data-ai-context-toggle="private"]')?.click());
    await page.evaluate(()=>document.querySelector('[data-ai-context-toggle="private"]')?.click());
    assert.equal(await page.locator('[data-ai-context-toggle="private"]').getAttribute('aria-pressed'),'false');assertions++;
    // Marking notes activates chosen scope; manually return to default for first request.
    if(width>900)await page.getByRole('button',{name:'AI context developer options'}).click();
    else {await page.getByRole('button',{name:'AI providers',exact:true}).first().click();await page.getByRole('button',{name:'AI context · developer options'}).click();}
    await settingsDialog.getByLabel('AI context scope').selectOption('note');
    await settingsDialog.getByRole('button',{name:'Save defaults'}).click();
    const editor=page.locator('.ProseMirror').first();
    await editor.click();
    await page.evaluate(()=>{window.__holdAI=true;});
    await editor.press('Control+End');await editor.press('Enter');
    const contextReview=page.getByRole('dialog',{name:'AI context and request preview'});
    await contextReview.waitFor();
    assert.equal(await contextReview.getByLabel('AI context scope').inputValue(),'note');assertions++;
    assert.ok((await contextReview.getByLabel('Outgoing AI page context').inputValue()).includes('Study notes'));assertions++;
    assert.ok(!(await contextReview.getByLabel('Outgoing AI page context').inputValue()).includes('Private unrelated cardiology'));assertions++;
    assert.ok(!(await contextReview.getByLabel('Outgoing AI page context').inputValue()).includes('/ask explain gravity'));assertions++;
    await page.screenshot({path:path.join(out,`ai-context-${width}.png`)});
    await contextReview.getByLabel('AI context scope').selectOption('chosen');
    await contextReview.getByText('2 of 3 notes checked').waitFor();assertions++;
    // No long scrolling checkbox list: marks come from each note on the canvas.
    assert.equal(await contextReview.locator('input[aria-label^="Include note"]').count(),0);assertions++;
    await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Outgoing AI page context"]')?.value.includes('Physics F=ma'));
    const chosenContext=await contextReview.getByLabel('Outgoing AI page context').inputValue();
    assert.ok(chosenContext.includes('Physics F=ma')&&!chosenContext.includes('Private unrelated cardiology'));assertions++;
    await contextReview.getByLabel('AI context scope').selectOption('page');
    await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Outgoing AI page context"]')?.value.includes('Private unrelated cardiology'));
    assert.ok((await contextReview.getByLabel('Outgoing AI page context').inputValue()).includes('Private unrelated cardiology'));assertions++;
    await contextReview.getByLabel('AI context scope').selectOption('none');
    await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Outgoing AI page context"]')?.value==='');
    assert.equal(await contextReview.getByLabel('Outgoing AI page context').inputValue(),'');assertions++;
    await contextReview.getByLabel('AI context scope').selectOption('note');
    await contextReview.getByLabel('Outgoing AI page context').fill('Only the Italian lesson I selected.');
    await contextReview.getByRole('button',{name:'Send to AI'}).click();
    assert.equal(await page.evaluate(()=>window.__calls.at(-1)),'cloud_ask');assertions++;
    await page.waitForFunction(()=>window.__aiCount===1);
    assert.deepEqual(await page.evaluate(()=>window.__requests[0]),{prompt:'explain gravity',pageContext:'Only the Italian lesson I selected.'});assertions++;
    assert.equal(await editor.getAttribute('contenteditable'),'true');assertions++;
    await editor.press('Control+End');await editor.press('End');
    await page.keyboard.type(' My new study note');
    await page.evaluate(()=>{window.__holdAI=false;window.__resolveAI();});
    await page.getByText('Gravity is an attractive force.',{exact:true}).first().waitFor();
    assert.ok((await editor.textContent()).includes('My new study note'));assertions++;
    assert.ok((await editor.textContent()).includes('/ask explain gravity'));assertions++;
    await page.screenshot({path:path.join(out,`ai-safe-edit-${width}.png`)});
    // A complete provider outage preserves the command without a modal alert.
    await editor.click();await editor.press('Control+A');await page.keyboard.type('/ask explain entropy');
    await page.evaluate(()=>{window.__failAI=true;});
    await editor.press('Control+End');await editor.press('Enter');
    await page.getByRole('dialog',{name:'AI context and request preview'}).getByRole('button',{name:'Send to AI'}).click();
    try{await page.getByRole('status').filter({hasText:'AI unavailable.'}).waitFor({timeout:5000});}catch(error){console.log('Failure UI',width,await page.evaluate(()=>({calls:window.__calls,count:window.__aiCount,status:[...document.querySelectorAll('[role=status]')].map(e=>e.textContent),editors:[...document.querySelectorAll('.ProseMirror')].map(e=>e.textContent)})));await page.screenshot({path:path.join(out,`failure-${width}.png`)});throw error;}
    assert.ok((await editor.textContent()).includes('/ask explain entropy'));assertions++;
    assert.equal(await editor.getAttribute('contenteditable'),'true');assertions++;
    // Cancelling a slow request leaves no late insertion when transport ends.
    await editor.click();await editor.press('Control+A');await page.keyboard.type('/ask explain energy');
    await page.evaluate(()=>{window.__failAI=false;window.__holdAI=true;});
    await editor.press('Control+End');await editor.press('Enter');
    await page.getByRole('dialog',{name:'AI context and request preview'}).getByRole('button',{name:'Send to AI'}).click();
    await page.waitForFunction(()=>window.__aiCount===3);
    await page.getByRole('button',{name:'Cancel AI request',exact:true}).click({timeout:5000});
    await page.evaluate(()=>window.__resolveAI());
    await page.waitForTimeout(50);
    assert.ok((await editor.textContent()).includes('/ask explain energy'));assertions++;
    assert.equal(await page.getByText('Gravity is an attractive force.',{exact:true}).count(),1);assertions++;
    assert.deepEqual(errors,[]);assertions++;
    assert.deepEqual(dialogs,[]);assertions++;
    // Real editor: pasted ChatGPT Markdown/LaTeX becomes editable KaTeX nodes.
    await editor.click();
    await editor.press('Control+End');
    await editor.press('Enter');
    const pasteHandled = await editor.evaluate(element => {
      const data = new DataTransfer();
      data.setData('text/plain', '# Vektörler\n\nInline $A_x$ ve $\\beta$\n\n$$\n\\vec{A}=\\sqrt{A_x^2+A_y^2}\n$$');
      const event = new ClipboardEvent('paste', {clipboardData:data,bubbles:true,cancelable:true});
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(pasteHandled,true,'pasted LaTeX should be claimed by editor');assertions++;
    await page.waitForFunction(()=>document.querySelectorAll('.ProseMirror [data-lenota-math]').length>=3);
    const latex = await editor.locator('[data-lenota-math]').evaluateAll(elements => elements.map(element => element.getAttribute('data-latex')||element.querySelector('.lenota-math-render')?.textContent));
    assert.ok(latex.length>=3);assertions++;
    assert.ok(await editor.locator('.katex').count()>=3);assertions++;
    await editor.press('Control+End');
    await editor.press('Enter');
    await page.keyboard.type('Typed math: $x^2$');
    await page.waitForFunction(()=>document.querySelectorAll('.ProseMirror [data-lenota-math]').length>=4);
    assertions++;
    await page.close();
  }
  console.log(`${assertions} AI backup UI assertions passed.`);
}finally{await browser.close();}
