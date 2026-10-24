import { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BookOpen, ChevronLeft, ChevronRight, MoreHorizontal, Paperclip, Plus, Search, X } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { CommandPalette, type AppCommand } from "@/features/commands/command-palette";
import { AttachmentsPanel } from "@/features/editor/attachments-panel";
import { BackupsDialog } from "@/features/recovery/backups-dialog";
import { DiscoveryDialog, type DiscoveryMode } from "@/features/discovery/discovery-dialog";
import { PageEditor } from "@/features/editor/page-editor";
import { AccountDialog } from "@/features/sync/account-dialog";
import { useAccountSync } from "@/features/sync/use-account-sync";
import { HistoryDialog } from "@/features/history/history-dialog";
import { PageList } from "@/features/navigation/page-list";
import { orderFocusPages } from "@/features/navigation/focus-pages";
import { NotebookSidebar } from "@/features/navigation/notebook-sidebar";
import { TemplatesDialog } from "@/features/templates/templates-dialog";
import { PAGE_TEMPLATES, type PageTemplate } from "@/features/templates/page-templates";
import { TrashDialog } from "@/features/recovery/trash-dialog";
import { mobileFileType } from "@/lib/mobile-files";
import { isNativeMobile } from "@/lib/platform";
import { readFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { notesApi } from "@/lib/tauri-api";
import { useDebouncedEffect } from "@/lib/use-debounced-effect";
import { appGridTemplate, focusLayoutIsVisible } from "@/features/layout/app-layout";
import { discardPersistedFocusMode, resetInterfaceAndReload } from "@/features/layout/ui-preferences";
import type {
  Attachment,
  BackupInfo,
  Page,
  PageLocation,
  PageRevision,
  Tag,
  TrashEntry,
  WorkspaceTree,
} from "@/types/domain";

const EMPTY_TREE: WorkspaceTree = { notebooks: [] };

const PAGE_LIST_DEFAULT_WIDTH = 272;
const PAGE_LIST_MIN_WIDTH = 260;
const PAGE_LIST_MAX_WIDTH = 440;
const SIDEBAR_HANDLE_WIDTH = 8;
const SIDEBAR_CANVAS_RESERVE = 520;

type AppTheme = "dark" | "light";

function readStoredTheme(): AppTheme {
  try {
    const stored = localStorage.getItem("lenota:appearance:theme");
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch {
    return fallback;
  }
}

function readStoredBoolean(key: string, fallback = false): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

interface SidebarResizerProps {
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  collapsed: boolean;
  toggleTop: string;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onNudge: (delta: number) => void;
  onToggle: () => void;
}

function SidebarResizer({
  label,
  width,
  minWidth,
  maxWidth,
  collapsed,
  toggleTop,
  onPointerDown,
  onNudge,
  onToggle,
}: SidebarResizerProps) {
  return (
    <div
      className={`sidebar-resizer no-print group relative z-40 h-full w-2 select-none touch-none ${collapsed ? "is-collapsed cursor-default" : "cursor-col-resize"}`}
      role="separator"
      aria-label={`${label} width`}
      aria-orientation="vertical"
      aria-valuemin={collapsed ? 0 : minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={collapsed ? 0 : Math.round(width)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); onNudge(-16); }
        if (event.key === "ArrowRight") { event.preventDefault(); onNudge(16); }
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); }
      }}
      onDoubleClick={onToggle}
      title={collapsed ? `${label} is folded` : `Drag to resize ${label}`}
    >
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/8 transition-colors group-hover:bg-violet-400/65" />
      <button
        type="button"
        className="absolute left-1/2 z-10 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/12 bg-[#25252b]/95 text-neutral-400 shadow-lg transition hover:border-violet-400/45 hover:bg-[#303038] hover:text-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/70"
        style={{ top: toggleTop }}
        aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
        title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onToggle}
      >
        {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronLeft className="size-3.5" />}
      </button>
    </div>
  );
}

interface SelectionPreference {
  notebookId?: string | null;
  groupId?: string | null;
  sectionId?: string | null;
  pageId?: string | null;
}

interface NavigationLocation {
  notebookId: string;
  groupId: string | null;
  sectionId: string;
  pageId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chooseNumbered<T>(title: string, items: T[], label: (item: T) => string): T | null {
  if (items.length === 0) return null;
  const options = items.map((item, index) => `${index + 1}. ${label(item)}`).join("\n");
  const answer = window.prompt(`${title}\n\n${options}`, "1")?.trim();
  if (!answer) return null;

  const numericIndex = Number.parseInt(answer, 10) - 1;
  if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < items.length) {
    return items[numericIndex];
  }

  const normalized = answer.toLocaleLowerCase();
  return items.find((item) => label(item).toLocaleLowerCase() === normalized) ?? null;
}

const TAG_COLORS = ["#8b5cf6", "#ef4444", "#f59e0b", "#22c55e", "#06b6d4", "#3b82f6", "#ec4899"];

