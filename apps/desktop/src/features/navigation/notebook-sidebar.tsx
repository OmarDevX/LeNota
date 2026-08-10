import {
  Clock3,
  FileText,
  Pencil,
  Search,
  Settings,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NotebookNode } from "@/types/domain";

interface NotebookSidebarProps {
  notebooks: NotebookNode[];
  selectedNotebookId: string | null;
  onSelectNotebook: (id: string) => void;
  onCreateNotebook: () => void;
  onRenameNotebook: () => void;
  onSetNotebookColor: (color: string) => void;
  onTrashNotebook: () => void;
  onOpenSearch: () => void;
  onOpenRecent: () => void;
  onOpenFavorites: () => void;
  onOpenTrash: () => void;
  onOpenBackups: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
}

export function NotebookSidebar({
  onOpenSearch,
  onOpenRecent,
  onOpenFavorites,
  onOpenTrash,
  onOpenBackups,
}: NotebookSidebarProps) {
  return (
    <aside className="app-rail no-print flex min-w-0 overflow-hidden flex-col items-center border-r border-white/8 bg-[#111217]">
      <div className="rail-logo grid shrink-0 place-items-center" title="LeNota">
        <span className="rail-logo-mark">L</span>
      </div>

      <nav className="rail-shortcuts flex w-full flex-col items-center" aria-label="Workspace shortcuts">
        <div className="rail-icon is-active" aria-label="Notes" title="Notes"><Pencil className="size-[22px]" /></div>
        <Button className="rail-icon" aria-label="Search" title="Search · Ctrl+K" size="icon" variant="ghost" onClick={onOpenSearch}><Search className="size-[22px]" /></Button>
        <Button className="rail-icon" aria-label="Quick notes" title="Quick notes" size="icon" variant="ghost" onClick={onOpenRecent}><FileText className="size-[21px]" /></Button>
        <Button className="rail-icon" aria-label="Favorites" title="Favorites" size="icon" variant="ghost" onClick={onOpenFavorites}><Star className="size-[21px]" /></Button>
        <Button className="rail-icon" aria-label="Recent pages" title="Recent pages" size="icon" variant="ghost" onClick={onOpenRecent}><Clock3 className="size-[21px]" /></Button>
        <Button className="rail-icon" aria-label="Tags" title="Search tags" size="icon" variant="ghost" onClick={onOpenSearch}><Tag className="size-[21px]" /></Button>
        <Button className="rail-icon" aria-label="Trash" title="Trash" size="icon" variant="ghost" onClick={onOpenTrash}><Trash2 className="size-[21px]" /></Button>
      </nav>

      <div className="rail-bottom mt-auto flex w-full flex-col items-center">
        <Button className="rail-icon" aria-label="Settings and backups" title="Settings and backups" size="icon" variant="ghost" onClick={onOpenBackups}><Settings className="size-[21px]" /></Button>
        <div className="rail-avatar" aria-label="LeNota profile">L</div>
      </div>
    </aside>
  );
}
