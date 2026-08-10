use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTree {
    pub notebooks: Vec<NotebookNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotebookNode {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
    pub section_groups: Vec<SectionGroupNode>,
    pub sections: Vec<SectionNode>,
}


#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectionGroupNode {
    pub id: String,
    pub notebook_id: String,
    pub parent_group_id: Option<String>,
    pub name: String,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectionNode {
    pub id: String,
    pub notebook_id: String,
    pub section_group_id: Option<String>,
    pub default_template_id: Option<String>,
    pub name: String,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
    pub pages: Vec<PageSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub id: String,
    pub section_id: String,
    pub title: String,
    pub preview: String,
    pub is_favorite: bool,
    pub parent_page_id: Option<String>,
    pub tags: Vec<Tag>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub section_id: String,
    pub title: String,
    pub content_json: String,
    pub plain_text: String,
    pub is_favorite: bool,
    pub parent_page_id: Option<String>,
    pub tags: Vec<Tag>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageLocation {
    pub page_id: String,
    pub section_id: String,
    pub notebook_id: String,
    pub title: String,
    pub preview: String,
    pub notebook_name: String,
    pub section_name: String,
    pub is_favorite: bool,
    pub tags: Vec<Tag>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageRevision {
    pub id: String,
    pub page_id: String,
    pub title: String,
    pub preview: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub title: String,
    pub parent_title: Option<String>,
    pub deleted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file_name: String,
    pub path: String,
    pub created_at: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub page_id: String,
    pub file_name: String,
    pub stored_path: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub created_at: String,
}
