import { useMemo, useState } from "react";
import { Clock3, FileSearch, Search, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PageLocation } from "@/types/domain";

export type DiscoveryMode = "search" | "recent" | "favorites";

interface DiscoveryDialogProps {
  mode: DiscoveryMode;
  query: string;
  results: PageLocation[];
  loading: boolean;
  onChangeQuery: (value: string) => void;
  onChangeMode: (mode: DiscoveryMode) => void;
  onOpenPage: (result: PageLocation) => void;
  onClose: () => void;
}

function modeLabel(mode: DiscoveryMode): string {
  if (mode === "favorites") return "Favorites";
  if (mode === "recent") return "Recent pages";
  return "Search all notes";
}

function pageTitle(value: string): string {
  return value.trim() || "Untitled page";
}

export function DiscoveryDialog({
  mode,
  query,
  results,
  loading,
  onChangeQuery,
  onChangeMode,
  onOpenPage,
  onClose,
}: DiscoveryDialogProps) {
  const [notebookFilter, setNotebookFilter] = useState("");
  const [sectionFilter, setSectionFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const notebooks = useMemo(() => [...new Set(results.map((item) => item.notebookName))].sort(), [results]);
  const sections = useMemo(() => [...new Set(results.filter((item) => !notebookFilter || item.notebookName === notebookFilter).map((item) => item.sectionName))].sort(), [results, notebookFilter]);
  const tags = useMemo(() => {
    const values = new Map<string, string>();
    for (const item of results) for (const tag of item.tags) values.set(tag.id, tag.name);
    return [...values.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [results]);
  const filteredResults = useMemo(() => results.filter((item) =>
    (!notebookFilter || item.notebookName === notebookFilter) &&
    (!sectionFilter || item.sectionName === sectionFilter) &&
    (!tagFilter || item.tags.some((tag) => tag.id === tagFilter)),
  ), [results, notebookFilter, sectionFilter, tagFilter]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-start bg-black/60 px-6 pt-[9vh] backdrop-blur-sm">
      <section
        aria-label={modeLabel(mode)}
        aria-modal="true"
        role="dialog"
        className="flex max-h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1d1d21] shadow-2xl"
      >
        <header className="border-b border-white/8 p-3">
          <div className="flex items-center gap-2">
            <Search className="ml-2 size-5 text-neutral-500" />
            <input
              autoFocus
              className="ui-selectable h-10 min-w-0 flex-1 bg-transparent text-base text-white outline-none placeholder:text-neutral-600"
              placeholder="Search titles, note text, and tags…"
              value={query}
              onChange={(event) => onChangeQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") onClose();
                if (event.key === "Enter" && filteredResults[0]) onOpenPage(filteredResults[0]);
              }}
            />
            <Button aria-label="Close" size="icon" variant="ghost" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-1 px-1">
            <Button
              className={cn(mode === "search" && "bg-white/10 text-white")}
              variant="ghost"
              onClick={() => onChangeMode("search")}
            >
              <FileSearch className="size-4" /> Search
            </Button>
            <Button
              className={cn(mode === "recent" && "bg-white/10 text-white")}
              variant="ghost"
              onClick={() => onChangeMode("recent")}
            >
              <Clock3 className="size-4" /> Recent
            </Button>
            <Button
              className={cn(mode === "favorites" && "bg-white/10 text-white")}
              variant="ghost"
              onClick={() => onChangeMode("favorites")}
            >
              <Star className="size-4" /> Favorites
            </Button>
            <span className="ml-auto pr-2 text-[11px] text-neutral-600">Ctrl+K</span>
          </div>
          {results.length > 0 ? <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1">
            <select aria-label="Filter by notebook" className="h-7 rounded-md border border-white/10 bg-[#29292e] px-2 text-xs text-neutral-300" value={notebookFilter} onChange={(event) => { setNotebookFilter(event.target.value); setSectionFilter(""); }}>
              <option value="">All notebooks</option>{notebooks.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <select aria-label="Filter by section" className="h-7 rounded-md border border-white/10 bg-[#29292e] px-2 text-xs text-neutral-300" value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)}>
              <option value="">All sections</option>{sections.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <select aria-label="Filter by tag" className="h-7 rounded-md border border-white/10 bg-[#29292e] px-2 text-xs text-neutral-300" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
              <option value="">All tags</option>{tags.map(([id, name]) => <option key={id} value={id}>#{name}</option>)}
            </select>
            {(notebookFilter || sectionFilter || tagFilter) ? <Button variant="ghost" onClick={() => { setNotebookFilter(""); setSectionFilter(""); setTagFilter(""); }}>Clear filters</Button> : null}
            <span className="ml-auto text-[11px] text-neutral-600">{filteredResults.length} result{filteredResults.length === 1 ? "" : "s"}</span>
          </div> : null}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="grid min-h-56 place-items-center text-sm text-neutral-500">Loading…</div>
          ) : filteredResults.length === 0 ? (
            <div className="grid min-h-56 place-items-center text-center text-sm text-neutral-500">
              <div>
                <Search className="mx-auto mb-3 size-8 text-neutral-700" />
                {mode === "search" && !query.trim()
                  ? "Type to search every notebook."
                  : `No ${modeLabel(mode).toLocaleLowerCase()} found.`}
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              {filteredResults.map((result) => (
                <button
                  key={result.pageId}
                  className="flex w-full items-start gap-3 rounded-lg border border-transparent px-3 py-3 text-left hover:border-white/8 hover:bg-white/5"
                  onClick={() => onOpenPage(result)}
                >
                  <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-violet-500/12 text-violet-300">
                    <FileSearch className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-neutral-100">{pageTitle(result.title)}</span>
                      {result.isFavorite ? <Star className="size-3.5 fill-amber-400 text-amber-400" /> : null}
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-neutral-500">
                      {result.preview || "Empty page"}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-600">
                      <span>{result.notebookName} / {result.sectionName}</span>
                      {result.tags.map((tag) => (
                        <span key={tag.id} className="rounded-full bg-white/5 px-1.5 py-0.5 text-neutral-500">
                          #{tag.name}
                        </span>
                      ))}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
