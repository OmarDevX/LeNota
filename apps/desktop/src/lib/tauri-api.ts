import { invoke } from "@tauri-apps/api/core";
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

export interface CommandError {
  code: string;
  message: string;
}

export interface CloudAiStatus {
  configured: boolean;
  provider: string;
}

export type CloudInkRecognition =
  | { kind:"text"; text:string; engine:string }
  | { kind:"math"; latex:string; engine:string };

export interface CloudAskResponse {
  blocks: unknown[];
  engine: string;
}

export interface CloudMathGraph {
  relationLatex: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  title?: string;
}

export interface CloudMathSolveResponse {
  status: "solved" | "identity" | "relation" | "not_solvable";
  resultLatex: string;
  graph: CloudMathGraph | null;
  engine: string;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (typeof error === "object" && error !== null && "message" in error) {
      throw new Error(String((error as { message: unknown }).message));
    }
    throw new Error(String(error));
  }
}

export const notesApi = {
  loadWorkspace: () => call<WorkspaceTree>("load_workspace"),
  getPage: (pageId: string) => call<Page>("get_page", { pageId }),
  createNotebook: (name: string) => call<string>("create_notebook", { name }),
  createSection: (notebookId: string, name: string) =>
    call<string>("create_section", { notebookId, name }),
  createSectionGroup: (notebookId: string, name: string, parentGroupId: string | null = null) =>
    call<string>("create_section_group", { notebookId, name, parentGroupId }),
  renameSectionGroup: (groupId: string, name: string) =>
    call<void>("rename_section_group", { groupId, name }),
  setSectionGroupParent: (groupId: string, parentGroupId: string | null) =>
    call<void>("set_section_group_parent", { groupId, parentGroupId }),
  moveSectionToGroup: (sectionId: string, groupId: string | null) =>
    call<void>("move_section_to_group", { sectionId, groupId }),
  deleteSectionGroup: (groupId: string) =>
    call<void>("delete_section_group", { groupId }),
  createPage: (sectionId: string, title: string) =>
    call<string>("create_page", { sectionId, title }),
  createPageWithContent: (
    sectionId: string,
    title: string,
    contentJson: string,
    plainText: string,
  ) => call<string>("create_page_with_content", { sectionId, title, contentJson, plainText }),
  duplicatePage: (pageId: string) => call<string>("duplicate_page", { pageId }),
  renameNotebook: (notebookId: string, name: string) =>
    call<void>("rename_notebook", { notebookId, name }),
  setNotebookColor: (notebookId: string, color: string) =>
    call<void>("set_notebook_color", { notebookId, color }),
  renameSection: (sectionId: string, name: string) =>
    call<void>("rename_section", { sectionId, name }),
  setSectionColor: (sectionId: string, color: string) =>
    call<void>("set_section_color", { sectionId, color }),
  setSectionGroupColor: (groupId: string, color: string) =>
    call<void>("set_section_group_color", { groupId, color }),
  setSectionDefaultTemplate: (sectionId: string, templateId: string | null) =>
    call<void>("set_section_default_template", { sectionId, templateId }),
  moveSection: (sectionId: string, notebookId: string) =>
    call<void>("move_section", { sectionId, notebookId }),
  movePage: (pageId: string, sectionId: string) =>
    call<void>("move_page", { pageId, sectionId }),
  setPageParent: (pageId: string, parentPageId: string | null) =>
    call<void>("set_page_parent", { pageId, parentPageId }),
  reorderPage: (pageId: string, direction: "up" | "down") =>
    call<void>("reorder_page", { pageId, direction }),
  positionPage: (pageId: string, targetPageId: string, placement: "before" | "after" | "child") =>
    call<void>("position_page", { pageId, targetPageId, placement }),
  checkWorkspaceIntegrity: () => call<string>("check_workspace_integrity"),
  updatePage: (pageId: string, title: string, contentJson: string, plainText: string) =>
    call<void>("update_page", { pageId, title, contentJson, plainText }),
  setPageFavorite: (pageId: string, isFavorite: boolean) =>
    call<void>("set_page_favorite", { pageId, isFavorite }),
  listTags: () => call<Tag[]>("list_tags"),
  createTag: (name: string, color: string) => call<Tag>("create_tag", { name, color }),
  addTagToPage: (pageId: string, tagId: string) =>
    call<void>("add_tag_to_page", { pageId, tagId }),
  removeTagFromPage: (pageId: string, tagId: string) =>
    call<void>("remove_tag_from_page", { pageId, tagId }),
  searchPages: (query: string) => call<PageLocation[]>("search_pages", { query }),
  listRecentPages: () => call<PageLocation[]>("list_recent_pages"),
  listFavoritePages: () => call<PageLocation[]>("list_favorite_pages"),
  createPageRevision: (pageId: string) =>
    call<string>("create_page_revision", { pageId }),
  listPageRevisions: (pageId: string) =>
    call<PageRevision[]>("list_page_revisions", { pageId }),
  restorePageRevision: (pageId: string, revisionId: string) =>
    call<Page>("restore_page_revision", { pageId, revisionId }),
  trashNotebook: (notebookId: string) => call<void>("trash_notebook", { notebookId }),
  trashSection: (sectionId: string) => call<void>("trash_section", { sectionId }),
  trashPage: (pageId: string) => call<void>("trash_page", { pageId }),
  listTrash: () => call<TrashEntry[]>("list_trash"),
  restoreTrashEntry: (trashId: string) => call<void>("restore_trash_entry", { trashId }),
  deleteTrashEntry: (trashId: string) => call<void>("delete_trash_entry", { trashId }),
  emptyTrash: () => call<void>("empty_trash"),
  createBackup: () => call<BackupInfo>("create_backup"),
  listBackups: () => call<BackupInfo[]>("list_backups"),
  listAttachments: (pageId: string) => call<Attachment[]>("list_attachments", { pageId }),
  importAttachment: (pageId: string, sourcePath: string) => call<Attachment>("import_attachment", { pageId, sourcePath }),
  importAttachmentBytes: (pageId: string, fileName: string, mimeType: string, bytes: number[]) =>
    call<Attachment>("import_attachment_bytes", { pageId, fileName, mimeType, bytes }),
  readAttachmentBytes: (attachmentId: string) =>
    call<ArrayBuffer>("read_attachment_bytes", { attachmentId }),
  ocrAttachment: (attachmentId: string, language = "eng") =>
    call<string>("ocr_attachment", { attachmentId, language }),
  ocrImageBytes: (bytes: number[], language = "eng") =>
    call<string>("ocr_image_bytes", { bytes, language }),
  cloudAiStatus: () => call<CloudAiStatus>("cloud_ai_status"),
  configureCloudAi: (apiKey: string | null) => call<CloudAiStatus>("configure_cloud_ai", { apiKey }),
  recognizeCloudInk: (bytes: number[], mode: "auto"|"math"|"text", language = "eng", hint = "", timeoutMs = 15_000) =>
    call<CloudInkRecognition>("ocr_cloud_ink_image_bytes", { bytes, mode, language, hint, timeoutMs }),
  cloudMathSolve: (latex: string, timeoutMs = 30_000, options?: { forceGraph?: boolean }) =>
    call<CloudMathSolveResponse>("cloud_math_solve", { latex, timeoutMs, forceGraph: options?.forceGraph ?? false }),
  cloudAsk: (prompt: string, pageContext: string, timeoutMs = 30_000) =>
    call<CloudAskResponse>("cloud_ask", { prompt, pageContext, timeoutMs }),
  cloudAskSelection: (bytes: number[], prompt: string, pageContext: string, timeoutMs = 30_000) =>
    call<CloudAskResponse>("cloud_ask_selection", { bytes, prompt, pageContext, timeoutMs }),
  prepareMicrophoneAccess: () => call<void>("prepare_microphone_access"),
  renderPdfPrintout: (pageId: string, sourcePath: string, options?: { dpi?: number; firstPage?: number | null; lastPage?: number | null }) =>
    call<Attachment[]>("render_pdf_printout", {
      pageId,
      sourcePath,
      dpi: options?.dpi ?? 144,
      firstPage: options?.firstPage ?? null,
      lastPage: options?.lastPage ?? null,
    }),
  removeAttachment: (attachmentId: string) => call<void>("remove_attachment", { attachmentId }),
  exportPage: (pageId: string, destinationPath: string, format: "markdown" | "html" | "text") =>
    call<void>("export_page", { pageId, destinationPath, format }),
  exportSectionBundle: (sectionId: string, destinationPath: string) =>
    call<void>("export_section_bundle", { sectionId, destinationPath }),
  exportNotebookBundle: (notebookId: string, destinationPath: string) =>
    call<void>("export_notebook_bundle", { notebookId, destinationPath }),
  importTextPage: (sectionId: string, sourcePath: string) => call<string>("import_text_page", { sectionId, sourcePath }),
};
