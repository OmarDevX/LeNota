import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Copy,
  Clock3,
  DatabaseBackup,
  FileText,
  FolderTree,
  Home,
  IndentDecrease,
  IndentIncrease,
  LayoutTemplate,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NotebookNode, PageSummary, SectionGroupNode, SectionNode } from "@/types/domain";

interface PageListProps {
  notebookName: string;
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
  sections: SectionNode[];
  sectionGroups: SectionGroupNode[];
  selectedSectionId: string | null;
  selectedGroupId: string | null;
  selectedPageId: string | null;
  onSelectSection: (id: string) => void;
  onSelectGroup: (id: string | null) => void;
  onSelectPage: (id: string) => void;
  onCreateSection: () => void;
  onRenameSection: () => void;
  onSetSectionColor: (color: string) => void;
  onSetDefaultTemplate: () => void;
  onMoveSection: () => void;
  onMoveSectionToGroup: () => void;
  onTrashSection: () => void;
  onCreateSectionGroup: () => void;
  onRenameSectionGroup: (id: string) => void;
  onSetSectionGroupColor: (id: string, color: string) => void;
  onMoveSectionGroup: (id: string) => void;
  onDeleteSectionGroup: (id: string) => void;
  onCreatePage: () => void;
  onCreateFromTemplate: () => void;
  onDuplicatePage: () => void;
  onMovePage: () => void;
  onTrashPage: () => void;
  onMakeSubpage: () => void;
  onPromotePage: () => void;
  onMovePageUp: () => void;
  onMovePageDown: () => void;
  onSetPageParent: (pageId: string, parentPageId: string | null) => void;
  onPositionPage: (pageId: string, targetPageId: string, placement: "before" | "after" | "child") => void;
}

function pageTitle(page: PageSummary): string {
  return page.title.trim() || "Untitled page";
}

function flattenGroups(groups: SectionGroupNode[]) {
  const byParent = new Map<string | null, SectionGroupNode[]>();
  for (const group of groups) {
    const parent = group.parentGroupId && groups.some((candidate) => candidate.id === group.parentGroupId)
      ? group.parentGroupId
      : null;
    const list = byParent.get(parent) ?? [];
    list.push(group);
    byParent.set(parent, list);
  }
  const result: Array<{ group: SectionGroupNode; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const group of byParent.get(parentId) ?? []) {
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      result.push({ group, depth });
      visit(group.id, Math.min(depth + 1, 6));
    }
  };
  visit(null, 0);
  for (const group of groups) if (!seen.has(group.id)) result.push({ group, depth: 0 });
  return result;
}

function flattenPages(pages: PageSummary[], collapsed: Set<string>): Array<{ page: PageSummary; depth: number; hasChildren: boolean }> {
  const byParent = new Map<string | null, PageSummary[]>();
  for (const page of pages) {
    const parent = page.parentPageId && pages.some((candidate) => candidate.id === page.parentPageId)
      ? page.parentPageId
      : null;
    const list = byParent.get(parent) ?? [];
    list.push(page);
    byParent.set(parent, list);
  }

  const result: Array<{ page: PageSummary; depth: number; hasChildren: boolean }> = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const page of byParent.get(parentId) ?? []) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      const hasChildren = (byParent.get(page.id)?.length ?? 0) > 0;
      result.push({ page, depth, hasChildren });
      if (!collapsed.has(page.id)) visit(page.id, Math.min(depth + 1, 8));
    }
  };
  visit(null, 0);
  for (const page of pages) if (!seen.has(page.id)) result.push({ page, depth: 0, hasChildren: false });
  return result;
}

function collapsedStorageKey(sectionId: string | null) {
  return `lenota:collapsed-pages:${sectionId ?? "none"}`;
}

