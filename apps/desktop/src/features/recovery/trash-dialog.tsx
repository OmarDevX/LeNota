import { ArchiveRestore, FileText, Folder, Notebook, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TrashEntry, TrashEntityType } from "@/types/domain";

interface TrashDialogProps {
  entries: TrashEntry[];
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onRestore: (id: string) => void;
  onDeleteForever: (id: string) => void;
  onEmptyTrash: () => void;
}

function entityIcon(entityType: TrashEntityType) {
  if (entityType === "notebook") return <Notebook className="size-4" />;
  if (entityType === "section") return <Folder className="size-4" />;
  return <FileText className="size-4" />;
}

function readableDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function TrashDialog({
  entries,
  loading,
  onClose,
  onRefresh,
  onRestore,
  onDeleteForever,
  onEmptyTrash,
}: TrashDialogProps) {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/55 p-6 backdrop-blur-sm">
      <section
        aria-label="Trash"
        aria-modal="true"
        role="dialog"
        className="flex max-h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1d1d21] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-white/8 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Trash</h2>
            <p className="mt-1 text-xs text-neutral-500">Deleted items remain recoverable until removed forever.</p>
          </div>
          <Button aria-label="Close trash" size="icon" variant="ghost" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="grid min-h-48 place-items-center text-sm text-neutral-500">Loading trash…</div>
          ) : entries.length === 0 ? (
            <div className="grid min-h-48 place-items-center text-center text-sm text-neutral-500">
              <div>
                <Trash2 className="mx-auto mb-3 size-8 text-neutral-700" />
                Trash is empty.
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 rounded-lg border border-white/8 bg-white/[0.025] px-3 py-3"
                >
                  <div className="grid size-9 shrink-0 place-items-center rounded-md bg-white/6 text-neutral-400">
                    {entityIcon(entry.entityType)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-neutral-100">
                      {entry.title.trim() || "Untitled page"}
                    </div>
                    <div className="mt-1 truncate text-xs text-neutral-500">
                      {entry.entityType}
                      {entry.parentTitle ? ` · ${entry.parentTitle}` : ""}
                      {` · ${readableDate(entry.deletedAt)}`}
                    </div>
                  </div>
                  <Button variant="outline" onClick={() => onRestore(entry.id)}>
                    <ArchiveRestore className="size-4" /> Restore
                  </Button>
                  <Button
                    aria-label={`Delete ${entry.title} forever`}
                    size="icon"
                    variant="ghost"
                    onClick={() => onDeleteForever(entry.id)}
                  >
                    <Trash2 className="size-4 text-red-400" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-white/8 px-5 py-3">
          <Button variant="ghost" onClick={onRefresh}>Refresh</Button>
          <Button
            className="bg-red-600 hover:bg-red-500"
            disabled={entries.length === 0}
            onClick={onEmptyTrash}
          >
            <Trash2 className="size-4" /> Empty trash
          </Button>
        </footer>
      </section>
    </div>
  );
}
