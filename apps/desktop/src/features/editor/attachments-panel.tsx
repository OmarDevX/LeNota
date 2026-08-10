import { File, FolderOpen, Paperclip, Trash2, X } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { Attachment } from "@/types/domain";

interface Props {
  attachments: Attachment[];
  loading: boolean;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function AttachmentsPanel({ attachments, loading, onAdd, onRemove, onClose }: Props) {
  return (
    <aside className="absolute right-4 top-16 z-30 flex max-h-[calc(100vh-5rem)] w-[360px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1b1b1f]/98 shadow-2xl backdrop-blur">
      <header className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <div className="flex items-center gap-2 font-medium"><Paperclip className="size-4" /> Attachments</div>
        <button className="rounded p-1 text-neutral-400 hover:bg-white/8 hover:text-white" onClick={onClose}><X className="size-4" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {loading ? <div className="p-4 text-sm text-neutral-500">Loading…</div> : null}
        {!loading && attachments.length === 0 ? <div className="p-6 text-center text-sm text-neutral-500">No attachments on this page.</div> : null}
        {attachments.map((item) => (
          <div key={item.id} className="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/6">
            <File className="size-5 shrink-0 text-violet-300" />
            <button className="min-w-0 flex-1 text-left" onClick={() => void openPath(item.storedPath)}>
              <div className="truncate text-sm text-neutral-200">{item.fileName}</div>
              <div className="text-[11px] text-neutral-500">{sizeLabel(item.sizeBytes)} · {item.mimeType}</div>
            </button>
            <button className="rounded p-1.5 text-neutral-500 opacity-0 hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100" title="Remove attachment" onClick={() => onRemove(item.id)}><Trash2 className="size-4" /></button>
          </div>
        ))}
      </div>
      <footer className="border-t border-white/8 p-3">
        <button className="flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium hover:bg-violet-500" onClick={onAdd}><FolderOpen className="size-4" /> Add files</button>
      </footer>
    </aside>
  );
}
