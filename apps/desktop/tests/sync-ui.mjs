import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const app = fileURLToPath(new URL('../', import.meta.url));
const artifacts = process.env.LENOTA_SCREENSHOTS ?? path.join(app, 'test-results/sync');
await mkdir(artifacts, {recursive:true});
const browser = await chromium.launch({headless:true, ...(process.env.LENOTA_BROWSER ? {executablePath:process.env.LENOTA_BROWSER} : {}), args:['--no-sandbox']});
let assertions = 0;
try {
  for (const [width,height] of [[320,720],[390,844],[430,932],[1440,900]]) {
    const context = await browser.newContext({viewport:{width,height},hasTouch:width<900});
    const page = await context.newPage();
    const errors=[];
    page.on('pageerror', error=>errors.push(error.message));
    await page.addInitScript(() => {
      window.__LENOTA_PLATFORM__='android';
      const now='2026-10-12T08:00:00Z';
      let note={id:'p1',sectionId:'s1',title:'Sync test note',plainText:'Original body',contentJson:JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Original body'}]}]}),isFavorite:false,parentPageId:null,tags:[],createdAt:now,updatedAt:now};
      let status={signedIn:false,email:null,serverUrl:null,lastSyncedAt:null,pending:false,allowHttp:false};
      let captured=null;
      window.__calls=[];
      window.__finishCount=0;
      window.__holdSync=false;
      const callbacks=new Map();let next=1;
      window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:callback=>{const id=next++;callbacks.set(id,callback);return id;},unregisterCallback:id=>callbacks.delete(id),convertFileSrc:path=>path,invoke:async(command,args)=>{
        window.__calls.push(command);
        if(command==='load_workspace')return {notebooks:[{id:'n1',name:'Notebook',color:'#7c3aed',createdAt:now,updatedAt:now,sectionGroups:[],sections:[{id:'s1',notebookId:'n1',sectionGroupId:null,defaultTemplateId:null,name:'Section',color:'#a78bfa',createdAt:now,updatedAt:now,pages:[{...note,preview:note.plainText}]}]}]};
        if(command==='get_page')return {...note};
        if(command==='update_page'){note={...note,title:args.title,plainText:args.plainText,contentJson:args.contentJson};window.__savedNote={...note};return;}
        if(command==='sync_status')return {...status};
        if(command==='sync_login'){
          if(args.provider==='supabase'&&!args.publicKey.startsWith('sb_publishable_'))throw new Error('Use the public publishable key');
          if(window.__failLogin)throw new Error('Incorrect email or password');
          status={...status,signedIn:true,email:args.email,serverUrl:args.serverUrl,provider:args.provider,publicKey:args.publicKey};return {...status};
        }
        if(command==='sync_logout'){status.signedIn=false;return {...status};}
        if(command==='sync_now'){
          captured=JSON.stringify(note);
          if(window.__holdSync)await new Promise(resolve=>{window.__resolvePrepare=resolve;});
          if(window.__failSync)throw new Error('Cannot reach the sync server. Your notes are saved locally.');
          return {prepared:true,changed:Boolean(window.__incomingTitle)};
        }
        if(command==='sync_finish'){
          window.__finishCount++;
          const applied=JSON.stringify(note)===captured;
          const changed=applied&&Boolean(window.__incomingTitle);
          if(changed){note.title=window.__incomingTitle;window.__incomingTitle=null;}
          if(applied)status.lastSyncedAt=String(Date.now());
          status.pending=!applied;
          return {applied,changed,conflicts:[],status:{...status}};
        }
        if(command==='cloud_ai_status')return {configured:false,provider:'Gemini'};
        if(['list_tags','list_attachments','list_trash','list_backups','list_page_revisions','search_pages','list_recent_pages','list_favorite_pages'].includes(command))return [];
        if(command==='plugin:event|listen')return next++;
        return null;
      }};
      window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
      localStorage.setItem('lenota:appearance:theme','dark');
    });
    await page.route('http://lenota.test/**',async route=>{
      const url=new URL(route.request().url());
      const filename=path.join(app,'dist',url.pathname==='/'?'index.html':url.pathname);
      try{await route.fulfill({status:200,body:await readFile(filename),contentType:filename.endsWith('.html')?'text/html':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'application/octet-stream'});}
      catch{await route.fulfill({status:404,body:'missing'});}
    });
    await page.goto('http://lenota.test/');
    await page.locator('.note-canvas').waitFor();
    await page.locator('.ProseMirror').first().waitFor();
    if(width<900)await page.getByRole('button',{name:'Open notebooks',exact:true}).click();
    await page.getByRole('button',{name:'Account and sync',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Account and sync'});
    await dialog.waitFor();
    const managed=width===430;
    assert.equal(await dialog.getByLabel('Sync service',{exact:true}).inputValue(),'supabase');assertions++;
    if(!managed)await dialog.getByLabel('Sync service',{exact:true}).selectOption('selfHosted');
    await dialog.getByRole('button',{name:'Create account',exact:true}).click();
    await dialog.getByLabel(managed?'Supabase project URL':'Server address',{exact:true}).fill(managed?'https://project.supabase.co':'https://notes.example.com');
    if(managed)await dialog.getByLabel('Publishable key',{exact:true}).fill('sb_publishable_test');
    await dialog.getByLabel('Email',{exact:true}).fill('me@example.com');
    await dialog.getByLabel('Password',{exact:true}).fill('correct horse battery staple');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assertions++;
    await page.screenshot({path:path.join(artifacts,`account-${width}.png`)});
    if(managed){
      await dialog.getByLabel('Publishable key',{exact:true}).fill('sb_secret_do_not_use');
      await dialog.getByRole('button',{name:'Create account & sync',exact:true}).click();
      await dialog.getByRole('alert').waitFor();assert.match(await dialog.getByRole('alert').textContent(),/publishable/);assertions++;
      await dialog.getByLabel('Publishable key',{exact:true}).fill('sb_publishable_test');
    }
    await dialog.getByRole('button',{name:'Create account & sync',exact:true}).click();
    await dialog.getByText('All changes synced.',{exact:true}).waitFor();
    await dialog.getByText('me@example.com',{exact:true}).waitFor();assertions++;
    const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);assertions++;
    await page.screenshot({path:path.join(artifacts,`connected-${width}.png`)});
    if(width===390){
      await dialog.getByRole('button',{name:'Close account and sync'}).click();
      if(await page.getByRole('button',{name:'Close notebooks drawer',exact:true}).isVisible())await page.getByRole('button',{name:'Close notebooks drawer',exact:true}).click();
      // Editing remains available during a held HTTP request.
      await page.evaluate(()=>{window.__holdSync=true;window.__incomingTitle='Incoming remote title';window.dispatchEvent(new Event('focus'));});
      await page.waitForFunction(()=>Boolean(window.__resolvePrepare));
      await page.locator('.normal-page-title').fill('Typed during sync');
      await page.evaluate(()=>{window.__holdSync=false;window.__resolvePrepare();window.__resolvePrepare=null;});
      await page.waitForFunction(()=>window.__finishCount>=2);
      assert.equal(await page.locator('.normal-page-title').inputValue(),'Typed during sync');assertions++;
      assert.equal(await page.evaluate(()=>window.__savedNote.title),'Typed during sync');assertions++;
      // No edit in flight: the remote title is imported and the visible editor reloads.
      await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await page.waitForFunction(()=>document.querySelector('.normal-page-title')?.value==='Incoming remote title');assertions++;
      // Sync waits for an active drawing gesture before applying a page reload.
      const before=await page.evaluate(()=>window.__finishCount);
      await page.evaluate(()=>{document.dispatchEvent(new PointerEvent('pointerdown',{pointerId:91}));window.__incomingTitle='After gesture';window.dispatchEvent(new Event('focus'));});
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(()=>window.__finishCount),before);assertions++;
      await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointerup',{pointerId:91})));
      await page.waitForFunction(()=>document.querySelector('.normal-page-title')?.value==='After gesture');assertions++;
      await page.getByRole('button',{name:'Open notebooks',exact:true}).click();
      await page.getByRole('button',{name:'Account and sync',exact:true}).click();
      await page.evaluate(()=>{window.__failSync=true;});
      await dialog.getByRole('button',{name:'Sync now',exact:true}).click();
      await dialog.getByRole('alert').waitFor();
      assert.match(await dialog.getByRole('alert').textContent(),/saved locally/);assertions++;
      await dialog.getByRole('button',{name:'Sign out',exact:true}).click();
      await dialog.getByLabel('Password',{exact:true}).waitFor();assertions++;
      await page.evaluate(()=>{window.__failLogin=true;});
      await dialog.getByLabel('Password',{exact:true}).fill('correct horse battery staple');
      await dialog.getByRole('button',{name:'Sign in & sync',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[role=alert]')?.textContent.includes('Incorrect'));
      await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
      await page.screenshot({path:path.join(artifacts,'account-light-390.png')});
    }
    assert.deepEqual(errors,[]);assertions++;
    await context.close();
  }
  console.log(`PASS: ${assertions} account and sync UI assertions.`);
}finally{await browser.close();}