export function PageList({
  notebookName,
  notebooks,
  selectedNotebookId,
  onSelectNotebook,
  onCreateNotebook,
  onRenameNotebook,
  onSetNotebookColor,
  onTrashNotebook,
  onOpenSearch,
  onOpenRecent,
  onOpenFavorites,
  onOpenTrash,
  onOpenBackups,
  sections,
  sectionGroups,
  selectedSectionId,
  selectedGroupId,
  selectedPageId,
  onSelectSection,
  onSelectGroup,
  onSelectPage,
  onCreateSection,
  onRenameSection,
  onSetSectionColor,
  onSetDefaultTemplate,
  onMoveSection,
  onMoveSectionToGroup,
  onTrashSection,
  onCreateSectionGroup,
  onRenameSectionGroup,
  onSetSectionGroupColor,
  onMoveSectionGroup,
  onDeleteSectionGroup,
  onCreatePage,
  onCreateFromTemplate,
  onDuplicatePage,
  onMovePage,
  onTrashPage,
  onMakeSubpage,
  onPromotePage,
  onMovePageUp,
  onMovePageDown,
  onSetPageParent,
  onPositionPage,
}: PageListProps) {
  const selectedSection = sections.find((section) => section.id === selectedSectionId) ?? sections.find((section) => section.sectionGroupId === selectedGroupId);
  const selectedPage = selectedSection?.pages.find((page) => page.id === selectedPageId) ?? null;
  const selectedIndex = selectedPage ? selectedSection?.pages.findIndex((page) => page.id === selectedPage.id) ?? -1 : -1;
  const canMakeSubpage = Boolean(selectedPage && selectedIndex > 0);
  const canPromote = Boolean(selectedPage?.parentPageId);
  const hasSection = Boolean(selectedSection);
  const hasPage = Boolean(selectedPageId);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draggedPageId, setDraggedPageId] = useState<string | null>(null);
  const [pageDropTarget, setPageDropTarget] = useState<{ id: string; placement: "before" | "after" | "child" } | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(collapsedStorageKey(selectedSection?.id ?? null));
      setCollapsed(new Set(raw ? JSON.parse(raw) as string[] : []));
    } catch {
      setCollapsed(new Set());
    }
  }, [selectedSection?.id]);

  const setCollapsedPersisted = (next: Set<string>) => {
    setCollapsed(next);
    try { localStorage.setItem(collapsedStorageKey(selectedSection?.id ?? null), JSON.stringify([...next])); } catch { /* optional UI state */ }
  };

  const visiblePages = flattenPages(selectedSection?.pages ?? [], collapsed);
  const groupRows = useMemo(() => flattenGroups(sectionGroups), [sectionGroups]);
  const visibleSections = sections.filter((section) => section.sectionGroupId === selectedGroupId);
  const selectedNotebook = notebooks.find((notebook) => notebook.id === selectedNotebookId) ?? null;

  return (
    <section className="navigation-drawer flex min-w-0 overflow-hidden flex-col border-r border-white/8 bg-[#17191f]">
      <div className="navigator-brand">LeNota</div>
      <div className="navigator-mode-tabs grid shrink-0 grid-cols-5 gap-1 border-b border-white/8 px-3 py-3">
        <button type="button" className="is-active" aria-label="Notes" title="Notes"><BookOpen className="size-4" /></button>
        <button type="button" onClick={onOpenRecent} aria-label="Recent notes" title="Recent notes"><Clock3 className="size-4" /></button>
        <button type="button" onClick={onOpenFavorites} aria-label="Favorite notes" title="Favorites"><Star className="size-4" /></button>
        <button type="button" onClick={onOpenBackups} aria-label="Backups" title="Backups"><DatabaseBackup className="size-4" /></button>
        <button type="button" onClick={onOpenTrash} aria-label="Trash" title="Trash"><Trash2 className="size-4" /></button>
      </div>
      <button type="button" className="navigator-search mx-3 mt-3 flex h-10 shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-black/10 px-3 text-left text-xs text-neutral-500 transition hover:border-violet-400/25 hover:text-neutral-300" onClick={onOpenSearch}><Search className="size-4"/><span>Search notebook</span><span className="ml-auto text-[10px] text-neutral-600">Ctrl+K</span></button>
      <div className="navigator-tree mt-3 shrink-0 border-b border-white/8 px-2 pb-2">
        <div className="navigator-tree-row group/tree flex min-w-0 items-center rounded-lg px-2 py-1.5 text-neutral-200 hover:bg-white/5">
          <ChevronDown className="mr-1 size-4 shrink-0 text-neutral-500" />
          <BookOpen className="mr-2 size-4 shrink-0 text-violet-400" />
          <select
            aria-label="Notebook"
            className="navigator-notebook-select h-8 min-w-0 flex-1 truncate border-0 bg-transparent px-0 text-sm font-medium text-neutral-100 outline-none"
            title={notebookName}
            value={selectedNotebookId ?? ""}
            onChange={(event) => { if (event.target.value) onSelectNotebook(event.target.value); }}
          >
            {notebooks.length === 0 ? <option value="">No notebooks</option> : null}
            {notebooks.map((notebook) => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}
          </select>
          <div className="navigator-tree-actions ml-1 flex shrink-0 items-center">
            <button type="button" aria-label="Create notebook" title="Create notebook" onClick={onCreateNotebook}><Plus className="size-3.5" /></button>
            <button type="button" aria-label="Rename notebook" title="Rename notebook" disabled={!selectedNotebook} onClick={onRenameNotebook}><Pencil className="size-3.5" /></button>
            <label title="Notebook color"><input aria-label="Notebook color" type="color" value={selectedNotebook?.color ?? "#8b5cf6"} disabled={!selectedNotebook} onChange={(event) => onSetNotebookColor(event.target.value)} /></label>
            <button type="button" aria-label="Move notebook to trash" title="Move notebook to trash" disabled={!selectedNotebook} onClick={onTrashNotebook}><Trash2 className="size-3.5" /></button>
          </div>
        </div>
        <div className="navigator-quick-links">
          <button type="button" onClick={onOpenRecent}><Home className="size-[18px]"/><span>Overview</span></button>
          <button type="button" onClick={onOpenRecent}><FileText className="size-[18px]"/><span>Quick Notes</span></button>
        </div>
        <div className="mt-0.5 space-y-0.5">
          <div className="navigator-sections-root group/tree flex min-w-0 items-center rounded-lg hover:bg-white/5">
            <button type="button" className={cn("flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg pl-7 pr-2 text-left text-sm", selectedGroupId === null ? "text-violet-200" : "text-neutral-400")} onClick={() => onSelectGroup(null)}>
              <ChevronRight className="size-3.5 shrink-0 text-neutral-600" /><FolderTree className="size-4 shrink-0" /><span className="truncate">Sections</span>
            </button>
          </div>
          {groupRows.map(({ group, depth }) => (
            <div key={group.id} className="group/tree flex min-w-0 items-center rounded-lg hover:bg-white/5">
              <button
                type="button"
                className={cn("navigator-group-row-button flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg pr-2 text-left text-sm", selectedGroupId === group.id ? "bg-violet-500/12 text-violet-200" : "text-neutral-400 hover:text-neutral-100")}
                style={{ paddingLeft: `${28 + depth * 16}px` }}
                onClick={() => onSelectGroup(group.id)}
                onDoubleClick={() => onRenameSectionGroup(group.id)}
                title={depth ? `Nested section group: ${group.name}` : `Section group: ${group.name}`}
              >
                <ChevronRight className="size-3.5 shrink-0 text-neutral-600" />
                <FolderTree className="size-4 shrink-0" style={{ color: group.color }} />
                <span className="truncate">{group.name}</span>
              </button>
              {selectedGroupId === group.id ? <div className="navigator-tree-actions flex shrink-0 items-center pr-1">
                <label title="Section group color"><input aria-label="Section group color" type="color" value={group.color} onChange={(event) => onSetSectionGroupColor(group.id, event.target.value)} /></label>
                <button type="button" aria-label="Rename section group" title="Rename section group" onClick={() => onRenameSectionGroup(group.id)}><Pencil className="size-3.5" /></button>
                <button type="button" aria-label="Move section group" title="Move section group" onClick={() => onMoveSectionGroup(group.id)}><ArrowRightLeft className="size-3.5" /></button>
                <button type="button" aria-label="Delete section group" title="Delete section group" onClick={() => onDeleteSectionGroup(group.id)}><Trash2 className="size-3.5" /></button>
              </div> : null}
            </div>
          ))}
          <button type="button" className="navigator-new-group ml-7 flex h-8 items-center gap-2 rounded-lg px-2 text-xs text-neutral-600 hover:bg-white/5 hover:text-neutral-300" onClick={onCreateSectionGroup}><Plus className="size-3.5" />New group</button>
          <div className="space-y-0.5">
            {visibleSections.map((section) => (
              <div key={section.id} className="group/tree flex min-w-0 items-center rounded-lg hover:bg-white/5">
                <button
                  type="button"
                  className={cn("flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg pl-11 pr-2 text-left text-sm", section.id === selectedSection?.id ? "bg-violet-500/12 text-violet-100" : "text-neutral-400 hover:text-neutral-100")}
                  onClick={() => onSelectSection(section.id)}
                >
                  <ChevronDown className="size-3.5 shrink-0 text-neutral-600" />
                  <FolderTree className="size-4 shrink-0" style={{ color: section.color }} />
                  <span className="truncate">{section.name}</span>
                </button>
                {section.id === selectedSection?.id ? <div className="navigator-tree-actions flex shrink-0 items-center pr-1">
                  <label title="Section color"><input aria-label="Section color" type="color" value={section.color} onChange={(event) => onSetSectionColor(event.target.value)} /></label>
                  <button type="button" aria-label="Rename section" title="Rename section" onClick={onRenameSection}><Pencil className="size-3.5" /></button>
                  <button type="button" aria-label="Set default page template" title="Set default page template" onClick={onSetDefaultTemplate}><LayoutTemplate className="size-3.5" /></button>
                  <button type="button" aria-label="Move section" title="Move section" onClick={onMoveSection}><ArrowRightLeft className="size-3.5" /></button>
                  <button type="button" aria-label="Move section to trash" title="Move section to trash" onClick={onTrashSection}><Trash2 className="size-3.5" /></button>
                </div> : null}
              </div>
            ))}
            <div className="navigator-new-section-row ml-11 flex items-center gap-1">
              <button type="button" className="flex h-8 items-center gap-2 rounded-lg px-2 text-xs text-neutral-600 hover:bg-white/5 hover:text-neutral-300" onClick={onCreateSection}><Plus className="size-3.5" />New section</button>
              <button type="button" className="grid size-8 place-items-center rounded-lg text-neutral-600 hover:bg-white/5 hover:text-neutral-300" aria-label="Move section into group" title="Move selected section into a group" disabled={!hasSection} onClick={onMoveSectionToGroup}><FolderTree className="size-3.5" /></button>
            </div>
          </div>
        </div>
      </div>

      <div className="navigator-section-actions flex min-w-0 items-center justify-between border-b border-white/6 px-3 py-2">
        <div className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-500">{selectedSection?.name ?? "No section selected"}</div>
        <div className="ml-2 flex min-w-0 shrink items-center gap-0.5 overflow-x-auto [&>*]:shrink-0">
          <label className={cn("grid size-8 place-items-center rounded-md hover:bg-white/6", !hasSection && "pointer-events-none opacity-35")} title="Section color">
            <input aria-label="Section color" className="h-4 w-4 cursor-pointer rounded border-0 bg-transparent p-0" type="color" value={selectedSection?.color ?? "#a78bfa"} onChange={(event) => onSetSectionColor(event.target.value)} />
          </label>
          <Button aria-label="Rename section" size="icon" variant="ghost" disabled={!hasSection} onClick={onRenameSection}><Pencil className="size-3.5" /></Button>
          <Button aria-label="Set default page template" title={selectedSection?.defaultTemplateId ? `Default template: ${selectedSection.defaultTemplateId}` : "Set default page template"} size="icon" variant="ghost" disabled={!hasSection} onClick={onSetDefaultTemplate}><LayoutTemplate className="size-3.5" /></Button>
          <Button aria-label="Move section into a section group" title="Move section into section group" size="icon" variant="ghost" disabled={!hasSection} onClick={onMoveSectionToGroup}><FolderTree className="size-3.5" /></Button>
          <Button aria-label="Move section" size="icon" variant="ghost" disabled={!hasSection} onClick={onMoveSection}><ArrowRightLeft className="size-3.5" /></Button>
          <Button aria-label="Move section to trash" size="icon" variant="ghost" disabled={!hasSection} onClick={onTrashSection}><Trash2 className="size-3.5" /></Button>
        </div>
      </div>

      <div
        className="navigator-page-actions flex min-w-0 items-center justify-between px-3 py-2"
        onDragOver={(event) => { if (draggedPageId) event.preventDefault(); }}
        onDrop={(event) => { event.preventDefault(); if (draggedPageId) onSetPageParent(draggedPageId, null); setDraggedPageId(null); }}
        title="Drop a page here to promote it to the top level"
      >
        <div className="shrink-0 text-xs font-medium text-neutral-500">Pages</div>
        <div className="ml-2 flex min-w-0 shrink items-center gap-0.5 overflow-x-auto [&>*]:shrink-0">
          <Button title="Move page up (Alt+Up)" aria-label="Move selected page up" size="icon" variant="ghost" disabled={!hasPage} onClick={onMovePageUp}><ArrowUp className="size-3.5" /></Button>
          <Button title="Move page down (Alt+Down)" aria-label="Move selected page down" size="icon" variant="ghost" disabled={!hasPage} onClick={onMovePageDown}><ArrowDown className="size-3.5" /></Button>
          <Button title="Make subpage (Alt+Shift+Right)" aria-label="Make selected page a subpage" size="icon" variant="ghost" disabled={!canMakeSubpage} onClick={onMakeSubpage}><IndentIncrease className="size-3.5" /></Button>
          <Button title="Promote subpage (Alt+Shift+Left)" aria-label="Promote selected page" size="icon" variant="ghost" disabled={!canPromote} onClick={onPromotePage}><IndentDecrease className="size-3.5" /></Button>
          <Button aria-label="Duplicate selected page" size="icon" variant="ghost" disabled={!hasPage} onClick={onDuplicatePage}><Copy className="size-3.5" /></Button>
          <Button aria-label="Move selected page" size="icon" variant="ghost" disabled={!hasPage} onClick={onMovePage}><ArrowRightLeft className="size-3.5" /></Button>
          <Button aria-label="Move selected page to trash" size="icon" variant="ghost" disabled={!hasPage} onClick={onTrashPage}><Trash2 className="size-3.5" /></Button>
          <Button aria-label="Create page from template" size="icon" variant="ghost" onClick={onCreateFromTemplate} disabled={!selectedSection}><LayoutTemplate className="size-4" /></Button>
          <Button aria-label="Create blank page" size="icon" variant="ghost" onClick={onCreatePage} disabled={!selectedSection}><Plus className="size-4" /></Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className="space-y-1">
          {visiblePages.map(({ page, depth, hasChildren }) => (
            <button
              key={page.id}
              draggable
              className={cn(
                "group/page w-full rounded-lg border py-2.5 pr-3 text-left transition-colors",
                page.id === selectedPageId ? "border-violet-500/30 bg-violet-500/12" : "border-transparent hover:bg-white/5",
                draggedPageId === page.id && "opacity-45",
                pageDropTarget?.id === page.id && pageDropTarget.placement === "child" && "border-violet-400/70 bg-violet-500/10",
                pageDropTarget?.id === page.id && pageDropTarget.placement === "before" && "border-t-violet-400",
                pageDropTarget?.id === page.id && pageDropTarget.placement === "after" && "border-b-violet-400",
              )}
              style={{ paddingLeft: `${8 + depth * 18}px` }}
              onClick={() => onSelectPage(page.id)}
              onDragStart={(event) => { setDraggedPageId(page.id); setPageDropTarget(null); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/lenota-page", page.id); }}
              onDragEnd={() => { setDraggedPageId(null); setPageDropTarget(null); }}
              onDragOver={(event) => {
                if (!draggedPageId || draggedPageId === page.id) return;
                event.preventDefault(); event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
                const placement = ratio < .28 ? "before" : ratio > .72 ? "after" : "child";
                setPageDropTarget({ id: page.id, placement });
              }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPageDropTarget((current) => current?.id === page.id ? null : current); }}
              onDrop={(event) => {
                event.preventDefault(); event.stopPropagation();
                if (draggedPageId && draggedPageId !== page.id) {
                  const placement = pageDropTarget?.id === page.id ? pageDropTarget.placement : "child";
                  onPositionPage(draggedPageId, page.id, placement);
                }
                setDraggedPageId(null); setPageDropTarget(null);
              }}
            >
              <div className="flex items-start gap-1.5">
                <span
                  className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded text-neutral-600", hasChildren && "hover:bg-white/8 hover:text-neutral-300")}
                  onClick={(event) => {
                    if (!hasChildren) return;
                    event.stopPropagation();
                    const next = new Set(collapsed);
                    if (next.has(page.id)) next.delete(page.id); else next.add(page.id);
                    setCollapsedPersisted(next);
                  }}
                >
                  {hasChildren ? (collapsed.has(page.id) ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />) : depth > 0 ? <ChevronRight className="size-3 opacity-40" /> : null}
                </span>
                {page.id === selectedPageId ? <span className="mt-1.5 size-2 shrink-0 rounded-full bg-violet-400"/> : <FileText className="mt-0.5 size-4 shrink-0 text-neutral-500" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <div className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100">{pageTitle(page)}</div>
                    {page.isFavorite ? <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" /> : null}
                  </div>
                  <div className="navigator-page-preview mt-1 line-clamp-2 text-xs leading-5 text-neutral-500">{page.preview || "Empty page"}</div>
                  {page.tags.length > 0 ? <div className="navigator-page-tags mt-2 flex flex-wrap gap-1">{page.tags.slice(0, 3).map((tag) => <span key={tag.id} className="rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-500">#{tag.name}</span>)}</div> : null}
                </div>
              </div>
            </button>
          ))}
          {selectedSection && selectedSection.pages.length === 0 ? <div className="px-3 py-8 text-center text-xs leading-5 text-neutral-600">This section has no pages.</div> : null}
          {!selectedSection ? <div className="px-3 py-8 text-center text-xs leading-5 text-neutral-600">Create or select a section in this group.</div> : null}
        </div>
      </div>
      <div className="navigator-footer shrink-0 border-t border-white/8 p-3">
        <Button className="w-full justify-start" variant="outline" onClick={onCreatePage} disabled={!selectedSection}><Plus className="size-4"/>New Page</Button>
      </div>
    </section>
  );
}
