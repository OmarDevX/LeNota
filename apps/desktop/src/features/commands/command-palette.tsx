import { useEffect, useMemo, useState } from "react";
import { Command, Search, X } from "lucide-react";

export interface AppCommand {
  id: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

export function CommandPalette({ commands, onClose }: { commands: AppCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => commands.filter((command) => command.label.toLowerCase().includes(query.toLowerCase())),
    [commands, query],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/45 pt-[12vh]" onMouseDown={onClose}>
      <div className="w-[620px] overflow-hidden rounded-xl border border-white/10 bg-[#202024] shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-white/8 px-4">
          <Search className="size-4 text-neutral-500" />
          <input autoFocus className="h-13 min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder="Type a command…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button onClick={onClose}><X className="size-4 text-neutral-500" /></button>
        </div>
        <div className="max-h-[55vh] overflow-auto p-2">
          {filtered.map((command) => (
            <button key={command.id} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-white/7" onClick={() => { onClose(); command.run(); }}>
              <Command className="size-4 text-violet-300" />
              <span className="flex-1">{command.label}</span>
              {command.shortcut ? <kbd className="rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-[10px] text-neutral-500">{command.shortcut}</kbd> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
