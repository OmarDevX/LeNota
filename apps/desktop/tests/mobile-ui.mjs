import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const app = fileURLToPath(new URL('../', import.meta.url));
const artifacts = process.env.LENOTA_SCREENSHOTS ?? path.join(app,'test-results/mobile');
await mkdir(artifacts,{recursive:true});
const browser = await chromium.launch({headless:true, ...(process.env.LENOTA_BROWSER ? {executablePath:process.env.LENOTA_BROWSER} : {}), args:['--no-sandbox']});
let assertions=0;
try {
  for (const [width,height] of (process.env.LENOTA_VIEWPORTS ? JSON.parse(process.env.LENOTA_VIEWPORTS) : [[320,720],[390,844],[430,932],[768,1024],[844,390],[1440,900]])) {
    const context=await browser.newContext({viewport:{width,height},hasTouch:width<900});
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(() => {
      window.__LENOTA_PLATFORM__='android';
      const now='2026-10-10T08:00:00Z';
      const summary={id:'p1',sectionId:'s1',title:'A little space to think',preview:'Ideas, lectures, and everything in between.',isFavorite:false,parentPageId:null,tags:[],createdAt:now,updatedAt:now};
      const note={...summary,contentJson:JSON.stringify({type:'doc',content:[{type:'heading',attrs:{level:2},content:[{type:'text',text:'Make room for a good idea.'}]},{type:'paragraph',content:[{type:'text',text:'Capture your thoughts, sketch a diagram, or keep your lecture notes together. Your notebook goes wherever you do.'}]},{type:'bulletList',content:[{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'Write something worth remembering'}]}]},{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'Sketch it out with a pen'}]}]}]}]}),plainText:'Make room for a good idea.'};
      const tree={notebooks:[{id:'n1',name:'My Notebook',color:'#7c3aed',createdAt:now,updatedAt:now,sectionGroups:[],sections:[{id:'s1',notebookId:'n1',sectionGroupId:null,defaultTemplateId:null,name:'Quick Notes',color:'#a78bfa',createdAt:now,updatedAt:now,pages:[summary]}]}]};
      let next=1;
      const callbacks=new Map();
      window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:callback=>{const id=next++;callbacks.set(id,callback);return id;},unregisterCallback:id=>callbacks.delete(id),convertFileSrc:path=>path,invoke:async(command,args)=>{
        if(command==='load_workspace') return tree;
        if(command==='get_page') return {...note};
        if(command==='update_page'){Object.assign(note,{title:args.title,contentJson:args.contentJson,plainText:args.plainText});window.__savedNote={...note};return;}
        if(command==='cloud_ai_status')return {configured:false,provider:'Gemini'};
        if(['list_tags','list_attachments','list_trash','list_backups','list_page_revisions','search_pages','list_recent_pages','list_favorite_pages'].includes(command))return [];
        if(command==='plugin:event|listen')return next++;
        if(command==='plugin:fs|write_text_file')return;
        return null;
      }};
      window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
      localStorage.setItem('lenota:appearance:theme','dark');
    });
    await page.route('http://lenota.test/**',async route=>{
      const url=new URL(route.request().url());
      const filename=path.join(app,'dist',url.pathname==='/'?'index.html':url.pathname);
      try {const body=await readFile(filename);const type=filename.endsWith('.html')?'text/html':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.woff2')?'font/woff2':'application/octet-stream';await route.fulfill({status:200,body,contentType:type});}
      catch {await route.fulfill({status:404,body:'missing'});}
    });
    await page.goto('http://lenota.test/');
    await page.locator('.note-canvas').waitFor();
    await page.locator('.ProseMirror').first().waitFor();
    assert.deepEqual(errors,[],`Runtime errors at ${width}px`);assertions++;
    const bounds=await page.locator('.note-canvas').boundingBox();
    assert.ok(bounds.width>=width*(width<900?.95:.5),`Canvas too narrow at ${width}px`);assertions++;
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
    assert.equal(overflow,false,`Horizontal page overflow at ${width}px`);assertions++;
    await page.screenshot({path:path.join(artifacts,`workspace-${width}.png`)});
    if(width<900){
      const font=await page.locator('.ProseMirror').first().evaluate(element=>Number.parseFloat(getComputedStyle(element).fontSize));
      assert.ok(font>=16,`Text is too small at ${width}px`);assertions++;
      const tabs=await page.locator('.workspace-mode-tabs').boundingBox();
      assert.ok(tabs.x>=0&&tabs.x+tabs.width<=width,`Toolbar outside screen at ${width}px`);assertions++;
      await page.getByRole('button',{name:'Open notebooks',exact:true}).click();
      await page.getByRole('button',{name:'Close notebooks drawer',exact:true}).waitFor();
      const drawer=await page.locator('.navigation-drawer').boundingBox();assert.ok(drawer.width<=width&&drawer.width>250);assertions++;
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(()=>Boolean(document.activeElement?.closest('.mobile-drawer-heading, .app-rail, .navigation-drawer'))),true);assertions++;
      await page.screenshot({path:path.join(artifacts,`drawer-${width}.png`)});
      assert.equal(await page.evaluate(()=>window.__LENOTA_BACK__()),true);assertions++;
      await page.getByRole('button',{name:'Open notebooks',exact:true}).waitFor();
      await page.locator('.normal-page-title').fill('Mobile autosave');
      await page.waitForFunction(()=>window.__savedNote?.title==='Mobile autosave');assertions++;
      if(width===390){
        const editor=page.locator('.ProseMirror').first();
        await editor.click();
        await editor.press('Control+End');
        await editor.press('Enter');
        await page.keyboard.insertText('Written on a phone, kept through rotation.');
        await page.waitForFunction(()=>window.__savedNote?.contentJson.includes('Written on a phone, kept through rotation.'));assertions++;
        // Android IME insets resize the WebView itself; there is no visual
        // viewport height difference to infer keyboard visibility from.
        await page.setViewportSize({width,height:484});
        await page.evaluate(()=>{window.__LENOTA_KEYBOARD_OPEN__=true;window.dispatchEvent(new Event('lenota:keyboard'));});
        assert.equal(await page.locator('.mobile-bottom-nav').isVisible(),false);assertions++;
        assert.equal(await page.locator('html').getAttribute('data-keyboard-open'),'true');assertions++;
        const keyboardCanvas=await page.locator('.note-canvas').boundingBox();
        assert.ok(keyboardCanvas.height>200&&keyboardCanvas.y+keyboardCanvas.height<=484);assertions++;
        assert.equal(await page.locator('.canvas-floating-ui:visible, .note-container-chrome:visible').count(),0);assertions++;
        await editor.press('End');
        await page.keyboard.insertText(' Keyboard edit.');
        await page.waitForFunction(()=>window.__savedNote?.contentJson.includes('Keyboard edit.'));assertions++;
        await page.screenshot({path:path.join(artifacts,'keyboard-android.png')});
        await page.setViewportSize({width,height});
        await page.evaluate(()=>{window.__LENOTA_KEYBOARD_OPEN__=false;window.dispatchEvent(new Event('lenota:keyboard'));});
        assert.equal(await page.locator('.mobile-bottom-nav').isVisible(),true);assertions++;
        // iOS keeps innerHeight but shrinks visualViewport; simulate only that
        // browser signal, rather than claiming an OS keyboard integration test.
        await page.evaluate(()=>{
          delete window.__LENOTA_KEYBOARD_OPEN__;
          Object.defineProperty(window.visualViewport,'height',{configurable:true,value:464});
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        assert.equal(await page.locator('.mobile-bottom-nav').isVisible(),false);assertions++;
        const iosCanvas=await page.locator('.note-canvas').boundingBox();
        assert.ok(iosCanvas.height>200&&iosCanvas.y+iosCanvas.height<=464);assertions++;
        await page.evaluate(()=>{delete window.visualViewport.height;window.visualViewport.dispatchEvent(new Event('resize'));});
        assert.equal(await page.locator('.mobile-bottom-nav').isVisible(),true);assertions++;
        for(const size of [{width:844,height:390},{width:1024,height:768},{width,height}]){
          await page.setViewportSize(size);
          await page.waitForFunction(compact=>document.querySelector('.app-shell')?.dataset.compactLayout===String(compact),size.width<900);
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);assertions++;
          const canvas=await page.locator('.note-canvas').boundingBox();
          assert.ok(canvas.height>100&&canvas.x>=0&&canvas.x+canvas.width<=size.width);assertions++;
          assert.equal(await page.locator('.normal-page-title').inputValue(),'Mobile autosave');assertions++;
          assert.ok((await page.evaluate(()=>window.__savedNote.contentJson)).includes('Keyboard edit.'));assertions++;
        }
        await page.getByRole('button',{name:'More',exact:true}).click();
        await page.getByRole('button',{name:/Switch to light theme/}).click();
        await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');assertions++;
        await page.screenshot({path:path.join(artifacts,'workspace-light-390.png')});
        await page.getByRole('button',{name:'More',exact:true}).click();
        await page.getByRole('button',{name:/Enter Focus Mode/}).click();
        await page.locator('.editor-shell.is-focus-mode').waitFor();
        const focusCanvas=await page.locator('.note-canvas').boundingBox();
        assert.ok(focusCanvas.width>=width*.95&&focusCanvas.height>200);assertions++;
        const focusBar=await page.locator('.editor-mode-bar').boundingBox();
        const focusText=await editor.boundingBox();
        assert.ok(focusText.y>=focusBar.y+focusBar.height,'Focus toolbar covers the document');assertions++;
        assert.equal(await page.locator('.focus-page-strip').isVisible(),false);assertions++;
        assert.equal(await page.getByRole('button',{name:'Exit Focus Mode',exact:true}).isVisible(),true);assertions++;
        await page.screenshot({path:path.join(artifacts,'focus-390.png')});
        assert.equal(await page.evaluate(()=>window.__LENOTA_BACK__()),true);assertions++;
        await page.locator('.editor-shell:not(.is-focus-mode)').waitFor();
      }
      await page.getByRole('button',{name:'Draw',exact:true}).click();
      await page.locator('.note-canvas:not(.is-mobile-document)').waitFor();
      const dock=page.locator('.mobile-drawing-dock');
      await dock.waitFor();
      assert.equal(await dock.getByRole('button',{name:'Pen',exact:true}).getAttribute('aria-pressed'),'true');assertions++;
      assert.equal(await page.locator('.topbar-editor-tools').isVisible(),false);assertions++;
      assert.equal(await page.locator('.mobile-bottom-nav').isVisible(),false);assertions++;
      for(const button of await dock.locator('button').all()){
        const box=await button.boundingBox();
        assert.ok(box.x>=0&&box.x+box.width<=width&&box.width>=44&&box.height>=44,`Drawing control outside screen or too small at ${width}px: ${JSON.stringify(box)}`);assertions++;
      }
      const session=await context.newCDPSession(page);
      const drawingBounds=await page.locator('.note-canvas').boundingBox();
      const dockBounds=await dock.boundingBox();
      if(width===844){assert.ok(dockBounds.height<=70,'Landscape drawing dock wastes vertical space');assertions++;}
      assert.ok(drawingBounds.y+drawingBounds.height<=dockBounds.y+1,`Dock covers drawing area at ${width}px`);assertions++;
      const center={x:width-24,y:drawingBounds.y+drawingBounds.height-30};
      const transform=()=>page.locator('.canvas-world').evaluate(el=>el.style.transform);
      const savedInk=()=>page.evaluate(()=>JSON.parse(window.__savedNote?.contentJson??'{}').ink??[]);
      const stroke=async(at=center)=>{
        await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:0,x:at.x-20,y:at.y-10}]});
        await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:0,x:at.x-50,y:at.y-30}]});
        await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      };
      // A passive pen reports touch: selecting Draw/Pen must write immediately.
      await page.screenshot({path:path.join(artifacts,`drawing-before-${width}.png`)});
      assert.equal(await page.locator('.canvas-floating-ui:visible').count(),0,'Stale selection blocks drawing');assertions++;
      const drawingBefore=await transform();
      const textBounds=await page.locator('.ProseMirror').first().boundingBox();
      await stroke({x:Math.min(width-24,textBounds.x+textBounds.width*.7),y:textBounds.y+Math.min(textBounds.height-10,48)});
      await page.waitForFunction(()=>JSON.parse(window.__savedNote?.contentJson??'{}').ink?.length===1);assertions++;
      assert.ok((await savedInk())[0].points.length>1);assertions++;
      assert.equal(await transform(),drawingBefore,'Pen moved the canvas');assertions++;
      await page.screenshot({path:path.join(artifacts,`drawing-${width}.png`)});
      await dock.getByRole('button',{name:'Pan',exact:true}).click();
      const before=await transform();
      await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:0,x:center.x,y:center.y}]});
      await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:0,x:center.x-45,y:center.y+25}]});
      await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForTimeout(100);
      assert.notEqual(await transform(),before,`One-finger pan failed at ${width}px`);assertions++;
      assert.equal((await savedInk()).length,1,'Pan created ink');assertions++;
      await dock.getByRole('button',{name:'Pen',exact:true}).click();
      const penAgain=await transform();
      await stroke();
      await page.waitForFunction(()=>JSON.parse(window.__savedNote?.contentJson??'{}').ink?.length===2);assertions++;
      assert.equal(await transform(),penAgain,'Pen kept panning after Pan');assertions++;
      // Two-finger navigation must also work while Pen is selected, without
      // committing the first contact as a stray dot or an undo history entry.
      const pinchBefore=await transform();
      await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:0,x:100,y:center.y},{id:1,x:200,y:center.y}]});
      await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:0,x:75,y:center.y},{id:1,x:225,y:center.y}]});
      await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForTimeout(800);
      assert.notEqual(await transform(),pinchBefore,`Pinch failed at ${width}px`);assertions++;
      assert.equal((await savedInk()).length,2,'Pinch left stray ink');assertions++;
      await dock.getByRole('button',{name:'Undo canvas change',exact:true}).click();
      await page.waitForFunction(()=>JSON.parse(window.__savedNote?.contentJson??'{}').ink?.length===1);assertions++;
      await dock.getByRole('button',{name:'Redo canvas change',exact:true}).click();
      await page.waitForFunction(()=>JSON.parse(window.__savedNote?.contentJson??'{}').ink?.length===2);assertions++;
      await dock.getByRole('button',{name:'Marker',exact:true}).click();
      await stroke();
      await page.waitForFunction(()=>JSON.parse(window.__savedNote?.contentJson??'{}').ink?.length===3);assertions++;
      assert.equal((await savedInk()).at(-1).tool,'highlighter');assertions++;
      await dock.getByRole('button',{name:'Eraser',exact:true}).click();
      await stroke();
      await page.waitForFunction(()=>JSON.parse(window.__savedNote?.contentJson??'{}').ink?.length===2);assertions++;
      await dock.getByRole('button',{name:'More drawing tools',exact:true}).click();
      await page.locator('.topbar-editor-tools').waitFor();assertions++;
      await dock.getByRole('button',{name:'More drawing tools',exact:true}).click();
      await page.locator('.topbar-editor-tools').waitFor({state:'hidden'});
      await page.getByTitle('More commands').click();
      await page.getByPlaceholder('Type a command…').waitFor();
      const dialog=await page.getByPlaceholder('Type a command…').boundingBox();
      assert.ok(dialog.x>=0&&dialog.x+dialog.width<=width,`Commands outside screen at ${width}px`);assertions++;
      await page.screenshot({path:path.join(artifacts,`commands-${width}.png`)});
      assert.equal(await page.evaluate(()=>window.__LENOTA_BACK__()),true);assertions++;
      await page.getByPlaceholder('Type a command…').waitFor({state:'hidden'});
      if(width===390){
        await dock.getByRole('button',{name:'Pen',exact:true}).click();
        await page.getByTitle('More commands').click();
        await page.getByRole('button',{name:/Enter Focus Mode/}).click();
        await page.locator('.editor-shell.is-focus-mode').waitFor();
        const focusDrawing=await page.locator('.note-canvas').boundingBox();
        const focusDock=await dock.boundingBox();
        assert.ok(focusDrawing.height>200&&focusDrawing.y+focusDrawing.height<=focusDock.y+1,'Focus dock covers the canvas');assertions++;
        assert.equal(await dock.getByRole('button',{name:'Exit Focus Mode',exact:true}).isVisible(),true);assertions++;
        assert.equal(await page.locator('.canvas-zoom-controls').isVisible(),false,'Duplicate zoom controls remain in Focus Mode');assertions++;
        await stroke();
        await page.waitForFunction(()=>JSON.parse(window.__savedNote?.contentJson??'{}').ink?.length===3);assertions++;
        await page.screenshot({path:path.join(artifacts,'drawing-focus-390.png')});
        await dock.getByRole('button',{name:'Exit Focus Mode',exact:true}).click();
        await page.locator('.editor-shell:not(.is-focus-mode)').waitFor();
      }
    }
    assert.deepEqual(errors,[],`Runtime errors after interactions at ${width}px`);assertions++;
    console.log(`✓ ${width}×${height}: layout, navigation${width<900?', autosave, Pen/Marker/Eraser, pan, pinch, commands':''}`);
    await context.close();
  }
  console.log(`Passed ${assertions} browser assertions.`);
} finally {await browser.close();}
