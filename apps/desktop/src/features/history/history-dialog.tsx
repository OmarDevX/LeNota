import { History, RotateCcw, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PageRevision } from "@/types/domain";

interface HistoryDialogProps {
  revisions: PageRevision[];
  loading: boolean;
  creating: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onCreateSnapshot: () => void;
  onRestore: (revisionId: string) => void;
}

function readableDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function HistoryDialog({
  revisions,
  loading,
  creating,
  onClose,
  onRefresh,
  onCreateSnapshot,
  onRestore,
}: HistoryDialogProps) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6 backdrop-blur-sm">
      <section
        aria-label="Page versions"
        aria-modal="true"
        role="dialog"
        className="flex max-h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1d1d21] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-white/8 px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              <History className="size-5 text-violet-300" /> Page versions
            </h2>
            <p className="mt-1 text-xs text-neutral-500">Autosave creates periodic versions. Manual snapshots are kept too.</p>
          </div>
          <Button aria-label="Close page versions" size="icon" variant="ghost" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="grid min-h-48 place-items-center text-sm text-neutral-500">Loading versions…</div>
          ) : revisions.length === 0 ? (
            <div className="grid min-h-48 place-items-center text-center text-sm text-neutral-500">
              No versions yet. Save a snapshot or continue editing.
            </div>
          ) : (
            <div className="space-y-2">
              {revisions.map((revision) => (
                <div key={revision.id} className="flex items-center gap-3 rounded-lg border border-white/8 bg-white/[0.025] p-3">
                  <div className="grid size-9 shrink-0 place-items-center rounded-md bg-white/6 text-neutral-400">
                    <History className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-neutral-100">{revision.title.trim() || "Untitled page"}</div>
                    <div className="mt-1 line-clamp-1 text-xs text-neutral-500">{revision.preview || "Empty page"}</div>
                    <div className="mt-1 text-[11px] text-neutral-600">{readableDate(revision.createdAt)}</div>
                  </div>
                  <Button variant="outline" onClick={() => onRestore(revision.id)}>
                    <RotateCcw className="size-4" /> Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-between border-t border-white/8 px-5 py-3">
          <Button variant="ghost" onClick={onRefresh}>Refresh</Button>
          <Button disabled={creating} onClick={onCreateSnapshot}>
            <Save className="size-4" /> {creating ? "Saving…" : "Save snapshot"}
          </Button>
        </footer>
      </section>
    </div>
  );
}
