import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clipboard, X } from "lucide-react";
import type { PageAiMemoryEntry, PageContextContainer } from "./page-ai-context";
import type { InkPoint } from "./pen-input";
import { routeAskImageRequest } from "./cloud-ai-content";
import {
  AI_CONTEXT_MAX_CHARACTERS, AI_PROMPT_MAX_CHARACTERS,
  buildScopedAiContext, type AiContextOptions, type AiContextScope,
} from "./ai-context-policy";

export type AiContextDraft = {
  kind: "ask" | "visual" | "settings";
  prompt: string;
  anchorId?: string;
  selectionBytes?: number[];
  polygon?: InkPoint[];
  captureBounds?: {left:number;right:number;top:number;bottom:number;width:number;height:number};
  range?: {from:number;to:number};
};

export type AiContextRequest = {
  prompt: string;
  context: string;
  chosenIds: string[];
  scope: AiContextScope;
};

export function AiContextDialog({ draft, title, containers, memory, selectedIds, options, onOptionsChange, onChosenIdsChange, onSend, onClose }: {
  draft: AiContextDraft;
  title: string;
  containers: PageContextContainer[];
  memory: PageAiMemoryEntry[];
  selectedIds: string[];
  options: AiContextOptions;
  onOptionsChange: (value: AiContextOptions) => void;
  onChosenIdsChange: (value: string[]) => void;
  onSend: (value: AiContextRequest) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const promptId = useId();
  const contextId = useId();
  const [scope, setScope] = useState<AiContextScope>(draft.kind === "visual" && options.scope === "note" ? "none" : options.scope);
  const [history, setHistory] = useState(options.includeHistory);
  const [review, setReview] = useState(options.reviewBeforeSend);
  const [chosenIds, setChosenIds] = useState<string[]>(selectedIds);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [manualEdited, setManualEdited] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const settings = draft.kind === "settings";
  const preview = useMemo(() => buildScopedAiContext({
    title, containers, memory, scope,
    anchorId: draft.anchorId,
    chosenIds,
    includeHistory: history,
    question: draft.prompt,
  }), [title, containers, memory, scope, draft.anchorId, chosenIds, history, draft.prompt]);
  const [context, setContext] = useState(preview.context);
  useEffect(() => { if (!manualEdited) setContext(preview.context); }, [preview.context, manualEdited]);
  useEffect(() => {
    if (!draft.selectionBytes?.length) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(draft.selectionBytes)], { type: "image/png" }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [draft.selectionBytes]);
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLElement>(settings ? "select" : "textarea")?.focus();
    return () => { document.body.style.overflow = originalOverflow; focused?.focus(); };
  }, [settings]);

  const changeScope = (value: AiContextScope) => { setScope(value); setManualEdited(false); };
  const saveOptions = () => onOptionsChange({
    // A screenshot-only request should not accidentally change the default for /ask.
    scope: draft.kind === "visual" && options.scope === "note" && scope === "none" ? "note" : scope,
    includeHistory: history, reviewBeforeSend: review,
  });
  const contextBytes = new TextEncoder().encode(context).byteLength;
  const imageRequest = routeAskImageRequest(prompt).startsWith("/image ");
  const promptBytes = new TextEncoder().encode(prompt).byteLength;
  const valid = prompt.trim().length > 0 && !prompt.includes("\0") && !context.includes("\0") && promptBytes <= AI_PROMPT_MAX_CHARACTERS &&
    context.length <= AI_CONTEXT_MAX_CHARACTERS && contextBytes <= 160_000 && (scope !== "chosen" || chosenIds.length > 0 || manualEdited) &&
    (draft.kind !== "visual" || Boolean(draft.selectionBytes?.length));
  const ordered = [...containers].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const markNotes=(ids:string[])=>{setChosenIds(ids);onChosenIdsChange(ids);setManualEdited(false);};
  return createPortal(<div className="fixed inset-0 z-[2000010] flex items-center justify-center bg-black/75 p-2 sm:p-4" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="AI context and request preview" className="ui-selectable ai-context-dialog flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-xl border border-violet-400/30 bg-[#202126] text-sm text-neutral-100 shadow-2xl" onKeyDown={e => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)") ?? []);
        if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes.at(-1)?.focus(); }
        else if (!e.shiftKey && document.activeElement === nodes.at(-1)) { e.preventDefault(); nodes[0]?.focus(); }
      }
    }}>
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
        <div><h2 className="text-base font-semibold">AI context <span className="text-xs font-normal text-violet-300">Developer options</span></h2>
          <p className="mt-1 text-xs text-neutral-400">Review the outgoing question and choose page context.</p></div>
        <button type="button" aria-label="Close AI context" title="Close" onClick={onClose} className="rounded p-2 hover:bg-white/10"><X size={17}/></button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <div className="flex flex-wrap gap-3">
          <label className="min-w-48 flex-1 text-xs">Context scope
            <select aria-label="AI context scope" value={scope} onChange={e=>changeScope(e.target.value as AiContextScope)} className="mt-1 w-full rounded-md border border-white/20 bg-[#17181e] p-2 text-sm">
              <option value="note">Only note containing /ask</option>
              <option value="chosen">Checked notes on canvas</option>
              <option value="page">Entire page (all notes)</option>
              <option value="none">No page context</option>
            </select>
          </label>
          <div className="flex flex-col gap-2 self-end pb-1 text-xs">
            <label className="flex items-center gap-2"><input type="checkbox" checked={history} onChange={e=>{setHistory(e.target.checked);setManualEdited(false);}}/> Include earlier AI exchanges</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={review} onChange={e=>setReview(e.target.checked)}/> Review each request before sending</label>
          </div>
        </div>
        {settings && <p className="rounded-md border border-violet-400/20 bg-violet-400/5 p-2 text-xs text-neutral-300">Mark notes using the ✓ button on each canvas note. This dialog changes the default scope; request review lets you edit the final prompt and context.</p>}
        {scope === "chosen" && <section aria-label="AI context checked notes" className="rounded-lg border border-violet-400/20 bg-violet-400/5 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span><strong>{chosenIds.length} of {ordered.length} notes checked</strong> for AI context</span>
            <div className="flex items-center gap-3">
              <button type="button" onClick={()=>markNotes(ordered.map(note=>note.id))} className="text-cyan-300">Check all</button>
              <button type="button" onClick={()=>markNotes([])} className="text-cyan-300">Clear checks</button>
            </div>
          </div>
          <p className="mt-1 text-neutral-400">To choose individual notes, close this window and click the ✓ icon beside the link, duplicate and delete buttons on each note. Purple means included. Reopen AI context to review exactly what will be sent.</p>
          {chosenIds.length===0 && !manualEdited && <p className="mt-2 text-amber-300">No notes checked. Check at least one note on the canvas, or select “No page context”.</p>}
        </section>}
        {!settings && <label htmlFor={promptId} className="block text-xs">Question sent to AI
          <textarea id={promptId} aria-label="Outgoing AI question" rows={2} value={prompt} onChange={e=>setPrompt(e.target.value)} maxLength={AI_PROMPT_MAX_CHARACTERS} className="mt-1 w-full resize-y rounded-lg border border-white/20 bg-[#15161b] p-3 text-sm leading-relaxed text-white"/>
        </label>}
        {!settings && imageRequest && <p role="status" className="text-xs text-cyan-200">Image request detected. LeNota will generate a rendered SVG illustration using your existing text AI provider, with no separate image API billing{draft.kind === "visual" ? ", with your selected region as a visual reference" : ""}. No /image command is needed.</p>}
        {draft.kind === "visual" && <section className="rounded-lg border border-violet-400/20 p-2 text-xs">
          <strong>Selected image sent as an attachment</strong><p className="mt-1 text-neutral-400">This exact captured PNG is also sent. It is separate from the editable text below.</p>
          {imageUrl && <img src={imageUrl} alt="Preview of the exact selected page image sent to AI" className="mt-2 max-h-44 max-w-full rounded border border-white/10 object-contain"/>}
        </section>}
        <label htmlFor={contextId} className="block text-xs">Outgoing page context (editable){settings && <span className="ml-2 text-neutral-400">example preview; no request is sent</span>}
          <textarea id={contextId} aria-label="Outgoing AI page context" rows={9} value={context} onChange={e=>{setContext(e.target.value);setManualEdited(true);}} disabled={settings} spellCheck={false} className="mt-1 w-full resize-y rounded-lg border border-white/20 bg-[#15161b] p-3 font-mono text-xs leading-relaxed text-neutral-100 disabled:opacity-60" placeholder="No page context. Only your question will be sent."/>
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-400">
          <span>{context.length.toLocaleString()} characters of page context · {preview.containerCount} note(s) · ~{Math.ceil((context.length+prompt.length)/4).toLocaleString()} estimated text tokens</span>
          <div className="flex gap-3"><button type="button" onClick={()=>{setContext(preview.context);setManualEdited(false);}} className="text-cyan-300">Reset preview</button><button type="button" onClick={()=>void navigator.clipboard?.writeText(`QUESTION\n${prompt}\n\nPAGE CONTEXT\n${context}`).catch(()=>{})} className="flex items-center gap-1 text-cyan-300"><Clipboard size={12}/>Copy text</button></div>
        </div>
        {preview.truncated && !manualEdited && <p className="text-xs text-amber-300">Context exceeded the 120,000-character safety limit and was truncated. Choose fewer notes for reliable answers.</p>}
        {(context.length>AI_CONTEXT_MAX_CHARACTERS || contextBytes>160_000) && <p className="text-xs text-red-300">Context exceeds the 120,000-character / 160 KB native limit. Shorten it before sending.</p>}
        {promptBytes>AI_PROMPT_MAX_CHARACTERS && <p className="text-xs text-red-300">Question exceeds the 20 KB native limit.</p>}
        <p className="text-[11px] text-neutral-400">Preview shows your question and the selected page context, plus the captured PNG when present. Clear image requests are tagged internally for image generation. The native AI worker adds the fixed instructions; provider credentials are never shown here. Only selected content is submitted when you confirm.</p>
      </div>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-white/10 p-3">
        <button type="button" onClick={onClose} className="rounded-md border border-white/20 px-4 py-2 text-sm hover:bg-white/10">Cancel</button>
        {settings ? <button type="button" onClick={()=>{saveOptions();onClose();}} className="rounded-md bg-violet-600 px-4 py-2 text-sm hover:bg-violet-500">Save defaults</button> :
          <button type="button" disabled={!valid} onClick={()=>{saveOptions();onSend({prompt:prompt.trim(),context,chosenIds,scope});}} className="rounded-md bg-violet-600 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40">Send to AI</button>}
      </footer>
    </div>
  </div>,document.body);
}