interface RecoveryDraft {
  pageId: string;
  title: string;
  contentJson: string;
  plainText: string;
  savedAt: number;
}
const RECOVERY_PREFIX = "lenota:recovery:";
function recoveryKey(pageId: string) { return `${RECOVERY_PREFIX}${pageId}`; }
function readRecoveryDraft(pageId: string): RecoveryDraft | null {
  try {
    const raw = localStorage.getItem(recoveryKey(pageId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecoveryDraft;
    if (parsed.pageId !== pageId || typeof parsed.contentJson !== "string" || typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > 7 * 24 * 60 * 60 * 1000) { localStorage.removeItem(recoveryKey(pageId)); return null; }
    JSON.parse(parsed.contentJson);
    return parsed;
  } catch {
    localStorage.removeItem(recoveryKey(pageId));
    return null;
  }
}
function clearRecoveryDraft(pageId: string) {
  try { localStorage.removeItem(recoveryKey(pageId)); } catch { /* storage unavailable */ }
}

export default function App() {
  const [tree, setTree] = useState<WorkspaceTree>(EMPTY_TREE);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [selectedSectionGroupId, setSelectedSectionGroupId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [title, setTitle] = useState("");
  const [contentJson, setContentJson] = useState('{"type":"doc","content":[{"type":"paragraph"}]}');
  const [plainText, setPlainText] = useState("");
  const [editorInstanceKey, setEditorInstanceKey] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const backStackRef = useRef<NavigationLocation[]>([]);
  const forwardStackRef = useRef<NavigationLocation[]>([]);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [targetContainerId, setTargetContainerId] = useState<string | null>(null);

  const [pageListWidth, setPageListWidth] = useState(() =>
    readStoredNumber("lenota:layout:v029:page-list-width", PAGE_LIST_DEFAULT_WIDTH, PAGE_LIST_MIN_WIDTH, PAGE_LIST_MAX_WIDTH),
  );
  const [pageListCollapsed, setPageListCollapsed] = useState(() =>
    readStoredBoolean("lenota:layout:v029:page-list-collapsed", false),
  );
  const [compactLayout, setCompactLayout] = useState(() => window.innerWidth < 900);
  const compactLayoutRef = useRef(window.innerWidth < 900);
  const [compactNavigationOpen, setCompactNavigationOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readStoredTheme);
  const [focusMode, setFocusMode] = useState<boolean>(() => discardPersistedFocusMode(window.localStorage));

  const toggleFocusMode = useCallback(() => {
    if (!focusMode && !page) {
      setError("Open or create a page before entering Focus Mode.");
      return;
    }
    setFocusMode((value) => !value);
  }, [focusMode, page]);

  useEffect(() => {
    try {
      localStorage.setItem("lenota:layout:v029:page-list-width", String(Math.round(pageListWidth)));
      localStorage.setItem("lenota:layout:v029:page-list-collapsed", String(pageListCollapsed));
      localStorage.setItem("lenota:appearance:theme", theme);
      // Focus Mode is session-only. Never restore a hidden-chrome state on
      // startup, especially when upgrading from a build with a layout bug.
      localStorage.removeItem("lenota:appearance:focus-mode");
    } catch { /* optional UI state */ }
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.focusMode = String(focusMode);
  }, [pageListWidth, pageListCollapsed, theme, focusMode]);

  useEffect(() => {
    const updateCompactLayout = () => {
      const compact = window.innerWidth < 900;
      if (!compactLayoutRef.current && compact) setCompactNavigationOpen(false);
      compactLayoutRef.current = compact;
      setCompactLayout(compact);
    };
    updateCompactLayout();
    window.addEventListener("resize", updateCompactLayout);
    return () => window.removeEventListener("resize", updateCompactLayout);
  }, []);

  useEffect(() => {
    if (!compactLayout || !compactNavigationOpen) return;
    const close = document.querySelector<HTMLButtonElement>(".mobile-drawer-heading button");
    close?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setCompactNavigationOpen(false); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(document.querySelectorAll<HTMLElement>(".mobile-drawer-heading button, .app-rail button, .navigation-drawer button, .navigation-drawer input, .navigation-drawer select"))
        .filter(element => element.getClientRects().length && !(element as HTMLButtonElement).disabled && element.tabIndex >= 0);
      const index = controls.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    };
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("keydown", keyboard);
      document.querySelector<HTMLButtonElement>(".mobile-menu-button")?.focus();
    };
  }, [compactLayout, compactNavigationOpen]);

  useEffect(() => {
    if (!focusMode) return;
    const timer = window.setTimeout(() => {
      const editor = document.querySelector<HTMLElement>(".editor-shell.is-focus-mode");
      const canvas = editor?.querySelector<HTMLElement>(".note-canvas") ?? null;
      const editorRect = editor?.getBoundingClientRect() ?? null;
      const canvasRect = canvas?.getBoundingClientRect() ?? null;
      if (focusLayoutIsVisible(editorRect, canvasRect)) return;
      setFocusMode(false);
      setError("Focus Mode could not render safely, so LeNota restored the normal workspace.");
    }, 220);
    return () => window.clearTimeout(timer);
  }, [focusMode]);

  const sidebarViewportMax = useCallback(() => {
    const viewportMax = window.innerWidth - SIDEBAR_CANVAS_RESERVE - SIDEBAR_HANDLE_WIDTH;
    return Math.max(PAGE_LIST_MIN_WIDTH, Math.min(PAGE_LIST_MAX_WIDTH, viewportMax));
  }, []);

  const nudgeSidebar = useCallback((delta: number) => {
    if (pageListCollapsed) return;
    setPageListWidth((current) => Math.max(PAGE_LIST_MIN_WIDTH, Math.min(sidebarViewportMax(), current + delta)));
  }, [pageListCollapsed, sidebarViewportMax]);

  useEffect(() => {
    const clampSidebarToViewport = () => {
      setPageListWidth((current) => Math.max(PAGE_LIST_MIN_WIDTH, Math.min(sidebarViewportMax(), current)));
    };
    clampSidebarToViewport();
    window.addEventListener("resize", clampSidebarToViewport);
    return () => window.removeEventListener("resize", clampSidebarToViewport);
  }, [sidebarViewportMax]);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (pageListCollapsed || compactLayout) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = pageListWidth;
    const maxWidth = sidebarViewportMax();
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";

    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.max(PAGE_LIST_MIN_WIDTH, Math.min(maxWidth, startWidth + moveEvent.clientX - startX));
      setPageListWidth(next);
    };
    const onEnd = () => {
      document.body.style.cursor = previousCursor;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", onEnd);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("blur", onEnd);
  }, [compactLayout, pageListCollapsed, pageListWidth, sidebarViewportMax]);

  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [discoveryMode, setDiscoveryMode] = useState<DiscoveryMode>("search");
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [discoveryResults, setDiscoveryResults] = useState<PageLocation[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);

  const [templatesOpen, setTemplatesOpen] = useState(false);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<PageRevision[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [snapshotCreating, setSnapshotCreating] = useState(false);

  const [trashOpen, setTrashOpen] = useState(false);
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);

  const [accountOpen, setAccountOpen] = useState(false);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupCreating, setBackupCreating] = useState(false);

  const selectedNotebook = useMemo(
    () => tree.notebooks.find((notebook) => notebook.id === selectedNotebookId) ?? tree.notebooks[0],
    [selectedNotebookId, tree.notebooks],
  );

  const selectedSection = useMemo(
    () => selectedNotebook?.sections.find((section) => section.id === selectedSectionId),
    [selectedNotebook, selectedSectionId],
  );

  const allSections = useMemo(
    () =>
      tree.notebooks.flatMap((notebook) =>
        notebook.sections.map((section) => ({ notebook, section })),
      ),
    [tree.notebooks],
  );

  const linkablePages = useMemo(
    () => tree.notebooks.flatMap((notebook) => notebook.sections.flatMap((section) =>
      section.pages.map((item) => ({
        id: item.id,
        title: item.title.trim() || "Untitled page",
        notebookName: notebook.name,
        sectionName: section.name,
      })),
    )),
    [tree.notebooks],
  );

  const focusPages = useMemo(
    () => orderFocusPages(selectedSection?.pages ?? []).map((item) => ({
      id: item.id,
      title: item.title.trim() || "Untitled page",
      notebookName: selectedNotebook?.name ?? "",
      sectionName: selectedSection?.name ?? "",
    })),
    [selectedNotebook?.name, selectedSection],
  );

  const refresh = useCallback(
    async (preferred: SelectionPreference = {}) => {
      const nextTree = await notesApi.loadWorkspace();
      setTree(nextTree);

      const hasNotebook = Object.prototype.hasOwnProperty.call(preferred, "notebookId");
      const hasGroup = Object.prototype.hasOwnProperty.call(preferred, "groupId");
      const hasSection = Object.prototype.hasOwnProperty.call(preferred, "sectionId");
      const hasPage = Object.prototype.hasOwnProperty.call(preferred, "pageId");
      const notebookCandidate = hasNotebook ? preferred.notebookId : selectedNotebookId;
      const notebook = nextTree.notebooks.find((item) => item.id === notebookCandidate) ?? nextTree.notebooks[0];
      const groupCandidate = hasGroup ? preferred.groupId : selectedSectionGroupId;
      const sectionCandidate = hasSection ? preferred.sectionId : selectedSectionId;
      let section = sectionCandidate ? notebook?.sections.find((item) => item.id === sectionCandidate) : undefined;
      if (!section && notebook) {
        if (hasGroup) {
          const groupStillExists = groupCandidate === null || notebook.sectionGroups.some((group) => group.id === groupCandidate);
          section = groupStillExists ? notebook.sections.find((item) => item.sectionGroupId === groupCandidate) : notebook.sections[0];
        } else {
          section = notebook.sections[0];
        }
      }
      const resolvedGroupId = section?.sectionGroupId ?? (groupCandidate && notebook?.sectionGroups.some((group) => group.id === groupCandidate) ? groupCandidate : null);
      const pageCandidate = hasPage ? preferred.pageId : selectedPageId;
      const nextPage = pageCandidate ? section?.pages.find((item) => item.id === pageCandidate) ?? section?.pages[0] : section?.pages[0];

      setSelectedNotebookId(notebook?.id ?? null);
      setSelectedSectionGroupId(resolvedGroupId ?? null);
      setSelectedSectionId(section?.id ?? null);
      setSelectedPageId(nextPage?.id ?? null);
    },
    [selectedNotebookId, selectedPageId, selectedSectionGroupId, selectedSectionId],
  );

  const refreshTreeOnly = useCallback(async () => {
    setTree(await notesApi.loadWorkspace());
  }, []);

  useEffect(() => {
    const background = () => { if (document.visibilityState === "hidden") void flushCurrentPage().catch(() => {}); };
    document.addEventListener("visibilitychange", background);
    return () => document.removeEventListener("visibilitychange", background);
  });

  const loadTags = useCallback(async () => {
    setAvailableTags(await notesApi.listTags());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([refresh(), loadTags()]);
      } catch (loadError) {
        setError(errorMessage(loadError));
      } finally {
        if (!isNativeMobile()) await getCurrentWindow().show().catch(() => {});
      }
    })();
    // Startup must run once; refresh resolves the initial selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedPageId) {
      setPage(null);
      setTitle("");
      setPlainText("");
      setContentJson('{"type":"doc","content":[{"type":"paragraph"}]}');
      setSaveState("idle");
      return;
    }

    let active = true;
    setPage(null);
    setSaveState("idle");
    void notesApi
      .getPage(selectedPageId)
      .then((loadedPage) => {
        if (!active) return;
        const recovery = readRecoveryDraft(loadedPage.id);
        const databaseUpdatedAt = Date.parse(loadedPage.updatedAt) || 0;
        const shouldRecover = recovery && recovery.savedAt > databaseUpdatedAt + 250;
        setPage(loadedPage);
        setTitle(shouldRecover ? recovery.title : loadedPage.title);
        setContentJson(shouldRecover ? recovery.contentJson : loadedPage.contentJson);
        setPlainText(shouldRecover ? recovery.plainText : loadedPage.plainText);
        setEditorInstanceKey((value) => value + 1);
        setSaveState(shouldRecover ? "idle" : "saved");
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError));
      });

    return () => {
      active = false;
    };
  }, [selectedPageId]);

  const loadAttachments = useCallback(async (pageId = page?.id) => {
    if (!pageId) { setAttachments([]); return; }
    setAttachmentsLoading(true);
    try { setAttachments(await notesApi.listAttachments(pageId)); }
    catch (loadError) { setError(errorMessage(loadError)); }
    finally { setAttachmentsLoading(false); }
  }, [page?.id]);

  useEffect(() => {
    if (page?.id) void loadAttachments(page.id);
    else setAttachments([]);
  }, [page?.id, loadAttachments]);

  useEffect(() => {
    if (!page) return;
    const dirty = title !== page.title || contentJson !== page.contentJson || plainText !== page.plainText;
    if (!dirty) { clearRecoveryDraft(page.id); return; }
    try {
      const draft: RecoveryDraft = { pageId: page.id, title, contentJson, plainText, savedAt: Date.now() };
      localStorage.setItem(recoveryKey(page.id), JSON.stringify(draft));
    } catch {
      // SQLite autosave still remains the primary persistence path.
    }
  }, [page, title, contentJson, plainText]);

  const accountSync = useAccountSync({
    flush: flushCurrentPage,
    reload: async () => {
      await refresh();
      await loadTags();
      const currentTree = await notesApi.loadWorkspace();
      const stillExists = currentTree.notebooks.some(n => n.sections.some(section => section.pages.some(item => item.id === selectedPageId)));
      if (selectedPageId && stillExists) {
        const loaded = await notesApi.getPage(selectedPageId);
        clearRecoveryDraft(loaded.id);
        setPage(loaded);
        setTitle(loaded.title);
        setContentJson(loaded.contentJson);
        setPlainText(loaded.plainText);
        setSaveState("saved");
        setEditorInstanceKey(value => value + 1);
        await loadAttachments(loaded.id);
      }
    },
  });

  function persistPage(pageId: string, nextTitle: string, nextJson: string, nextText: string) {
    const operation = saveQueueRef.current.catch(() => {}).then(() => notesApi.updatePage(pageId, nextTitle, nextJson, nextText));
    saveQueueRef.current = operation;
    return operation;
  }

  useDebouncedEffect(
    async () => {
      if (accountSync.commitRef.current) return;
      if (
        !page ||
        (title === page.title && contentJson === page.contentJson && plainText === page.plainText)
      ) {
        return;
      }
      setSaveState("saving");
      try {
        await persistPage(page.id, title, contentJson, plainText);
        setPage((current) =>
          current?.id === page.id ? { ...current, title, contentJson, plainText } : current,
        );
        clearRecoveryDraft(page.id);
        setSaveState("saved");
        await refreshTreeOnly();
      } catch (saveError) {
        setSaveState("error");
        setError(errorMessage(saveError));
      }
    },
    700,
    [title, contentJson, plainText, page?.id],
  );

  async function flushCurrentPage(): Promise<void> {
    await saveQueueRef.current;
    if (
      !page ||
      (title === page.title && contentJson === page.contentJson && plainText === page.plainText)
    ) {
      return;
    }
    setSaveState("saving");
    await persistPage(page.id, title, contentJson, plainText);
    setPage((current) =>
      current?.id === page.id ? { ...current, title, contentJson, plainText } : current,
    );
    clearRecoveryDraft(page.id);
    setSaveState("saved");
  }

  function currentNavigationLocation(): NavigationLocation | null {
    if (!selectedNotebookId || !selectedSectionId || !selectedPageId) return null;
    return { notebookId: selectedNotebookId, groupId: selectedSectionGroupId, sectionId: selectedSectionId, pageId: selectedPageId };
  }

  function rememberCurrentLocation() {
    const current = currentNavigationLocation();
    if (!current) return;
    const last = backStackRef.current.at(-1);
    if (!last || last.pageId !== current.pageId) {
      backStackRef.current.push(current);
      if (backStackRef.current.length > 100) backStackRef.current.shift();
    }
    forwardStackRef.current = [];
    setNavigationRevision((value) => value + 1);
  }

  async function goBack() {
    const target = backStackRef.current.pop();
    if (!target) return;
    try {
      await flushCurrentPage();
      const current = currentNavigationLocation();
      if (current) forwardStackRef.current.push(current);
      setSelectedNotebookId(target.notebookId);
      setSelectedSectionGroupId(target.groupId);
      setSelectedSectionId(target.sectionId);
      setSelectedPageId(target.pageId);
      setNavigationRevision((value) => value + 1);
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function goForward() {
    const target = forwardStackRef.current.pop();
    if (!target) return;
    try {
      await flushCurrentPage();
      const current = currentNavigationLocation();
      if (current) backStackRef.current.push(current);
      setSelectedNotebookId(target.notebookId);
      setSelectedSectionGroupId(target.groupId);
      setSelectedSectionId(target.sectionId);
      setSelectedPageId(target.pageId);
      setNavigationRevision((value) => value + 1);
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function selectNotebook(notebookId: string) {
    try {
      await flushCurrentPage();
      rememberCurrentLocation();
      const notebook = tree.notebooks.find((item) => item.id === notebookId);
      const section = notebook?.sections[0];
      setSelectedNotebookId(notebookId);
      setSelectedSectionGroupId(section?.sectionGroupId ?? null);
      setSelectedSectionId(section?.id ?? null);
      setSelectedPageId(section?.pages[0]?.id ?? null);
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function selectSectionGroup(groupId: string | null) {
    try {
      await flushCurrentPage();
      rememberCurrentLocation();
      const section = selectedNotebook?.sections.find((item) => item.sectionGroupId === groupId);
      setSelectedSectionGroupId(groupId);
      setSelectedSectionId(section?.id ?? null);
      setSelectedPageId(section?.pages[0]?.id ?? null);
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function selectSection(sectionId: string) {
    try {
      await flushCurrentPage();
      rememberCurrentLocation();
      const section = selectedNotebook?.sections.find((item) => item.id === sectionId);
      setSelectedSectionGroupId(section?.sectionGroupId ?? null);
      setSelectedSectionId(sectionId);
      setSelectedPageId(section?.pages[0]?.id ?? null);
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function selectPage(pageId: string) {
    if (pageId === selectedPageId) return;
    try {
      await flushCurrentPage();
      rememberCurrentLocation();
      setSelectedPageId(pageId);
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function createNotebook() {
    const name = window.prompt("Notebook name", "New notebook")?.trim();
    if (!name) return;
    try {
      await flushCurrentPage();
      const notebookId = await notesApi.createNotebook(name);
      await refresh({ notebookId, sectionId: null, pageId: null });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function renameNotebook() {
    if (!selectedNotebook) return;
    const name = window.prompt("Rename notebook", selectedNotebook.name)?.trim();
    if (!name || name === selectedNotebook.name) return;
    try {
      await notesApi.renameNotebook(selectedNotebook.id, name);
      await refresh({ notebookId: selectedNotebook.id });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function setNotebookColor(color: string) {
    if (!selectedNotebook) return;
    try {
      await notesApi.setNotebookColor(selectedNotebook.id, color);
      await refreshTreeOnly();
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function trashNotebook() {
    if (!selectedNotebook) return;
    if (!window.confirm(`Move notebook “${selectedNotebook.name}” and its active contents to Trash?`)) return;
    try {
      await flushCurrentPage();
      setPage(null);
      setSelectedPageId(null);
      await notesApi.trashNotebook(selectedNotebook.id);
      await refresh({ notebookId: null, sectionId: null, pageId: null });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function createSection() {
    if (!selectedNotebook) return;
    const name = window.prompt("Section name", "New section")?.trim();
    if (!name) return;
    try {
      await flushCurrentPage();
      const sectionId = await notesApi.createSection(selectedNotebook.id, name);
      if (selectedSectionGroupId) await notesApi.moveSectionToGroup(sectionId, selectedSectionGroupId);
      await refresh({ notebookId: selectedNotebook.id, groupId: selectedSectionGroupId, sectionId, pageId: null });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function createSectionGroup() {
    if (!selectedNotebook) return;
    const name = window.prompt("Section group name", "New section group")?.trim();
    if (!name) return;
    try {
      await flushCurrentPage();
      const groupId = await notesApi.createSectionGroup(selectedNotebook.id, name, selectedSectionGroupId);
      await refresh({ notebookId: selectedNotebook.id, groupId, sectionId: null, pageId: null });
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function renameSectionGroup(groupId: string) {
    const group = selectedNotebook?.sectionGroups.find((item) => item.id === groupId);
    if (!group) return;
    const name = window.prompt("Rename section group", group.name)?.trim();
    if (!name || name === group.name) return;
    try { await notesApi.renameSectionGroup(group.id, name); await refreshTreeOnly(); }
    catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function setSectionGroupColor(groupId: string, color: string) {
    try { await notesApi.setSectionGroupColor(groupId, color); await refreshTreeOnly(); }
    catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function moveSectionGroup(groupId: string) {
    const group = selectedNotebook?.sectionGroups.find((item) => item.id === groupId);
    if (!group || !selectedNotebook) return;
    const choices = [{ id: null as string | null, name: "Top level" }, ...selectedNotebook.sectionGroups.filter((candidate) => candidate.id !== groupId).map((candidate) => ({ id: candidate.id as string | null, name: candidate.name }))];
    const target = chooseNumbered("Move section group inside which group?", choices, (item) => item.name);
    if (!target) return;
    try { await notesApi.setSectionGroupParent(group.id, target.id); await refreshTreeOnly(); }
    catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function deleteSectionGroup(groupId: string) {
    const group = selectedNotebook?.sectionGroups.find((item) => item.id === groupId);
    if (!group || !window.confirm(`Remove section group “${group.name}”? Its sections will be kept and moved outside the group.`)) return;
    try {
      await flushCurrentPage();
      await notesApi.deleteSectionGroup(group.id);
      await refresh({ notebookId: selectedNotebook?.id, groupId: null, sectionId: null, pageId: null });
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function moveSectionToGroup() {
    if (!selectedSection || !selectedNotebook) return;
    const choices = [{ id: null as string | null, name: "No section group" }, ...selectedNotebook.sectionGroups.map((group) => ({ id: group.id as string | null, name: group.name }))];
    const target = chooseNumbered("Move section to which section group?", choices, (item) => item.name);
    if (!target) return;
    try {
      await flushCurrentPage();
      await notesApi.moveSectionToGroup(selectedSection.id, target.id);
      await refresh({ notebookId: selectedNotebook.id, groupId: target.id, sectionId: selectedSection.id, pageId: selectedPageId });
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function setSectionDefaultTemplate() {
    if (!selectedSection) return;
    const choices = [{ id: null as string | null, name: "No default (blank page)" }, ...PAGE_TEMPLATES.filter((template) => template.id !== "blank").map((template) => ({ id: template.id as string | null, name: template.name }))];
    const target = chooseNumbered("Default template for new pages in this section", choices, (item) => item.name);
    if (!target) return;
    try {
      await notesApi.setSectionDefaultTemplate(selectedSection.id, target.id);
      await refreshTreeOnly();
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function renameSection() {
    if (!selectedSection) return;
    const name = window.prompt("Rename section", selectedSection.name)?.trim();
    if (!name || name === selectedSection.name) return;
    try {
      await notesApi.renameSection(selectedSection.id, name);
      await refresh({ notebookId: selectedSection.notebookId, sectionId: selectedSection.id });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function setSectionColor(color: string) {
    if (!selectedSection) return;
    try { await notesApi.setSectionColor(selectedSection.id, color); await refreshTreeOnly(); }
    catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function moveSection() {
    if (!selectedSection) return;
    const targets = tree.notebooks.filter((notebook) => notebook.id !== selectedSection.notebookId);
    const target = chooseNumbered("Move section to which notebook?", targets, (item) => item.name);
    if (!target) {
      if (targets.length === 0) setError("Create another notebook before moving this section.");
      return;
    }
    try {
      await flushCurrentPage();
      await notesApi.moveSection(selectedSection.id, target.id);
      await refresh({ notebookId: target.id, sectionId: selectedSection.id, pageId: selectedPageId });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function trashSection() {
    if (!selectedSection) return;
    if (!window.confirm(`Move section “${selectedSection.name}” and its active pages to Trash?`)) return;
    try {
      await flushCurrentPage();
      setPage(null);
      setSelectedPageId(null);
      await notesApi.trashSection(selectedSection.id);
      await refresh({ notebookId: selectedSection.notebookId, sectionId: null, pageId: null });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function createFirstNote() {
    try {
      await flushCurrentPage();
      let notebookId = selectedNotebook?.id ?? null;
      let sectionId = selectedSection?.id ?? selectedNotebook?.sections[0]?.id ?? null;
      let sectionGroupId = selectedSection?.sectionGroupId ?? null;

      if (!notebookId) {
        const notebookName = window.prompt("Notebook name", "My notes")?.trim();
        if (!notebookName) return;
        notebookId = await notesApi.createNotebook(notebookName);
      }
      if (!sectionId) {
        const sectionName = window.prompt("Subject / section name", "Notes")?.trim();
        if (!sectionName) {
          await refresh({ notebookId, sectionId: null, pageId: null });
          return;
        }
        sectionId = await notesApi.createSection(notebookId, sectionName);
        sectionGroupId = null;
      }
      const pageId = await notesApi.createPage(sectionId, "Untitled page");
      await refresh({ notebookId, groupId: sectionGroupId, sectionId, pageId });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function createPage() {
    if (!selectedSection) return;
    try {
      await flushCurrentPage();
      const template = selectedSection.defaultTemplateId
        ? PAGE_TEMPLATES.find((candidate) => candidate.id === selectedSection.defaultTemplateId)
        : null;
      const pageId = template && template.id !== "blank"
        ? await notesApi.createPageWithContent(selectedSection.id, template.title, template.contentJson, template.plainText)
        : await notesApi.createPage(selectedSection.id, "Untitled page");
      await refresh({ notebookId: selectedSection.notebookId, groupId: selectedSection.sectionGroupId, sectionId: selectedSection.id, pageId });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function createPageFromTemplate(template: PageTemplate) {
    if (!selectedSection) return;
    try {
      await flushCurrentPage();
      const pageId = await notesApi.createPageWithContent(
        selectedSection.id,
        template.title,
        template.contentJson,
        template.plainText,
      );
      setTemplatesOpen(false);
      await refresh({ notebookId: selectedSection.notebookId, sectionId: selectedSection.id, pageId });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function duplicatePage() {
    if (!page) return;
    try {
      await flushCurrentPage();
      const pageId = await notesApi.duplicatePage(page.id);
      await refresh({ notebookId: selectedNotebook?.id, sectionId: page.sectionId, pageId });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function makeSubpage() {
    if (!page || !selectedSection) return;
    const pages = selectedSection.pages;
    const index = pages.findIndex((candidate) => candidate.id === page.id);
    if (index <= 0) return;
    const previous = pages[index - 1];
    try {
      await flushCurrentPage();
      await notesApi.setPageParent(page.id, previous.id);
      const loaded = await notesApi.getPage(page.id);
      setPage(loaded);
      await refreshTreeOnly();
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function promotePage() {
    if (!page?.parentPageId || !selectedSection) return;
    const parent = selectedSection.pages.find((candidate) => candidate.id === page.parentPageId);
    try {
      await flushCurrentPage();
      await notesApi.setPageParent(page.id, parent?.parentPageId ?? null);
      const loaded = await notesApi.getPage(page.id);
      setPage(loaded);
      await refreshTreeOnly();
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function reorderPage(direction: "up" | "down") {
    if (!page) return;
    try {
      await flushCurrentPage();
      await notesApi.reorderPage(page.id, direction);
      await refresh({ notebookId: selectedNotebook?.id, sectionId: page.sectionId, pageId: page.id });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function setPageParent(pageId: string, parentPageId: string | null) {
    if (!selectedSection) return;
    try {
      await flushCurrentPage();
      await notesApi.setPageParent(pageId, parentPageId);
      await refresh({ notebookId: selectedNotebook?.id, groupId: selectedSection.sectionGroupId, sectionId: selectedSection.id, pageId: selectedPageId });
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function positionPage(pageId: string, targetPageId: string, placement: "before" | "after" | "child") {
    if (!selectedSection) return;
    try {
      await flushCurrentPage();
      await notesApi.positionPage(pageId, targetPageId, placement);
      await refresh({ notebookId: selectedNotebook?.id, groupId: selectedSection.sectionGroupId, sectionId: selectedSection.id, pageId: selectedPageId });
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function copyCurrentPageLink() {
    if (!page) return;
    const link = `lenota://page/${encodeURIComponent(page.id)}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      window.prompt("Copy link to page", link);
    }
  }

  async function createQuickNote() {
    if (!selectedNotebook) return;
    try {
      await flushCurrentPage();
      let quickSection = selectedNotebook.sections.find((section) => section.name.trim().toLocaleLowerCase() === "quick notes");
      let sectionId = quickSection?.id;
      if (!sectionId) sectionId = await notesApi.createSection(selectedNotebook.id, "Quick Notes");
      const pageId = await notesApi.createPage(sectionId, "Quick Note");
      await refresh({ notebookId: selectedNotebook.id, groupId: null, sectionId, pageId });
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function openInternalPage(pageId: string, containerId?: string) {
    const location = tree.notebooks.flatMap((notebook) => notebook.sections.map((section) => ({ notebook, section })))
      .find(({ section }) => section.pages.some((candidate) => candidate.id === pageId));
    if (!location) { setError("The linked page no longer exists."); return; }
    try {
      await flushCurrentPage();
      rememberCurrentLocation();
      setTargetContainerId(containerId ?? null);
      setSelectedNotebookId(location.notebook.id);
      setSelectedSectionGroupId(location.section.sectionGroupId);
      setSelectedSectionId(location.section.id);
      setSelectedPageId(pageId);
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function checkWorkspaceIntegrity() {
    try {
      await flushCurrentPage();
      const result = await notesApi.checkWorkspaceIntegrity();
      window.alert(result === "ok" ? "Workspace integrity check passed." : `Workspace integrity check result: ${result}`);
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function movePage() {
    if (!page) return;
    const targets = allSections.filter(({ section }) => section.id !== page.sectionId);
    const target = chooseNumbered(
      "Move page to which section?",
      targets,
      ({ notebook, section }) => `${notebook.name} / ${section.name}`,
    );
    if (!target) {
      if (targets.length === 0) setError("Create another section before moving this page.");
      return;
    }
    try {
      await flushCurrentPage();
      await notesApi.movePage(page.id, target.section.id);
      const movedPage = await notesApi.getPage(page.id);
      setPage(movedPage);
      setTitle(movedPage.title);
      setContentJson(movedPage.contentJson);
      setPlainText(movedPage.plainText);
      setEditorInstanceKey((value) => value + 1);
      await refresh({ notebookId: target.notebook.id, sectionId: target.section.id, pageId: page.id });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function trashPage() {
    if (!page) return;
    const displayTitle = title.trim() || "Untitled page";
    if (!window.confirm(`Move page “${displayTitle}” to Trash?`)) return;
    try {
      await flushCurrentPage();
      const previousSectionId = page.sectionId;
      setPage(null);
      setSelectedPageId(null);
      await notesApi.trashPage(page.id);
      await refresh({ notebookId: selectedNotebook?.id, sectionId: previousSectionId, pageId: null });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function toggleFavorite() {
    if (!page) return;
    const next = !page.isFavorite;
    try {
      await notesApi.setPageFavorite(page.id, next);
      setPage((current) => current?.id === page.id ? { ...current, isFavorite: next } : current);
      await refreshTreeOnly();
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function addTag(tagId: string) {
    if (!page) return;
    try {
      await flushCurrentPage();
      await notesApi.addTagToPage(page.id, tagId);
      const loaded = await notesApi.getPage(page.id);
      setPage(loaded);
      setTitle(loaded.title);
      setContentJson(loaded.contentJson);
      setPlainText(loaded.plainText);
      await refreshTreeOnly();
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function removeTag(tagId: string) {
    if (!page) return;
    try {
      await flushCurrentPage();
      await notesApi.removeTagFromPage(page.id, tagId);
      const loaded = await notesApi.getPage(page.id);
      setPage(loaded);
      setTitle(loaded.title);
      setContentJson(loaded.contentJson);
      setPlainText(loaded.plainText);
      await refreshTreeOnly();
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function createTag() {
    const name = window.prompt("Tag name", "Important")?.trim();
    if (!name) return;
    const suggested = TAG_COLORS[availableTags.length % TAG_COLORS.length];
    const color = window.prompt("Tag color (hex)", suggested)?.trim();
    if (!color) return;
    try {
      const tag = await notesApi.createTag(name, color);
      await loadTags();
      if (page) await addTag(tag.id);
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  const loadDiscovery = useCallback(async (mode: DiscoveryMode, query: string) => {
    setDiscoveryLoading(true);
    try {
      const results =
        mode === "recent"
          ? await notesApi.listRecentPages()
          : mode === "favorites"
            ? await notesApi.listFavoritePages()
            : query.trim()
              ? await notesApi.searchPages(query.trim())
              : [];
      setDiscoveryResults(results);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setDiscoveryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!discoveryOpen) return;
    const timeout = window.setTimeout(() => {
      void loadDiscovery(discoveryMode, discoveryQuery);
    }, discoveryMode === "search" ? 180 : 0);
    return () => window.clearTimeout(timeout);
  }, [discoveryMode, discoveryOpen, discoveryQuery, loadDiscovery]);

  function openDiscovery(mode: DiscoveryMode) {
    setDiscoveryMode(mode);
    if (mode !== "search") setDiscoveryQuery("");
    setDiscoveryOpen(true);
  }

  async function openDiscoveredPage(result: PageLocation) {
    try {
      await flushCurrentPage();
      rememberCurrentLocation();
      setDiscoveryOpen(false);
      const targetNotebook = tree.notebooks.find((notebook) => notebook.id === result.notebookId);
      const targetSection = targetNotebook?.sections.find((section) => section.id === result.sectionId);
      setSelectedNotebookId(result.notebookId);
      setSelectedSectionGroupId(targetSection?.sectionGroupId ?? null);
      setSelectedSectionId(result.sectionId);
      setSelectedPageId(result.pageId);
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  const loadRevisions = useCallback(async () => {
    if (!page) return;
    setHistoryLoading(true);
    try {
      setRevisions(await notesApi.listPageRevisions(page.id));
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setHistoryLoading(false);
    }
  }, [page]);

  async function openHistory() {
    if (!page) return;
    setHistoryOpen(true);
    await loadRevisions();
  }

  async function createSnapshot() {
    if (!page) return;
    setSnapshotCreating(true);
    try {
      await flushCurrentPage();
      await notesApi.createPageRevision(page.id);
      if (historyOpen) await loadRevisions();
    } catch (commandError) {
      setError(errorMessage(commandError));
    } finally {
      setSnapshotCreating(false);
    }
  }

  async function restoreRevision(revisionId: string) {
    if (!page || !window.confirm("Restore this version? The current page will be saved as another version first.")) return;
    try {
      await flushCurrentPage();
      const restored = await notesApi.restorePageRevision(page.id, revisionId);
      setPage(restored);
      setTitle(restored.title);
      setContentJson(restored.contentJson);
      setPlainText(restored.plainText);
      setEditorInstanceKey((value) => value + 1);
      setHistoryOpen(false);
      await refresh({ notebookId: selectedNotebook?.id, sectionId: restored.sectionId, pageId: restored.id });
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  const loadTrash = useCallback(async () => {
    setTrashLoading(true);
    try {
      setTrashEntries(await notesApi.listTrash());
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setTrashLoading(false);
    }
  }, []);

  async function openTrash() {
    setTrashOpen(true);
    await loadTrash();
  }

  async function restoreTrashEntry(trashId: string) {
    try {
      await notesApi.restoreTrashEntry(trashId);
      await Promise.all([loadTrash(), refresh()]);
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function deleteTrashEntry(trashId: string) {
    if (!window.confirm("Delete this item forever? This cannot be undone.")) return;
    try {
      await notesApi.deleteTrashEntry(trashId);
      await loadTrash();
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function emptyTrash() {
    if (!window.confirm("Permanently delete everything in Trash? This cannot be undone.")) return;
    try {
      await notesApi.emptyTrash();
      await loadTrash();
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  const loadBackups = useCallback(async () => {
    setBackupsLoading(true);
    try {
      setBackups(await notesApi.listBackups());
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setBackupsLoading(false);
    }
  }, []);

  async function openBackups() {
    setBackupsOpen(true);
    await loadBackups();
  }

  async function createBackup() {
    setBackupCreating(true);
    try {
      await flushCurrentPage();
      await notesApi.createBackup();
      await loadBackups();
    } catch (commandError) {
      setError(errorMessage(commandError));
    } finally {
      setBackupCreating(false);
    }
  }

  async function importTextPage() {
    if (!selectedSection) return;
    const sourcePath = await open({
      multiple: false,
      directory: false,
      title: "Import Markdown or text",
      filters: [{ name: "Text documents", extensions: ["md", "markdown", "txt"] }],
    });
    if (!sourcePath || Array.isArray(sourcePath)) return;
    try {
      await flushCurrentPage();
      const pageId = isNativeMobile()
        ? await (async () => {
          const bytes = await readFile(sourcePath);
          if (bytes.byteLength > 5_000_000) throw new Error("Text imports are limited to 5 MB.");
          const text = new TextDecoder().decode(bytes);
          const paragraphs = text.split(/\n\s*\n/).filter(value => value.trim()).map(value => ({type: "paragraph", content: [{type: "text", text: value.trim()}]}));
          return notesApi.createPageWithContent(selectedSection.id, "Imported note", JSON.stringify({type: "doc", content: paragraphs.length ? paragraphs : [{type:"paragraph"}]}), text);
        })()
        : await notesApi.importTextPage(selectedSection.id, sourcePath);
      await refresh({ notebookId: selectedNotebook?.id, sectionId: selectedSection.id, pageId });
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function addAttachments() {
    if (!page) return;
    const selected = await open({ multiple: true, directory: false, title: "Attach files" });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length === 0) return;
    try {
      await flushCurrentPage();
      for (const sourcePath of paths) {
        if (isNativeMobile()) {
          const bytes = await readFile(sourcePath);
          if (bytes.byteLength > 25_000_000) throw new Error("Attachments are limited to 25 MB on mobile.");
          const type = mobileFileType(bytes);
          const name = sourcePath.startsWith("content:") ? `Attachment ${Date.now()}.${type.extension}` : decodeURIComponent(sourcePath.split("/").pop() ?? `attachment.${type.extension}`).replace(/[\\/:*?"<>|]/g, "-");
          await notesApi.importAttachmentBytes(page.id, name, type.mime, Array.from(bytes));
        } else await notesApi.importAttachment(page.id, sourcePath);
      }
      await loadAttachments(page.id);
      setAttachmentsOpen(true);
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function removeAttachment(attachmentId: string) {
    if (!window.confirm("Remove this attachment from the page?")) return;
    try {
      await notesApi.removeAttachment(attachmentId);
      await loadAttachments();
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function exportCurrentPage(format: "markdown" | "html" | "text") {
    if (!page) return;
    const extension = format === "markdown" ? "md" : format === "html" ? "html" : "txt";
    const destination = await save({
      title: `Export ${title || "Untitled page"}`,
      defaultPath: `${(title || "Untitled page").replace(/[\\/:*?"<>|]/g, "-")}.${extension}`,
      filters: [{ name: format, extensions: [extension] }],
    });
    if (!destination) return;
    try {
      await flushCurrentPage();
      if (isNativeMobile()) await writeTextFile(destination, await notesApi.pageExportContent(page.id, format));
      else await notesApi.exportPage(page.id, destination, format);
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function createTagSummaryPage() {
    if (!selectedSection) return;
    const tag = chooseNumbered("Create summary for which tag?", availableTags, item => item.name);
    if (!tag) return;
    const matches = tree.notebooks.flatMap(notebook => notebook.sections.flatMap(section => section.pages
      .filter(item => item.tags.some(pageTag => pageTag.id === tag.id))
      .map(item => ({ notebook, section, page: item }))));
    if (!matches.length) { window.alert(`No pages currently use the ${tag.name} tag.`); return; }
    const now = new Date();
    const content = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1, textAlign: null }, content: [{ type: "text", text: `Tag Summary: ${tag.name}` }] },
        { type: "paragraph", attrs: { textAlign: null }, content: [{ type: "text", text: `Generated ${now.toLocaleString()} · ${matches.length} page${matches.length === 1 ? "" : "s"}` }] },
        ...matches.flatMap(({ notebook, section, page: item }) => [
          { type: "paragraph", attrs: { textAlign: null }, content: [
            { type: "text", text: item.title.trim() || "Untitled page", marks: [{ type: "link", attrs: { href: `lenota://page/${encodeURIComponent(item.id)}`, target: null, rel: "noopener noreferrer nofollow", class: null } }] },
            { type: "text", text: `  —  ${notebook.name} / ${section.name}` },
          ] },
          ...(item.preview ? [{ type: "paragraph", attrs: { textAlign: null }, content: [{ type: "text", text: item.preview.slice(0, 280) }] }] : []),
        ]),
      ],
    };
    const plain = [`Tag Summary: ${tag.name}`, ...matches.map(({ notebook, section, page: item }) => `${item.title || "Untitled page"} — ${notebook.name} / ${section.name}${item.preview ? `\n${item.preview}` : ""}`)].join("\n\n");
    try {
      await flushCurrentPage();
      const id = await notesApi.createPageWithContent(selectedSection.id, `Tag Summary - ${tag.name}`, JSON.stringify(content), plain);
      await refresh({ notebookId: selectedNotebook?.id ?? null, groupId: selectedSection.sectionGroupId, sectionId: selectedSection.id, pageId: id });
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function exportCurrentSectionBundle() {
    if (!selectedSection) return;
    if (isNativeMobile()) { setError("Folder exports are available on desktop. Use Export page on mobile."); return; }
    const destination = await open({ directory: true, multiple: false, title: "Choose folder for section export" });
    if (!destination || Array.isArray(destination)) return;
    try {
      await flushCurrentPage();
      await notesApi.exportSectionBundle(selectedSection.id, destination);
      window.alert(`Section exported to ${destination}`);
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  async function exportCurrentNotebookBundle() {
    if (!selectedNotebook) return;
    if (isNativeMobile()) { setError("Folder exports are available on desktop. Use Export page on mobile."); return; }
    const destination = await open({ directory: true, multiple: false, title: "Choose folder for notebook export" });
    if (!destination || Array.isArray(destination)) return;
    try {
      await flushCurrentPage();
      await notesApi.exportNotebookBundle(selectedNotebook.id, destination);
      window.alert(`Notebook exported to ${destination}`);
    } catch (commandError) { setError(errorMessage(commandError)); }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (accountSync.commitRef.current) { event.preventDefault(); return; }
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLocaleLowerCase();
      if (event.key === "Escape" && focusMode) {
        event.preventDefault();
        setFocusMode(false);
        return;
      }
      if (modifier && event.shiftKey && key === "f") {
        event.preventDefault();
        toggleFocusMode();
        return;
      }
      if (modifier && event.shiftKey && key === "l") {
        event.preventDefault();
        setTheme((value) => value === "dark" ? "light" : "dark");
        return;
      }
      if (event.altKey && !event.shiftKey && event.key === "ArrowUp") {
        event.preventDefault();
        void reorderPage("up");
        return;
      }
      if (event.altKey && !event.shiftKey && event.key === "ArrowDown") {
        event.preventDefault();
        void reorderPage("down");
        return;
      }
      if (event.altKey && event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        void makeSubpage();
        return;
      }
      if (event.altKey && event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        void promotePage();
        return;
      }
      if (!modifier) return;
      if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        window.print();
      } else if (key === "p" && event.shiftKey) {
        event.preventDefault();
        setCommandPaletteOpen(true);
      } else if (key === "q" && event.shiftKey) {
        event.preventDefault();
        void createQuickNote();
      } else if (key === "a" && event.shiftKey) {
        event.preventDefault();
        void addAttachments();
      } else if (key === "k") {
        event.preventDefault();
        openDiscovery("search");
      } else if (key === "s" && event.shiftKey) {
        event.preventDefault();
        void createSnapshot();
      } else if (key === "s") {
        event.preventDefault();
        void flushCurrentPage().catch((commandError) => setError(errorMessage(commandError)));
      } else if (key === "n" && event.shiftKey) {
        event.preventDefault();
        void createSection();
      } else if (key === "n") {
        event.preventDefault();
        void createPage();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    const nativeWindow = window as Window & { __LENOTA_BACK__?: () => boolean };
    nativeWindow.__LENOTA_BACK__ = () => {
      if (accountSync.commitRef.current) return true;
      if (accountOpen) { if (!accountSync.busy) setAccountOpen(false); return true; }
      if (commandPaletteOpen) { setCommandPaletteOpen(false); return true; }
      if (discoveryOpen) { setDiscoveryOpen(false); return true; }
      if (attachmentsOpen) { setAttachmentsOpen(false); return true; }
      if (templatesOpen) { setTemplatesOpen(false); return true; }
      if (historyOpen) { setHistoryOpen(false); return true; }
      if (trashOpen) { setTrashOpen(false); return true; }
      if (backupsOpen) { setBackupsOpen(false); return true; }
      if (compactNavigationOpen) { setCompactNavigationOpen(false); return true; }
      if (!window.dispatchEvent(new Event("lenota:back", {cancelable:true}))) return true;
      if (focusMode) { setFocusMode(false); return true; }
      if (backStackRef.current.length) { void goBack(); return true; }
      void flushCurrentPage().catch(() => {});
      return false;
    };
    return () => { delete nativeWindow.__LENOTA_BACK__; };
  });

  const appCommands: AppCommand[] = [
    { id: "account-sync", label: "Account & sync", run: () => setAccountOpen(true) },
    { id: "sync-now", label: "Sync notes now", run: () => void accountSync.syncNow() },
    { id: "search", label: "Search all notes", shortcut: "Ctrl+K", run: () => openDiscovery("search") },
    { id: "focus-mode", label: focusMode ? "Exit Focus Mode" : "Enter Focus Mode", shortcut: "Ctrl+Shift+F", run: toggleFocusMode },
    { id: "toggle-theme", label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`, shortcut: "Ctrl+Shift+L", run: () => setTheme((value) => value === "dark" ? "light" : "dark") },
    { id: "reset-interface", label: "Reset interface layout and reload", shortcut: "Ctrl+Shift+0", run: resetInterfaceAndReload },
    { id: "tag-summary", label: "Create Tag Summary page", run: () => void createTagSummaryPage() },
    ...(!isNativeMobile() ? [{ id: "print", label: "Print / Save current page as PDF", shortcut: "Ctrl+P", run: () => window.print() }] : []),
    { id: "new-page", label: "Create new page", shortcut: "Ctrl+N", run: () => void createPage() },
    { id: "new-section", label: "Create new section", shortcut: "Ctrl+Shift+N", run: () => void createSection() },
    { id: "section-default-template", label: "Set default template for current section", run: () => void setSectionDefaultTemplate() },
    { id: "quick-note", label: "Create Quick Note", shortcut: "Ctrl+Shift+Q", run: () => void createQuickNote() },
    { id: "copy-page-link", label: "Copy link to current page", run: () => void copyCurrentPageLink() },
    { id: "new-section-group", label: "Create section group", run: () => void createSectionGroup() },
    { id: "move-section-group", label: "Move current section group", run: () => selectedSectionGroupId && void moveSectionGroup(selectedSectionGroupId) },
    { id: "move-section-into-group", label: "Move current section into section group", run: () => void moveSectionToGroup() },
    { id: "make-subpage", label: "Make selected page a subpage", shortcut: "Alt+Shift+Right", run: () => void makeSubpage() },
    { id: "promote-page", label: "Promote selected subpage", shortcut: "Alt+Shift+Left", run: () => void promotePage() },
    { id: "import", label: "Import Markdown or text as a page", run: () => void importTextPage() },
    { id: "attach", label: "Attach files to current page", shortcut: "Ctrl+Shift+A", run: () => void addAttachments() },
    { id: "attachments", label: "Show page attachments", run: () => setAttachmentsOpen(true) },
    { id: "favorite", label: page?.isFavorite ? "Remove page from favorites" : "Add page to favorites", run: () => void toggleFavorite() },
    { id: "snapshot", label: "Save version snapshot", shortcut: "Ctrl+Shift+S", run: () => void createSnapshot() },
    { id: "export-md", label: "Export page as Markdown", run: () => void exportCurrentPage("markdown") },
    { id: "export-html", label: "Export page as HTML", run: () => void exportCurrentPage("html") },
    { id: "export-text", label: "Export page as text", run: () => void exportCurrentPage("text") },
    ...(!isNativeMobile() ? [
      { id: "export-section", label: "Export current section with attachments", run: () => void exportCurrentSectionBundle() },
      { id: "export-notebook", label: "Export current notebook with attachments", run: () => void exportCurrentNotebookBundle() },
    ] : []),
    { id: "backup", label: "Create workspace backup", run: () => void createBackup() },
    { id: "integrity", label: "Check workspace database integrity", run: () => void checkWorkspaceIntegrity() },
  ];

  const gridTemplateColumns = appGridTemplate({
    focusMode,
    navigationWidth: pageListWidth,
    navigationCollapsed: pageListCollapsed || compactLayout,
    resizerWidth: SIDEBAR_HANDLE_WIDTH,
  });
  const navigationVisuallyCollapsed = compactLayout ? !compactNavigationOpen : pageListCollapsed;
  const navigationTotalWidth = navigationVisuallyCollapsed ? 0 : 70 + pageListWidth + SIDEBAR_HANDLE_WIDTH;
  const navigationResizerLeft = compactLayout || navigationVisuallyCollapsed ? 0 : 70 + pageListWidth;
  const appShellStyle = {
    gridTemplateColumns,
    "--ln-navigation-total-width": `${navigationTotalWidth}px`,
    "--ln-navigation-resizer-left": `${navigationResizerLeft}px`,
  } as CSSProperties;

  return (
    <div
      className={`app-shell grid h-full min-h-0 overflow-hidden text-neutral-100 ${focusMode ? "is-focus-mode" : ""} ${navigationVisuallyCollapsed ? "is-navigation-collapsed" : ""}`}
      data-compact-layout={compactLayout?"true":"false"}
      style={appShellStyle}
      inert={accountSync.committing || undefined}
    >
      {compactLayout&&compactNavigationOpen&&!focusMode?<button type="button" className="compact-navigation-backdrop no-print" aria-label="Close navigation" onClick={()=>setCompactNavigationOpen(false)}/>:null}
      <NotebookSidebar
        notebooks={tree.notebooks}
        selectedNotebookId={selectedNotebook?.id ?? null}
        onSelectNotebook={(id) => {void selectNotebook(id);}}
        onCreateNotebook={() => void createNotebook()}
        onRenameNotebook={() => void renameNotebook()}
        onSetNotebookColor={(color) => void setNotebookColor(color)}
        onTrashNotebook={() => void trashNotebook()}
        onOpenSearch={() => openDiscovery("search")}
        onOpenRecent={() => openDiscovery("recent")}
        onOpenFavorites={() => openDiscovery("favorites")}
        onOpenTrash={() => void openTrash()}
        onOpenBackups={() => void openBackups()}
        onOpenAccount={() => { setCompactNavigationOpen(false); setAccountOpen(true); }}
        syncLabel={accountSync.busy ? "Syncing…" : accountSync.error ? `Sync: ${accountSync.error}` : accountSync.status.signedIn ? "Account & sync · Connected" : "Account & sync · Sign in"}
        canGoBack={backStackRef.current.length > 0}
        canGoForward={forwardStackRef.current.length > 0}
        onGoBack={() => void goBack()}
        onGoForward={() => void goForward()}
      />
      <PageList
        notebookName={selectedNotebook?.name ?? "Notebook"}
        notebooks={tree.notebooks}
        selectedNotebookId={selectedNotebook?.id ?? null}
        onSelectNotebook={(id) => {void selectNotebook(id);}}
        onCreateNotebook={() => void createNotebook()}
        onRenameNotebook={() => void renameNotebook()}
        onSetNotebookColor={(color) => void setNotebookColor(color)}
        onTrashNotebook={() => void trashNotebook()}
        onOpenSearch={() => openDiscovery("search")}
        onOpenRecent={() => openDiscovery("recent")}
        onOpenFavorites={() => openDiscovery("favorites")}
        onOpenTrash={() => void openTrash()}
        onOpenBackups={() => void openBackups()}
        sections={selectedNotebook?.sections ?? []}
        sectionGroups={selectedNotebook?.sectionGroups ?? []}
        selectedSectionId={selectedSection?.id ?? null}
        selectedGroupId={selectedSectionGroupId}
        selectedPageId={selectedPageId}
        onSelectSection={(id) => {void selectSection(id);}}
        onSelectGroup={(id) => void selectSectionGroup(id)}
        onSelectPage={(id) => {setCompactNavigationOpen(false);void selectPage(id);}}
        onCreateSection={() => void createSection()}
        onRenameSection={() => void renameSection()}
        onSetSectionColor={(color) => void setSectionColor(color)}
        onSetDefaultTemplate={() => void setSectionDefaultTemplate()}
        onMoveSection={() => void moveSection()}
        onMoveSectionToGroup={() => void moveSectionToGroup()}
        onTrashSection={() => void trashSection()}
        onCreateSectionGroup={() => void createSectionGroup()}
        onRenameSectionGroup={(id) => void renameSectionGroup(id)}
        onSetSectionGroupColor={(id, color) => void setSectionGroupColor(id, color)}
        onMoveSectionGroup={(id) => void moveSectionGroup(id)}
        onDeleteSectionGroup={(id) => void deleteSectionGroup(id)}
        onCreatePage={() => void createPage()}
        onCreateFromTemplate={() => setTemplatesOpen(true)}
        onDuplicatePage={() => void duplicatePage()}
        onMovePage={() => void movePage()}
        onTrashPage={() => void trashPage()}
        onMakeSubpage={() => void makeSubpage()}
        onPromotePage={() => void promotePage()}
        onMovePageUp={() => void reorderPage("up")}
        onMovePageDown={() => void reorderPage("down")}
        onSetPageParent={(pageId, parentId) => void setPageParent(pageId, parentId)}
        onPositionPage={(pageId, targetPageId, placement) => void positionPage(pageId, targetPageId, placement)}
      />
      <SidebarResizer
        label="page list"
        width={pageListWidth}
        minWidth={PAGE_LIST_MIN_WIDTH}
        maxWidth={PAGE_LIST_MAX_WIDTH}
        collapsed={navigationVisuallyCollapsed}
        toggleTop="56%"
        onPointerDown={startSidebarResize}
        onNudge={compactLayout?()=>{}:nudgeSidebar}
        onToggle={() => compactLayout?setCompactNavigationOpen(value=>!value):setPageListCollapsed((value) => !value)}
      />
      {compactLayout && !focusMode ? <>
        <button type="button" className="mobile-menu-button no-print" aria-label={compactNavigationOpen ? "Close notebooks" : "Open notebooks"} aria-expanded={compactNavigationOpen} onClick={() => setCompactNavigationOpen(value => !value)}>{compactNavigationOpen ? <X/> : <BookOpen/>}</button>
        {compactNavigationOpen ? <div className="mobile-drawer-heading no-print"><div><strong>Your notebooks</strong><span>Everything, in one place</span></div><button type="button" aria-label="Close notebooks drawer" onClick={() => setCompactNavigationOpen(false)}><X/></button></div> : null}
      </> : null}
      <PageEditor
        compactLayout={compactLayout}
        navigationOpen={compactLayout && compactNavigationOpen}
        key={`${page?.id ?? "empty"}:${editorInstanceKey}`}
        page={page}
        title={title}
        contentJson={contentJson}
        plainText={plainText}
        saveState={saveState}
        availableTags={availableTags}
        onChangeTitle={setTitle}
        onChangeContent={(nextJson, nextPlainText) => {
          setContentJson(nextJson);
          setPlainText(nextPlainText);
        }}
        onToggleFavorite={() => void toggleFavorite()}
        onAddTag={(tagId) => void addTag(tagId)}
        onCreateTag={() => void createTag()}
        onRemoveTag={(tagId) => void removeTag(tagId)}
        onOpenHistory={() => void openHistory()}
        onCreateSnapshot={() => void createSnapshot()}
        attachmentCount={attachments.length}
        onOpenAttachments={() => setAttachmentsOpen(true)}
        onAttachmentsChanged={() => void loadAttachments(page?.id)}
        onOpenCommands={() => setCommandPaletteOpen(true)}
        onExport={(format) => void exportCurrentPage(format)}
        linkablePages={linkablePages}
        focusPages={focusPages}
        onOpenInternalPage={(pageId, containerId) => void openInternalPage(pageId, containerId)}
        onCreatePage={() => void createPage()}
        onCreateNotebook={() => void createNotebook()}
        onCreateSection={() => void createSection()}
        onCreateFirstNote={() => void createFirstNote()}
        emptyWorkspaceLevel={tree.notebooks.length===0?"notebook":(selectedNotebook?.sections.length??0)===0?"section":"page"}
        targetContainerId={targetContainerId}
        onTargetContainerHandled={() => setTargetContainerId(null)}
        theme={theme}
        focusMode={focusMode}
        onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")}
        onToggleFocusMode={toggleFocusMode}
        canGoBack={backStackRef.current.length > 0}
        canGoForward={forwardStackRef.current.length > 0}
        onGoBack={() => void goBack()}
        onGoForward={() => void goForward()}
        focusBreadcrumb={[
          selectedNotebook?.sectionGroups.find((group) => group.id === selectedSectionGroupId)?.name,
          selectedSection?.name,
        ].filter(Boolean).join(" / ")}
      />

      {compactLayout && !focusMode ? <nav className="mobile-bottom-nav no-print" aria-label="Mobile navigation">
        <button type="button" aria-expanded={compactNavigationOpen} className={compactNavigationOpen ? "is-active" : ""} onClick={() => setCompactNavigationOpen(value => !value)}><BookOpen/><span>Notes</span></button>
        <button type="button" onClick={() => {setCompactNavigationOpen(false);openDiscovery("search");}}><Search/><span>Search</span></button>
        <button type="button" className="mobile-create-note" aria-label="Create new note" onClick={() => {setCompactNavigationOpen(false);void createFirstNote();}}><Plus/></button>
        <button type="button" disabled={!page} onClick={() => {setCompactNavigationOpen(false);setAttachmentsOpen(true);}}><Paperclip/><span>Files</span></button>
        <button type="button" onClick={() => {setCompactNavigationOpen(false);setCommandPaletteOpen(true);}}><MoreHorizontal/><span>More</span></button>
      </nav> : null}
      {attachmentsOpen && page ? (
        <AttachmentsPanel attachments={attachments} loading={attachmentsLoading} onAdd={() => void addAttachments()} onRemove={(id) => void removeAttachment(id)} onClose={() => setAttachmentsOpen(false)} />
      ) : null}

      {accountOpen ? <AccountDialog sync={accountSync} onClose={() => setAccountOpen(false)} /> : null}
      {accountSync.committing ? <div className="sync-commit-shield no-print" aria-label="Applying synced notes" /> : null}
      {commandPaletteOpen ? <CommandPalette commands={appCommands} onClose={() => setCommandPaletteOpen(false)} /> : null}

      {error ? (
        <div className="fixed bottom-4 right-4 z-[70] flex max-w-lg items-start gap-3 rounded-lg border border-red-400/20 bg-red-950/95 px-4 py-3 text-sm text-red-100 shadow-xl">
          <span className="min-w-0 flex-1">{error}</span>
          <button className="text-red-300 hover:text-white" onClick={() => setError(null)}>×</button>
        </div>
      ) : null}

      {discoveryOpen ? (
        <DiscoveryDialog
          mode={discoveryMode}
          query={discoveryQuery}
          results={discoveryResults}
          loading={discoveryLoading}
          onChangeQuery={setDiscoveryQuery}
          onChangeMode={setDiscoveryMode}
          onOpenPage={(result) => void openDiscoveredPage(result)}
          onClose={() => setDiscoveryOpen(false)}
        />
      ) : null}

      {templatesOpen ? (
        <TemplatesDialog onChoose={(template) => void createPageFromTemplate(template)} onClose={() => setTemplatesOpen(false)} />
      ) : null}

      {historyOpen ? (
        <HistoryDialog
          revisions={revisions}
          loading={historyLoading}
          creating={snapshotCreating}
          onClose={() => setHistoryOpen(false)}
          onRefresh={() => void loadRevisions()}
          onCreateSnapshot={() => void createSnapshot()}
          onRestore={(revisionId) => void restoreRevision(revisionId)}
        />
      ) : null}

      {trashOpen ? (
        <TrashDialog
          entries={trashEntries}
          loading={trashLoading}
          onClose={() => setTrashOpen(false)}
          onRefresh={() => void loadTrash()}
          onRestore={(id) => void restoreTrashEntry(id)}
          onDeleteForever={(id) => void deleteTrashEntry(id)}
          onEmptyTrash={() => void emptyTrash()}
        />
      ) : null}

      {backupsOpen ? (
        <BackupsDialog
          backups={backups}
          loading={backupsLoading}
          creating={backupCreating}
          onClose={() => setBackupsOpen(false)}
          onRefresh={() => void loadBackups()}
          onCreateBackup={() => void createBackup()}
        />
      ) : null}
    </div>
  );
}
