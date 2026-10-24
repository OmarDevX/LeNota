import { DatabaseBackup, HardDrive, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BackupInfo } from "@/types/domain";

interface BackupsDialogProps {
  backups: BackupInfo[];
  loading: boolean;
  creating: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onCreateBackup: () => void;
}

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function readableDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function BackupsDialog({
  backups,
  loading,
  creating,
  onClose,
  onRefresh,
  onCreateBackup,
}: BackupsDialogProps) {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/55 p-6 backdrop-blur-sm">
      <section
        aria-label="Backups"
        aria-modal="true"
        role="dialog"
        className="flex max-h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1d1d21] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-white/8 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Local backups</h2>
            <p className="mt-1 text-xs text-neutral-500">
              A consistent SQLite snapshot is created automatically at most once per day.
            </p>
          </div>
          <Button aria-label="Close backups" size="icon" variant="ghost" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="grid min-h-48 place-items-center text-sm text-neutral-500">Loading backups…</div>
          ) : backups.length === 0 ? (
            <div className="grid min-h-48 place-items-center text-center text-sm text-neutral-500">
              <div>
                <DatabaseBackup className="mx-auto mb-3 size-8 text-neutral-700" />
                No backups have been created yet.
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {backups.map((backup) => (
                <div
                  key={backup.path}
                  className="flex items-start gap-3 rounded-lg border border-white/8 bg-white/[0.025] px-3 py-3"
                >
                  <div className="grid size-9 shrink-0 place-items-center rounded-md bg-white/6 text-neutral-400">
                    <HardDrive className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-neutral-100">{backup.fileName}</div>
                    <div className="mt-1 text-xs text-neutral-500">
                      {readableDate(backup.createdAt)} · {readableSize(backup.sizeBytes)}
                    </div>
                    <div className="ui-selectable mt-1 truncate text-[11px] text-neutral-600" title={backup.path}>
                      {backup.path}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-white/8 px-5 py-3">
          <Button variant="ghost" onClick={onRefresh}>Refresh</Button>
          <Button disabled={creating} onClick={onCreateBackup}>
            <Plus className="size-4" /> {creating ? "Creating…" : "Create backup"}
          </Button>
        </footer>
      </section>
    </div>
  );
}
