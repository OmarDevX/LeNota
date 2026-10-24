export interface WorkspaceTree {
  notebooks: NotebookNode[];
}

export interface NotebookNode {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  sectionGroups: SectionGroupNode[];
  sections: SectionNode[];
}


export interface SectionGroupNode {
  id: string;
  notebookId: string;
  parentGroupId: string | null;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface SectionNode {
  id: string;
  notebookId: string;
  sectionGroupId: string | null;
  defaultTemplateId: string | null;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  pages: PageSummary[];
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface PageSummary {
  id: string;
  sectionId: string;
  title: string;
  preview: string;
  isFavorite: boolean;
  parentPageId: string | null;
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
}

export interface Page {
  id: string;
  sectionId: string;
  title: string;
  contentJson: string;
  plainText: string;
  isFavorite: boolean;
  parentPageId: string | null;
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
}

export interface PageLocation {
  pageId: string;
  sectionId: string;
  notebookId: string;
  title: string;
  preview: string;
  notebookName: string;
  sectionName: string;
  isFavorite: boolean;
  tags: Tag[];
  updatedAt: string;
}

export interface PageRevision {
  id: string;
  pageId: string;
  title: string;
  preview: string;
  createdAt: string;
}

export type TrashEntityType = "notebook" | "section" | "page";

export interface TrashEntry {
  id: string;
  entityType: TrashEntityType;
  entityId: string;
  title: string;
  parentTitle: string | null;
  deletedAt: string;
}

export interface BackupInfo {
  fileName: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
}

export interface Attachment {
  id: string;
  pageId: string;
  fileName: string;
  storedPath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}
