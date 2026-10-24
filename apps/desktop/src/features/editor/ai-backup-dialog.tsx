import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { notesApi } from "@/lib/tauri-api";

export function AiBackupDialog({onClose,onConfigured,onManageContext}:{onClose:()=>void;onConfigured:()=>void;onManageContext?:()=>void}) {
  const [chatgpt,setChatgpt] = useState({connected:false,email:""});
  const [openrouter,setOpenrouter] = useState("");
  const [openaiImages,setOpenaiImages] = useState("");
  const [status,setStatus] = useState({openrouterConfigured:false,openaiImagesConfigured:false});
  const [removeOpenrouter,setRemoveOpenrouter] = useState(false);
  const [removeOpenaiImages,setRemoveOpenaiImages] = useState(false);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const desktop = (window as Window & {__LENOTA_PLATFORM__?:string}).__LENOTA_PLATFORM__ !== "android" && (window as Window & {__LENOTA_PLATFORM__?:string}).__LENOTA_PLATFORM__ !== "ios";
  useEffect(()=>{
    let active=true;
    const focused=document.activeElement as HTMLElement|null;
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    void notesApi.aiBackupStatus().then(value=>{if(active)setStatus(value);}).catch(error=>{if(active)setMessage(String(error));});
    if(desktop) void notesApi.chatgptStatus().then(value=>{if(active)setChatgpt(value);}).catch(error=>{if(active)setMessage(String(error));});
    return()=>{active=false;focused?.focus();};
  },[desktop]);
  const connect=async()=>{
    setBusy(true);setMessage("Complete the official authorization in your browser (up to 3 minutes)…");
    try {
      const value=await notesApi.chatgptConnect();
      setChatgpt(value);setMessage("ChatGPT connected. It is now your first AI provider.");onConfigured();
    } catch(error) {setMessage(error instanceof Error?error.message:String(error));}
    finally{setBusy(false);}
  };
  const disconnect=async()=>{
    setBusy(true);setMessage("");
    try {
      const value=await notesApi.chatgptDisconnect();
      setChatgpt({connected:false,email:""});
      setMessage(value.remoteRevoked ? "ChatGPT disconnected and session revoked." : "ChatGPT removed locally. Check ChatGPT Settings to revoke it remotely if necessary.");onConfigured();
    }catch(error){setMessage(error instanceof Error?error.message:String(error));}
    finally{setBusy(false);}
  };
  const save=async()=>{
    setBusy(true);setMessage("");
    try{
      setStatus(await notesApi.configureAiBackups(openrouter.trim()||null,removeOpenrouter,openaiImages.trim()||null,removeOpenaiImages));
      setOpenrouter("");setRemoveOpenrouter(false);setOpenaiImages("");setRemoveOpenaiImages(false);
      setMessage("AI provider keys saved.");onConfigured();
    }catch(error){setMessage(error instanceof Error?error.message:String(error));}
    finally{setBusy(false);}
  };
  const test=async()=>{
    setBusy(true);setMessage("Testing OpenRouter's selected free model…");
    try{
      const result=await notesApi.testAiBackup("openrouter");
      setMessage(`Connected: ${result.engine}. Answer received.`);
    }catch(error){setMessage(error instanceof Error?error.message:String(error));}
    finally{setBusy(false);}
  };
  return createPortal(<div className="fixed inset-0 z-[2000000] flex items-center justify-center bg-black/60 p-3" onPointerDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="AI providers" className="ui-selectable ai-providers-dialog max-h-[85dvh] w-full overflow-auto rounded-xl border border-white/15 bg-[#202126] p-5 text-sm text-neutral-100 shadow-2xl" onKeyDown={event=>{
      if(event.key==="Escape"){event.stopPropagation();onClose();}
      if(event.key==="Tab"){
        const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),a[href]")??[]);
        const first=items[0],last=items.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }}>
      <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">AI providers</h2><button type="button" aria-label="Close AI providers" onClick={onClose} className="rounded p-2 hover:bg-white/10">✕</button></div>
      {onManageContext&&<button type="button" onClick={onManageContext} className="mb-3 rounded-lg border border-violet-400/30 px-3 py-2 text-xs text-violet-200 hover:bg-violet-500/10">AI context · developer options</button>}
      <p className="mb-4 text-neutral-300">Priority: <strong>1. ChatGPT Plus</strong> → <strong>2. Gemini</strong> → <strong>3. OpenRouter</strong>. A failed provider automatically falls back. No Groq.</p>
      <section className="rounded-lg border border-violet-500/40 bg-violet-500/10 p-3">
        <h3 className="font-semibold">1. ChatGPT Plus · preferred</h3>
        {desktop ? <><p className="my-2 text-neutral-300">{chatgpt.connected ? `Connected${chatgpt.email ? " as " + chatgpt.email : ""}. LeNota will try ChatGPT first.` : "Uses official ChatGPT plan access for supported text requests, without extra API billing. Image generation is NOT supported by this login."}</p>
          <button disabled={busy} type="button" onClick={()=>void (chatgpt.connected?disconnect():connect())} className="rounded bg-violet-600 px-3 py-2 disabled:opacity-50">{chatgpt.connected?"Disconnect ChatGPT":"Continue with ChatGPT"}</button>
        </> : <p className="my-2 text-amber-200">ChatGPT sign-in is currently supported on desktop only. Mobile uses Gemini → OpenRouter.</p>}
      </section>
      {desktop && <p className="mt-3 text-xs text-neutral-300">On desktop, type <code>/ask create a detailed image of the heart</code>, or use <strong>Ask selection</strong> and request an image based on the selected region. LeNota automatically recognizes image-generation requests; <code>/image</code> remains optional. All these image requests now produce SVG previews via your normal text AI provider, without separate image API fees. Only the explicit /raster command below uses a paid image API. Normal <code>/ask</code> questions still use the usual providers.</p>}
      {desktop&&<section className="mt-4 rounded-lg border border-cyan-400/30 p-3">
        <h3 className="font-semibold">Optional OpenAI Images API · paid raster pictures</h3>
        <p className="mt-2 text-xs text-neutral-300">ChatGPT sign-in cannot use image generation in third-party apps. The default <code>/image</code>, <code>/ask create an image…</code> and Ask Selection generate SVG vector illustrations for no additional API charge. If you expressly want a PNG, configure a separate OpenAI API key and type <code>/raster your prompt</code>. <strong>These requests use API billing, not your ChatGPT Plus allowance.</strong> Ordinary questions and animated SVG diagrams do not require this key.</p>
        <label className="mt-2 block">OpenAI API key {status.openaiImagesConfigured&&<span className="text-emerald-300">· saved</span>}
          <input type="password" autoComplete="off" aria-label="OpenAI image API key" value={openaiImages} onChange={event=>setOpenaiImages(event.target.value)} placeholder={status.openaiImagesConfigured?"Leave blank to keep saved key":"sk-…"} className="mt-1 w-full rounded border border-white/15 bg-black/20 p-2"/>
        </label>
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" onClick={event=>{event.preventDefault();void openUrl(event.currentTarget.href).catch(()=>setMessage("Open the displayed link in your browser."));}} className="text-cyan-300 underline">Create an OpenAI API key</a>
        {status.openaiImagesConfigured&&<label className="my-2 flex gap-2"><input type="checkbox" checked={removeOpenaiImages} onChange={event=>setRemoveOpenaiImages(event.target.checked)}/>Remove saved image API key</label>}
        <p className="mt-2 text-xs text-neutral-400">Image generation uses gpt-image-2.5-flare. Only explicit /raster requests use this paid image API; other image requests never use it. API access, budget and project permissions are controlled by OpenAI.</p>
      </section>}
      <section className="mt-4"><h3 className="font-semibold">2. Gemini · backup</h3><p className="text-xs text-neutral-300">Keep your existing Gemini key in the Cloud AI settings. LeNota will use it only after ChatGPT is unavailable.</p></section>
      <section className="mt-4"><h3 className="font-semibold">3. OpenRouter · final backup</h3>
        <label className="mt-2 block">OpenRouter API key {status.openrouterConfigured&&<span className="text-emerald-300">· saved</span>}
          <input type="password" autoComplete="off" aria-label="OpenRouter API key" value={openrouter} onChange={event=>setOpenrouter(event.target.value)} placeholder={status.openrouterConfigured?"Leave blank to keep saved key":"sk-or-…"} className="mt-1 w-full rounded border border-white/15 bg-black/20 p-2"/>
        </label>
        <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" onClick={event=>{event.preventDefault();void openUrl(event.currentTarget.href).catch(()=>setMessage("Open the displayed link in your browser."));}} className="text-cyan-300 underline">Get OpenRouter key</a>
        {status.openrouterConfigured&&<label className="my-2 flex gap-2"><input type="checkbox" checked={removeOpenrouter} onChange={event=>setRemoveOpenrouter(event.target.checked)}/>Remove saved OpenRouter key</label>}
        <p className="mt-2 text-xs text-neutral-400">Uses selected free models: NVIDIA Nemotron 3 Ultra/Super for text, Qwen3.8/Gemma 4 for images. Zero-price routing enforced; availability and free quotas may change.</p>
      </section>
      <p className="mt-4 text-xs text-neutral-400">For each request, the selected provider receives the question, only the page context you choose in AI context, and the selection image when included. ChatGPT plan sharing requires separate consent and can be revoked in ChatGPT settings.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={()=>void save()} className="rounded bg-violet-600 px-3 py-2 disabled:opacity-50">Save AI keys</button>
        <button type="button" disabled={busy||!status.openrouterConfigured} onClick={()=>void test()} className="rounded border border-white/15 px-3 py-2 disabled:opacity-50">Test OpenRouter</button>
      </div>
      {message&&<p role="status" className="mt-3 break-words text-xs text-cyan-200">{message}</p>}
    </div>
  </div>,document.body);
}
