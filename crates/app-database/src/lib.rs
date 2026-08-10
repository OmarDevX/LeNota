use std::{
    fs,
    path::Path,
    sync::Mutex,
    time::{Duration, SystemTime},
};

use app_core::{
    Attachment, BackupInfo, NotebookNode, Page, PageLocation, PageRevision, PageSummary, SectionGroupNode, SectionNode, Tag,
    TrashEntry, WorkspaceTree, validate_name, validate_page_title,
};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use thiserror::Error;
use uuid::Uuid;

const ORDER_STEP: f64 = 1024.0;
const AUTOMATIC_BACKUP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const AUTOMATIC_REVISION_INTERVAL_MINUTES: f64 = 5.0;
const BACKUP_RETENTION_COUNT: usize = 30;
const DEFAULT_DOCUMENT: &str = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;

#[derive(Debug, Error)]
pub enum DatabaseError {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("file operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("requested item was not found")]
    NotFound,
    #[error("database lock was poisoned")]
    PoisonedLock,
}

pub type Result<T> = std::result::Result<T, DatabaseError>;

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.busy_timeout(Duration::from_secs(5))?;

        let database = Self {
            connection: Mutex::new(connection),
        };
        database.migrate()?;
        database.seed_if_empty()?;
        Ok(database)
    }

    pub fn open_in_memory() -> Result<Self> {
        let connection = Connection::open_in_memory()?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let database = Self {
            connection: Mutex::new(connection),
        };
        database.migrate()?;
        database.seed_if_empty()?;
        Ok(database)
    }

    fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| DatabaseError::PoisonedLock)
    }

    fn migrate(&self) -> Result<()> {
        let connection = self.connection()?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version < 1 {
            connection.execute_batch(include_str!("../migrations/0001_initial.sql"))?;
        }
        if version < 2 {
            connection.execute_batch(include_str!("../migrations/0002_trash_and_backups.sql"))?;
        }
        if version < 3 {
            connection.execute_batch(include_str!("../migrations/0003_productivity.sql"))?;
        }
        if version < 4 {
            connection.execute_batch(include_str!("../migrations/0004_attachments.sql"))?;
        }
        if version < 5 {
            connection.execute_batch(include_str!("../migrations/0005_page_hierarchy.sql"))?;
        }
        if version < 6 {
            connection.execute_batch(include_str!("../migrations/0006_section_groups.sql"))?;
        }
        Ok(())
    }

    fn seed_if_empty(&self) -> Result<()> {
        let mut connection = self.connection()?;
        let notebook_count: i64 =
            connection.query_row("SELECT COUNT(*) FROM notebooks", [], |row| row.get(0))?;
        if notebook_count > 0 {
            return Ok(());
        }

        let transaction = connection.transaction()?;
        let notebook_id = new_id();
        let section_id = new_id();
        let page_id = new_id();
        let welcome_text = "LeNota is ready. Start writing, format text, add tasks, tags, tables, and more.";
        let welcome_json = r#"{"type":"doc","content":[{"type":"heading","attrs":{"textAlign":null,"level":2},"content":[{"type":"text","text":"Welcome to LeNota"}]},{"type":"paragraph","attrs":{"textAlign":null},"content":[{"type":"text","text":"LeNota is ready. Start writing, format text, add tasks, tags, tables, and more."}]}]}"#;

        transaction.execute(
            "INSERT INTO notebooks (id, name, color, order_key) VALUES (?1, ?2, ?3, ?4)",
            params![notebook_id, "My Notebook", "#7c3aed", ORDER_STEP],
        )?;
        transaction.execute(
            "INSERT INTO sections (id, notebook_id, name, color, order_key) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![section_id, notebook_id, "Quick Notes", "#a78bfa", ORDER_STEP],
        )?;
        transaction.execute(
            "INSERT INTO pages (id, section_id, title, plain_text, content_json, order_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![page_id, section_id, "Welcome", welcome_text, welcome_json, ORDER_STEP],
        )?;
        refresh_search_index(&transaction, &page_id)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn load_workspace_tree(&self) -> Result<WorkspaceTree> {
        let connection = self.connection()?;
        let mut notebook_statement = connection.prepare(
            "SELECT id, name, color, created_at, updated_at
             FROM notebooks
             WHERE deleted_at IS NULL
             ORDER BY order_key, created_at",
        )?;
        let notebook_rows = notebook_statement.query_map([], |row| {
            Ok(NotebookNode {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                section_groups: Vec::new(),
                sections: Vec::new(),
            })
        })?;

        let mut notebooks = notebook_rows.collect::<std::result::Result<Vec<_>, _>>()?;
        drop(notebook_statement);
        for notebook in &mut notebooks {
            notebook.section_groups = load_section_groups(&connection, &notebook.id)?;
            notebook.sections = load_sections(&connection, &notebook.id)?;
        }

        Ok(WorkspaceTree { notebooks })
    }

    pub fn get_page(&self, page_id: &str) -> Result<Page> {
        let connection = self.connection()?;
        connection.execute(
            "UPDATE pages
             SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND deleted_at IS NULL",
            [page_id],
        )?;
        load_page(&connection, page_id)
    }

    pub fn create_notebook(&self, name: &str) -> Result<String> {
        let name = validated_name(name)?;
        let connection = self.connection()?;
        let id = new_id();
        let order_key = next_order_key(&connection, "notebooks", None)?;
        connection.execute(
            "INSERT INTO notebooks (id, name, order_key) VALUES (?1, ?2, ?3)",
            params![id, name, order_key],
        )?;
        Ok(id)
    }

    pub fn create_section(&self, notebook_id: &str, name: &str) -> Result<String> {
        let name = validated_name(name)?;
        let connection = self.connection()?;
        ensure_active_exists(&connection, "notebooks", notebook_id)?;
        let id = new_id();
        let order_key = next_order_key(
            &connection,
            "sections",
            Some(("notebook_id", notebook_id)),
        )?;
        connection.execute(
            "INSERT INTO sections (id, notebook_id, name, order_key) VALUES (?1, ?2, ?3, ?4)",
            params![id, notebook_id, name, order_key],
        )?;
        Ok(id)
    }

    pub fn create_section_group(&self, notebook_id: &str, name: &str, parent_group_id: Option<&str>) -> Result<String> {
        let name = validated_name(name)?;
        let connection = self.connection()?;
        ensure_active_exists(&connection, "notebooks", notebook_id)?;
        if let Some(parent_id) = parent_group_id {
            ensure_active_exists(&connection, "section_groups", parent_id)?;
            let parent_notebook: String = connection.query_row(
                "SELECT notebook_id FROM section_groups WHERE id = ?1 AND deleted_at IS NULL",
                [parent_id],
                |row| row.get(0),
            )?;
            if parent_notebook != notebook_id {
                return Err(DatabaseError::Validation("section groups cannot cross notebooks".into()));
            }
        }
        let id = new_id();
        let order_key = next_order_key(&connection, "section_groups", Some(("notebook_id", notebook_id)))?;
        connection.execute(
            "INSERT INTO section_groups (id, notebook_id, parent_group_id, name, order_key) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, notebook_id, parent_group_id, name, order_key],
        )?;
        Ok(id)
    }

    pub fn rename_section_group(&self, group_id: &str, name: &str) -> Result<()> {
        let name = validated_name(name)?;
        let connection = self.connection()?;
        update_name(&connection, "section_groups", group_id, name)
    }

    pub fn set_section_group_parent(&self, group_id: &str, parent_group_id: Option<&str>) -> Result<()> {
        let connection = self.connection()?;
        ensure_active_exists(&connection, "section_groups", group_id)?;
        if let Some(parent_id) = parent_group_id {
            if parent_id == group_id {
                return Err(DatabaseError::Validation("a section group cannot contain itself".into()));
            }
            ensure_active_exists(&connection, "section_groups", parent_id)?;
            let (group_notebook, parent_notebook): (String, String) = connection.query_row(
                "SELECT g.notebook_id, p.notebook_id FROM section_groups g JOIN section_groups p ON p.id = ?2 WHERE g.id = ?1",
                params![group_id, parent_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if group_notebook != parent_notebook {
                return Err(DatabaseError::Validation("nested section groups must stay in the same notebook".into()));
            }
            let mut cursor = Some(parent_id.to_string());
            while let Some(current) = cursor {
                if current == group_id {
                    return Err(DatabaseError::Validation("section group hierarchy cannot contain a cycle".into()));
                }
                cursor = connection.query_row(
                    "SELECT parent_group_id FROM section_groups WHERE id = ?1 AND deleted_at IS NULL",
                    [&current],
                    |row| row.get(0),
                ).optional()?.flatten();
            }
        }
        let changed = connection.execute(
            "UPDATE section_groups SET parent_group_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1 AND deleted_at IS NULL",
            params![group_id, parent_group_id],
        )?;
        changed_or_not_found(changed)
    }

    pub fn move_section_to_group(&self, section_id: &str, group_id: Option<&str>) -> Result<()> {
        let connection = self.connection()?;
        ensure_active_exists(&connection, "sections", section_id)?;
        let section_notebook: String = connection.query_row(
            "SELECT notebook_id FROM sections WHERE id = ?1 AND deleted_at IS NULL",
            [section_id],
            |row| row.get(0),
        )?;
        if let Some(group_id) = group_id {
            ensure_active_exists(&connection, "section_groups", group_id)?;
            let group_notebook: String = connection.query_row(
                "SELECT notebook_id FROM section_groups WHERE id = ?1 AND deleted_at IS NULL",
                [group_id],
                |row| row.get(0),
            )?;
            if group_notebook != section_notebook {
                return Err(DatabaseError::Validation("sections and section groups must stay in the same notebook".into()));
            }
        }
        let changed = connection.execute(
            "UPDATE sections SET section_group_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1 AND deleted_at IS NULL",
            params![section_id, group_id],
        )?;
        changed_or_not_found(changed)
    }

    pub fn delete_section_group(&self, group_id: &str) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        ensure_active_exists(&transaction, "section_groups", group_id)?;
        transaction.execute(
            "UPDATE sections SET section_group_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE section_group_id = ?1",
            [group_id],
        )?;
        transaction.execute(
            "UPDATE section_groups SET parent_group_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE parent_group_id = ?1 AND deleted_at IS NULL",
            [group_id],
        )?;
        let changed = transaction.execute("DELETE FROM section_groups WHERE id = ?1", [group_id])?;
        if changed == 0 { return Err(DatabaseError::NotFound); }
        transaction.commit()?;
        Ok(())
    }

    pub fn create_page(&self, section_id: &str, title: &str) -> Result<String> {
        self.create_page_with_content(section_id, title, DEFAULT_DOCUMENT, "")
    }

    pub fn create_page_with_content(
        &self,
        section_id: &str,
        title: &str,
        content_json: &str,
        plain_text: &str,
    ) -> Result<String> {
        let title = validated_page_title(title)?;
        validate_document_json(content_json)?;
        let mut connection = self.connection()?;
        ensure_active_exists(&connection, "sections", section_id)?;
        let transaction = connection.transaction()?;
        let id = new_id();
        let order_key = next_order_key(&transaction, "pages", Some(("section_id", section_id)))?;
        transaction.execute(
            "INSERT INTO pages (id, section_id, title, content_json, plain_text, order_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, section_id, title, content_json, plain_text, order_key],
        )?;
        refresh_search_index(&transaction, &id)?;
        transaction.commit()?;
        Ok(id)
    }

    pub fn duplicate_page(&self, page_id: &str) -> Result<String> {
        let connection = self.connection()?;
        let source: (String, String, String, String, Option<String>) = connection
            .query_row(
                "SELECT section_id, title, content_json, plain_text, parent_page_id
                 FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                [page_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?
            .ok_or(DatabaseError::NotFound)?;
        drop(connection);
        let duplicated = self.create_page_with_content(
            &source.0,
            &format!("{} copy", source.1.trim()),
            &source.2,
            &source.3,
        )?;
        if let Some(parent_id) = source.4 {
            self.set_page_parent(&duplicated, Some(&parent_id))?;
        }
        Ok(duplicated)
    }

    pub fn rename_notebook(&self, notebook_id: &str, name: &str) -> Result<()> {
        let name = validated_name(name)?;
        let connection = self.connection()?;
        update_name(&connection, "notebooks", notebook_id, name)
    }

    pub fn set_notebook_color(&self, notebook_id: &str, color: &str) -> Result<()> {
        let color = validated_color(color)?;
        let connection = self.connection()?;
        update_color(&connection, "notebooks", notebook_id, color)
    }

    pub fn rename_section(&self, section_id: &str, name: &str) -> Result<()> {
        let name = validated_name(name)?;
        let connection = self.connection()?;
        update_name(&connection, "sections", section_id, name)
    }

    pub fn set_section_color(&self, section_id: &str, color: &str) -> Result<()> {
        let color = validated_color(color)?;
        let connection = self.connection()?;
        update_color(&connection, "sections", section_id, color)
    }

    pub fn set_section_group_color(&self, group_id: &str, color: &str) -> Result<()> {
        let color = validated_color(color)?;
        let connection = self.connection()?;
        update_color(&connection, "section_groups", group_id, color)
    }

    pub fn set_section_default_template(&self, section_id: &str, template_id: Option<&str>) -> Result<()> {
        let connection = self.connection()?;
        ensure_active_exists(&connection, "sections", section_id)?;
        if let Some(template_id) = template_id {
            if template_id.trim().is_empty() || template_id.chars().count() > 80 {
                return Err(DatabaseError::Validation("template id is invalid".into()));
            }
        }
        let changed = connection.execute(
            "UPDATE sections SET default_template_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1 AND deleted_at IS NULL",
            params![section_id, template_id],
        )?;
        changed_or_not_found(changed)
    }

    pub fn move_section(&self, section_id: &str, notebook_id: &str) -> Result<()> {
        let connection = self.connection()?;
        ensure_active_exists(&connection, "sections", section_id)?;
        ensure_active_exists(&connection, "notebooks", notebook_id)?;
        let order_key = next_order_key(
            &connection,
            "sections",
            Some(("notebook_id", notebook_id)),
        )?;
        let changed = connection.execute(
            "UPDATE sections
             SET notebook_id = ?2,
                 section_group_id = NULL,
                 order_key = ?3,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND deleted_at IS NULL",
            params![section_id, notebook_id, order_key],
        )?;
        changed_or_not_found(changed)
    }

    pub fn move_page(&self, page_id: &str, section_id: &str) -> Result<()> {
        let connection = self.connection()?;
        ensure_active_exists(&connection, "pages", page_id)?;
        ensure_active_exists(&connection, "sections", section_id)?;
        let order_key = next_order_key(&connection, "pages", Some(("section_id", section_id)))?;
        let changed = connection.execute(
            "UPDATE pages
             SET section_id = ?2,
                 parent_page_id = NULL,
                 order_key = ?3,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND deleted_at IS NULL",
            params![page_id, section_id, order_key],
        )?;
        changed_or_not_found(changed)
    }

    pub fn set_page_parent(&self, page_id: &str, parent_page_id: Option<&str>) -> Result<()> {
        let connection = self.connection()?;
        ensure_active_exists(&connection, "pages", page_id)?;

        if let Some(parent_id) = parent_page_id {
            if parent_id == page_id {
                return Err(DatabaseError::Validation("a page cannot be its own parent".into()));
            }
            ensure_active_exists(&connection, "pages", parent_id)?;
            let (page_section, parent_section): (String, String) = connection.query_row(
                "SELECT p.section_id, parent.section_id FROM pages p JOIN pages parent ON parent.id = ?2 WHERE p.id = ?1",
                params![page_id, parent_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if page_section != parent_section {
                return Err(DatabaseError::Validation("subpages must stay in the same section as their parent".into()));
            }

            let mut cursor = Some(parent_id.to_string());
            while let Some(current) = cursor {
                if current == page_id {
                    return Err(DatabaseError::Validation("page hierarchy cannot contain a cycle".into()));
                }
                cursor = connection.query_row(
                    "SELECT parent_page_id FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                    [&current],
                    |row| row.get(0),
                ).optional()?.flatten();
            }
        }

        let changed = connection.execute(
            "UPDATE pages SET parent_page_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1 AND deleted_at IS NULL",
            params![page_id, parent_page_id],
        )?;
        changed_or_not_found(changed)
    }

    pub fn reorder_page(&self, page_id: &str, direction: &str) -> Result<()> {
        if direction != "up" && direction != "down" {
            return Err(DatabaseError::Validation("direction must be up or down".into()));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let current: Option<(String, Option<String>, f64)> = transaction.query_row(
            "SELECT section_id, parent_page_id, order_key FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            [page_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let (section_id, parent_id, order_key) = current.ok_or(DatabaseError::NotFound)?;
        let comparator = if direction == "up" { "<" } else { ">" };
        let ordering = if direction == "up" { "DESC" } else { "ASC" };
        let sql = format!(
            "SELECT id, order_key FROM pages WHERE section_id = ?1 AND parent_page_id IS ?2 AND deleted_at IS NULL AND order_key {comparator} ?3 ORDER BY order_key {ordering}, created_at {ordering} LIMIT 1"
        );
        let neighbor: Option<(String, f64)> = transaction.query_row(
            &sql, params![section_id, parent_id, order_key], |row| Ok((row.get(0)?, row.get(1)?))
        ).optional()?;
        if let Some((neighbor_id, neighbor_order)) = neighbor {
            transaction.execute("UPDATE pages SET order_key = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1", params![page_id, neighbor_order])?;
            transaction.execute("UPDATE pages SET order_key = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1", params![neighbor_id, order_key])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn position_page(&self, page_id: &str, target_page_id: &str, placement: &str) -> Result<()> {
        if page_id == target_page_id {
            return Err(DatabaseError::Validation("a page cannot be positioned relative to itself".into()));
        }
        if placement == "child" {
            return self.set_page_parent(page_id, Some(target_page_id));
        }
        if placement != "before" && placement != "after" {
            return Err(DatabaseError::Validation("page placement must be before, after, or child".into()));
        }

        let (page_section, target_section, target_parent): (String, String, Option<String>) = {
            let connection = self.connection()?;
            ensure_active_exists(&connection, "pages", page_id)?;
            ensure_active_exists(&connection, "pages", target_page_id)?;
            let page_section: String = connection.query_row(
                "SELECT section_id FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                [page_id], |row| row.get(0),
            )?;
            let (target_section, target_parent): (String, Option<String>) = connection.query_row(
                "SELECT section_id, parent_page_id FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                [target_page_id], |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            (page_section, target_section, target_parent)
        };
        if page_section != target_section {
            return Err(DatabaseError::Validation("pages must be in the same section to reorder them".into()));
        }

        // Reuse the hierarchy validator so moving an ancestor beside one of its own
        // descendants cannot create a cycle.
        self.set_page_parent(page_id, target_parent.as_deref())?;

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let mut statement = transaction.prepare(
            "SELECT id FROM pages
             WHERE section_id = ?1 AND parent_page_id IS ?2 AND deleted_at IS NULL
             ORDER BY order_key, created_at",
        )?;
        let rows = statement.query_map(params![page_section, target_parent], |row| row.get::<_, String>(0))?;
        let mut ids = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        ids.retain(|id| id != page_id);
        let target_index = ids.iter().position(|id| id == target_page_id).ok_or(DatabaseError::NotFound)?;
        let insert_at = if placement == "before" { target_index } else { target_index + 1 };
        ids.insert(insert_at.min(ids.len()), page_id.to_string());
        for (index, id) in ids.iter().enumerate() {
            transaction.execute(
                "UPDATE pages SET order_key = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
                params![id, (index as f64 + 1.0) * ORDER_STEP],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn integrity_check(&self) -> Result<String> {
        let connection = self.connection()?;
        let result: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        Ok(result)
    }

    pub fn update_page(
        &self,
        page_id: &str,
        title: &str,
        content_json: &str,
        plain_text: &str,
    ) -> Result<()> {
        let title = validated_page_title(title)?;
        validate_document_json(content_json)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let current: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT title, content_json, plain_text
                 FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                [page_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let current = current.ok_or(DatabaseError::NotFound)?;
        if current.0 == title && current.1 == content_json && current.2 == plain_text {
            return Ok(());
        }

        create_automatic_revision_if_due(&transaction, page_id, &current)?;
        transaction.execute(
            "UPDATE pages
             SET title = ?2,
                 content_json = ?3,
                 plain_text = ?4,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND deleted_at IS NULL",
            params![page_id, title, content_json, plain_text],
        )?;
        refresh_search_index(&transaction, page_id)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn set_page_favorite(&self, page_id: &str, is_favorite: bool) -> Result<()> {
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE pages
             SET is_favorite = ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND deleted_at IS NULL",
            params![page_id, is_favorite],
        )?;
        changed_or_not_found(changed)
    }

    pub fn list_tags(&self) -> Result<Vec<Tag>> {
        let connection = self.connection()?;
        load_all_tags(&connection)
    }

    pub fn create_tag(&self, name: &str, color: &str) -> Result<Tag> {
        let name = validated_tag_name(name)?;
        let color = validated_color(color)?;
        let connection = self.connection()?;
        let id = new_id();
        connection.execute(
            "INSERT OR IGNORE INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
            params![id, name, color],
        )?;
        connection
            .query_row(
                "SELECT id, name, color FROM tags WHERE name = ?1 COLLATE NOCASE",
                [name],
                |row| {
                    Ok(Tag {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        color: row.get(2)?,
                    })
                },
            )
            .map_err(DatabaseError::from)
    }

    pub fn add_tag_to_page(&self, page_id: &str, tag_id: &str) -> Result<()> {
        let mut connection = self.connection()?;
        ensure_active_exists(&connection, "pages", page_id)?;
        ensure_tag_exists(&connection, tag_id)?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?1, ?2)",
            params![page_id, tag_id],
        )?;
        refresh_search_index(&transaction, page_id)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn remove_tag_from_page(&self, page_id: &str, tag_id: &str) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM page_tags WHERE page_id = ?1 AND tag_id = ?2",
            params![page_id, tag_id],
        )?;
        refresh_search_index(&transaction, page_id)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn search_pages(&self, query: &str) -> Result<Vec<PageLocation>> {
        let query = build_fts_query(query);
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT p.id,
                    p.section_id,
                    s.notebook_id,
                    p.title,
                    snippet(page_search, 2, '', '', ' … ', 20),
                    n.name,
                    s.name,
                    p.is_favorite,
                    p.updated_at
             FROM page_search
             JOIN pages p ON p.id = page_search.page_id
             JOIN sections s ON s.id = p.section_id
             JOIN notebooks n ON n.id = s.notebook_id
             WHERE page_search MATCH ?1
               AND p.deleted_at IS NULL
               AND s.deleted_at IS NULL
               AND n.deleted_at IS NULL
             ORDER BY bm25(page_search), p.updated_at DESC
             LIMIT 100",
        )?;
        let rows = statement.query_map([query], raw_page_location)?;
        let raw = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        hydrate_locations(&connection, raw)
    }

    pub fn list_recent_pages(&self) -> Result<Vec<PageLocation>> {
        let connection = self.connection()?;
        query_page_locations(
            &connection,
            "SELECT p.id,
                    p.section_id,
                    s.notebook_id,
                    p.title,
                    substr(p.plain_text, 1, 220),
                    n.name,
                    s.name,
                    p.is_favorite,
                    p.updated_at
             FROM pages p
             JOIN sections s ON s.id = p.section_id
             JOIN notebooks n ON n.id = s.notebook_id
             WHERE p.deleted_at IS NULL
               AND s.deleted_at IS NULL
               AND n.deleted_at IS NULL
               AND p.last_opened_at IS NOT NULL
             ORDER BY p.last_opened_at DESC
             LIMIT 40",
        )
    }

    pub fn list_favorite_pages(&self) -> Result<Vec<PageLocation>> {
        let connection = self.connection()?;
        query_page_locations(
            &connection,
            "SELECT p.id,
                    p.section_id,
                    s.notebook_id,
                    p.title,
                    substr(p.plain_text, 1, 220),
                    n.name,
                    s.name,
                    p.is_favorite,
                    p.updated_at
             FROM pages p
             JOIN sections s ON s.id = p.section_id
             JOIN notebooks n ON n.id = s.notebook_id
             WHERE p.deleted_at IS NULL
               AND s.deleted_at IS NULL
               AND n.deleted_at IS NULL
               AND p.is_favorite = 1
             ORDER BY p.updated_at DESC
             LIMIT 100",
        )
    }

    pub fn create_page_revision(&self, page_id: &str) -> Result<String> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let current: (String, String, String) = transaction
            .query_row(
                "SELECT title, content_json, plain_text
                 FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                [page_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or(DatabaseError::NotFound)?;
        let revision_id = insert_revision(&transaction, page_id, &current)?;
        transaction.commit()?;
        Ok(revision_id)
    }

    pub fn list_page_revisions(&self, page_id: &str) -> Result<Vec<PageRevision>> {
        let connection = self.connection()?;
        ensure_active_exists(&connection, "pages", page_id)?;
        let mut statement = connection.prepare(
            "SELECT id, page_id, title, substr(plain_text, 1, 220), created_at
             FROM page_revisions
             WHERE page_id = ?1
             ORDER BY created_at DESC
             LIMIT 100",
        )?;
        let rows = statement.query_map([page_id], |row| {
            Ok(PageRevision {
                id: row.get(0)?,
                page_id: row.get(1)?,
                title: row.get(2)?,
                preview: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn restore_page_revision(&self, page_id: &str, revision_id: &str) -> Result<Page> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let current: (String, String, String) = transaction
            .query_row(
                "SELECT title, content_json, plain_text
                 FROM pages WHERE id = ?1 AND deleted_at IS NULL",
                [page_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or(DatabaseError::NotFound)?;
        let revision: (String, String, String) = transaction
            .query_row(
                "SELECT title, content_json, plain_text
                 FROM page_revisions WHERE id = ?1 AND page_id = ?2",
                params![revision_id, page_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or(DatabaseError::NotFound)?;

        insert_revision(&transaction, page_id, &current)?;
        transaction.execute(
            "UPDATE pages
             SET title = ?2,
                 content_json = ?3,
                 plain_text = ?4,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![page_id, revision.0, revision.1, revision.2],
        )?;
        refresh_search_index(&transaction, page_id)?;
        transaction.commit()?;
        load_page(&connection, page_id)
    }

    pub fn trash_notebook(&self, notebook_id: &str) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let title: String = transaction
            .query_row(
                "SELECT name FROM notebooks WHERE id = ?1 AND deleted_at IS NULL",
                [notebook_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(DatabaseError::NotFound)?;
        let batch_id = insert_trash_entry(&transaction, "notebook", notebook_id, &title, None)?;

        transaction.execute(
            "UPDATE notebooks
             SET deleted_at = (SELECT deleted_at FROM trash_entries WHERE id = ?1), trash_batch_id = ?1
             WHERE id = ?2 AND deleted_at IS NULL",
            params![batch_id, notebook_id],
        )?;
        transaction.execute(
            "UPDATE sections
             SET deleted_at = (SELECT deleted_at FROM trash_entries WHERE id = ?1), trash_batch_id = ?1
             WHERE notebook_id = ?2 AND deleted_at IS NULL",
            params![batch_id, notebook_id],
        )?;
        transaction.execute(
            "UPDATE pages
             SET deleted_at = (SELECT deleted_at FROM trash_entries WHERE id = ?1), trash_batch_id = ?1
             WHERE section_id IN (SELECT id FROM sections WHERE notebook_id = ?2)
               AND deleted_at IS NULL",
            params![batch_id, notebook_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn trash_section(&self, section_id: &str) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let item: Option<(String, String)> = transaction
            .query_row(
                "SELECT s.name, n.name
                 FROM sections s
                 JOIN notebooks n ON n.id = s.notebook_id
                 WHERE s.id = ?1 AND s.deleted_at IS NULL AND n.deleted_at IS NULL",
                [section_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (title, parent_title) = item.ok_or(DatabaseError::NotFound)?;
        let batch_id = insert_trash_entry(
            &transaction,
            "section",
            section_id,
            &title,
            Some(&parent_title),
        )?;

        transaction.execute(
            "UPDATE sections
             SET deleted_at = (SELECT deleted_at FROM trash_entries WHERE id = ?1), trash_batch_id = ?1
             WHERE id = ?2 AND deleted_at IS NULL",
            params![batch_id, section_id],
        )?;
        transaction.execute(
            "UPDATE pages
             SET deleted_at = (SELECT deleted_at FROM trash_entries WHERE id = ?1), trash_batch_id = ?1
             WHERE section_id = ?2 AND deleted_at IS NULL",
            params![batch_id, section_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn trash_page(&self, page_id: &str) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let item: Option<(String, String)> = transaction
            .query_row(
                "SELECT p.title, n.name || ' / ' || s.name
                 FROM pages p
                 JOIN sections s ON s.id = p.section_id
                 JOIN notebooks n ON n.id = s.notebook_id
                 WHERE p.id = ?1
                   AND p.deleted_at IS NULL
                   AND s.deleted_at IS NULL
                   AND n.deleted_at IS NULL",
                [page_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (title, parent_title) = item.ok_or(DatabaseError::NotFound)?;
        let batch_id = insert_trash_entry(
            &transaction,
            "page",
            page_id,
            &title,
            Some(&parent_title),
        )?;
        transaction.execute(
            "UPDATE pages
             SET deleted_at = (SELECT deleted_at FROM trash_entries WHERE id = ?1), trash_batch_id = ?1
             WHERE id = ?2 AND deleted_at IS NULL",
            params![batch_id, page_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn list_trash(&self) -> Result<Vec<TrashEntry>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, entity_type, entity_id, title, parent_title, deleted_at
             FROM trash_entries
             ORDER BY deleted_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(TrashEntry {
                id: row.get(0)?,
                entity_type: row.get(1)?,
                entity_id: row.get(2)?,
                title: row.get(3)?,
                parent_title: row.get(4)?,
                deleted_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn restore_trash_entry(&self, trash_id: &str) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let item: Option<(String, String)> = transaction
            .query_row(
                "SELECT entity_type, entity_id FROM trash_entries WHERE id = ?1",
                [trash_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (entity_type, entity_id) = item.ok_or(DatabaseError::NotFound)?;
        ensure_restore_parent_is_active(&transaction, &entity_type, &entity_id)?;

        for table in ["notebooks", "sections", "pages"] {
            let query = format!(
                "UPDATE {table} SET deleted_at = NULL, trash_batch_id = NULL WHERE trash_batch_id = ?1"
            );
            transaction.execute(&query, [trash_id])?;
        }
        transaction.execute("DELETE FROM trash_entries WHERE id = ?1", [trash_id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn delete_trash_entry(&self, trash_id: &str) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let item: Option<(String, String)> = transaction
            .query_row(
                "SELECT entity_type, entity_id FROM trash_entries WHERE id = ?1",
                [trash_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (entity_type, entity_id) = item.ok_or(DatabaseError::NotFound)?;
        delete_entity(&transaction, &entity_type, &entity_id)?;
        transaction.execute("DELETE FROM trash_entries WHERE id = ?1", [trash_id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn empty_trash(&self) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM page_search
             WHERE page_id IN (
                 SELECT p.id FROM pages p
                 LEFT JOIN sections s ON s.id = p.section_id
                 LEFT JOIN notebooks n ON n.id = s.notebook_id
                 WHERE p.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL OR n.deleted_at IS NOT NULL
             )",
            [],
        )?;
        transaction.execute(
            "DELETE FROM notebooks
             WHERE id IN (SELECT entity_id FROM trash_entries WHERE entity_type = 'notebook')",
            [],
        )?;
        transaction.execute(
            "DELETE FROM sections
             WHERE id IN (SELECT entity_id FROM trash_entries WHERE entity_type = 'section')",
            [],
        )?;
        transaction.execute(
            "DELETE FROM pages
             WHERE id IN (SELECT entity_id FROM trash_entries WHERE entity_type = 'page')",
            [],
        )?;
        transaction.execute("DELETE FROM trash_entries", [])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn create_backup(&self, backup_dir: impl AsRef<Path>) -> Result<BackupInfo> {
        let backup_dir = backup_dir.as_ref();
        fs::create_dir_all(backup_dir)?;
        let now = Utc::now();
        let file_name = format!(
            "workspace-{}-{}.sqlite3",
            now.format("%Y%m%d-%H%M%S-%3f"),
            &new_id()[..8]
        );
        let destination = backup_dir.join(&file_name);

        let backup_result = (|| -> Result<()> {
            let connection = self.connection()?;
            connection.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()))?;
            connection.execute(
                "VACUUM INTO ?1",
                [destination.to_string_lossy().as_ref()],
            )?;
            Ok(())
        })();

        if let Err(error) = backup_result {
            let _ = fs::remove_file(&destination);
            return Err(error);
        }

        let size_bytes = fs::metadata(&destination)?.len();
        prune_old_backups(backup_dir, BACKUP_RETENTION_COUNT)?;
        Ok(BackupInfo {
            file_name,
            path: destination.to_string_lossy().into_owned(),
            created_at: now.to_rfc3339(),
            size_bytes,
        })
    }


    pub fn list_attachments(&self, page_id: &str) -> Result<Vec<Attachment>> {
        let connection = self.connection()?;
        ensure_active_exists(&connection, "pages", page_id)?;
        let mut statement = connection.prepare(
            "SELECT id, page_id, file_name, stored_path, mime_type, size_bytes, created_at
             FROM attachments WHERE page_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([page_id], |row| {
            Ok(Attachment {
                id: row.get(0)?,
                page_id: row.get(1)?,
                file_name: row.get(2)?,
                stored_path: row.get(3)?,
                mime_type: row.get(4)?,
                size_bytes: row.get::<_, i64>(5)?.max(0) as u64,
                created_at: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn get_attachment(&self, attachment_id: &str) -> Result<Attachment> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, page_id, file_name, stored_path, mime_type, size_bytes, created_at
                 FROM attachments WHERE id = ?1",
                [attachment_id],
                |row| Ok(Attachment {
                    id: row.get(0)?,
                    page_id: row.get(1)?,
                    file_name: row.get(2)?,
                    stored_path: row.get(3)?,
                    mime_type: row.get(4)?,
                    size_bytes: row.get::<_, i64>(5)?.max(0) as u64,
                    created_at: row.get(6)?,
                }),
            )
            .optional()?
            .ok_or(DatabaseError::NotFound)
    }

    pub fn add_attachment_record(
        &self,
        page_id: &str,
        file_name: &str,
        stored_path: &str,
        mime_type: &str,
        size_bytes: u64,
    ) -> Result<Attachment> {
        let connection = self.connection()?;
        ensure_active_exists(&connection, "pages", page_id)?;
        let id = new_id();
        connection.execute(
            "INSERT INTO attachments (id, page_id, file_name, stored_path, mime_type, size_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, page_id, file_name, stored_path, mime_type, size_bytes as i64],
        )?;
        connection.query_row(
            "SELECT id, page_id, file_name, stored_path, mime_type, size_bytes, created_at
             FROM attachments WHERE id = ?1",
            [id],
            |row| Ok(Attachment {
                id: row.get(0)?, page_id: row.get(1)?, file_name: row.get(2)?,
                stored_path: row.get(3)?, mime_type: row.get(4)?,
                size_bytes: row.get::<_, i64>(5)?.max(0) as u64, created_at: row.get(6)?,
            }),
        ).map_err(Into::into)
    }

    pub fn remove_attachment_record(&self, attachment_id: &str) -> Result<String> {
        let connection = self.connection()?;
        let path: String = connection
            .query_row("SELECT stored_path FROM attachments WHERE id = ?1", [attachment_id], |row| row.get(0))
            .optional()?
            .ok_or(DatabaseError::NotFound)?;
        connection.execute("DELETE FROM attachments WHERE id = ?1", [attachment_id])?;
        Ok(path)
    }

    pub fn page_export_data(&self, page_id: &str) -> Result<(String, String)> {
        let page = self.get_page(page_id)?;
        Ok((page.title, page.plain_text))
    }

    pub fn create_backup_if_due(
        &self,
        backup_dir: impl AsRef<Path>,
    ) -> Result<Option<BackupInfo>> {
        let backup_dir = backup_dir.as_ref();
        let latest_modified = latest_backup_modified_time(backup_dir)?;
        let is_due = latest_modified
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_none_or(|age| age >= AUTOMATIC_BACKUP_INTERVAL);

        if is_due {
            self.create_backup(backup_dir).map(Some)
        } else {
            Ok(None)
        }
    }

    pub fn list_backups(&self, backup_dir: impl AsRef<Path>) -> Result<Vec<BackupInfo>> {
        let backup_dir = backup_dir.as_ref();
        if !backup_dir.exists() {
            return Ok(Vec::new());
        }

        let mut backups = Vec::new();
        for entry in fs::read_dir(backup_dir)? {
            let entry = entry?;
            let path = entry.path();
            if !is_backup_file(&path) {
                continue;
            }
            let metadata = entry.metadata()?;
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let created_at: DateTime<Utc> = modified.into();
            backups.push(BackupInfo {
                file_name: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                created_at: created_at.to_rfc3339(),
                size_bytes: metadata.len(),
            });
        }
        backups.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(backups)
    }
}

#[derive(Debug)]
struct RawPageLocation {
    page_id: String,
    section_id: String,
    notebook_id: String,
    title: String,
    preview: String,
    notebook_name: String,
    section_name: String,
    is_favorite: bool,
    updated_at: String,
}

fn load_page(connection: &Connection, page_id: &str) -> Result<Page> {
    let mut page = connection
        .query_row(
            "SELECT id, section_id, title, content_json, plain_text, is_favorite, parent_page_id, created_at, updated_at
             FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            [page_id],
            |row| {
                Ok(Page {
                    id: row.get(0)?,
                    section_id: row.get(1)?,
                    title: row.get(2)?,
                    content_json: row.get(3)?,
                    plain_text: row.get(4)?,
                    is_favorite: row.get(5)?,
                    parent_page_id: row.get(6)?,
                    tags: Vec::new(),
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()?
        .ok_or(DatabaseError::NotFound)?;
    page.tags = load_page_tags(connection, page_id)?;
    Ok(page)
}

fn load_section_groups(connection: &Connection, notebook_id: &str) -> Result<Vec<SectionGroupNode>> {
    let mut statement = connection.prepare(
        "SELECT id, notebook_id, parent_group_id, name, color, created_at, updated_at
         FROM section_groups
         WHERE notebook_id = ?1 AND deleted_at IS NULL
         ORDER BY order_key, created_at",
    )?;
    let rows = statement.query_map([notebook_id], |row| {
        Ok(SectionGroupNode {
            id: row.get(0)?,
            notebook_id: row.get(1)?,
            parent_group_id: row.get(2)?,
            name: row.get(3)?,
            color: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn load_sections(connection: &Connection, notebook_id: &str) -> Result<Vec<SectionNode>> {
    let mut statement = connection.prepare(
        "SELECT id, notebook_id, section_group_id, default_template_id, name, color, created_at, updated_at
         FROM sections
         WHERE notebook_id = ?1 AND deleted_at IS NULL
         ORDER BY order_key, created_at",
    )?;
    let rows = statement.query_map([notebook_id], |row| {
        Ok(SectionNode {
            id: row.get(0)?,
            notebook_id: row.get(1)?,
            section_group_id: row.get(2)?,
            default_template_id: row.get(3)?,
            name: row.get(4)?,
            color: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            pages: Vec::new(),
        })
    })?;

    let mut sections = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    for section in &mut sections {
        section.pages = load_page_summaries(connection, &section.id)?;
    }
    Ok(sections)
}

fn load_page_summaries(connection: &Connection, section_id: &str) -> Result<Vec<PageSummary>> {
    let mut statement = connection.prepare(
        "SELECT id, section_id, title, substr(plain_text, 1, 180), is_favorite, parent_page_id, created_at, updated_at
         FROM pages
         WHERE section_id = ?1 AND deleted_at IS NULL
         ORDER BY order_key, created_at",
    )?;
    let rows = statement.query_map([section_id], |row| {
        Ok(PageSummary {
            id: row.get(0)?,
            section_id: row.get(1)?,
            title: row.get(2)?,
            preview: row.get(3)?,
            is_favorite: row.get(4)?,
            parent_page_id: row.get(5)?,
            tags: Vec::new(),
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?;
    let mut pages = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    for page in &mut pages {
        page.tags = load_page_tags(connection, &page.id)?;
    }
    Ok(pages)
}

fn load_page_tags(connection: &Connection, page_id: &str) -> Result<Vec<Tag>> {
    let mut statement = connection.prepare(
        "SELECT t.id, t.name, t.color
         FROM tags t
         JOIN page_tags pt ON pt.tag_id = t.id
         WHERE pt.page_id = ?1
         ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = statement.query_map([page_id], |row| {
        Ok(Tag {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn load_all_tags(connection: &Connection) -> Result<Vec<Tag>> {
    let mut statement = connection.prepare(
        "SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(Tag {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn raw_page_location(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawPageLocation> {
    Ok(RawPageLocation {
        page_id: row.get(0)?,
        section_id: row.get(1)?,
        notebook_id: row.get(2)?,
        title: row.get(3)?,
        preview: row.get(4)?,
        notebook_name: row.get(5)?,
        section_name: row.get(6)?,
        is_favorite: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn query_page_locations(connection: &Connection, sql: &str) -> Result<Vec<PageLocation>> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], raw_page_location)?;
    let raw = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    hydrate_locations(connection, raw)
}

fn hydrate_locations(
    connection: &Connection,
    raw: Vec<RawPageLocation>,
) -> Result<Vec<PageLocation>> {
    raw.into_iter()
        .map(|item| {
            Ok(PageLocation {
                tags: load_page_tags(connection, &item.page_id)?,
                page_id: item.page_id,
                section_id: item.section_id,
                notebook_id: item.notebook_id,
                title: item.title,
                preview: item.preview,
                notebook_name: item.notebook_name,
                section_name: item.section_name,
                is_favorite: item.is_favorite,
                updated_at: item.updated_at,
            })
        })
        .collect()
}

fn create_automatic_revision_if_due(
    transaction: &Transaction<'_>,
    page_id: &str,
    current: &(String, String, String),
) -> Result<()> {
    let should_create: bool = transaction.query_row(
        "SELECT CASE
             WHEN MAX(created_at) IS NULL THEN 1
             WHEN (julianday('now') - julianday(MAX(created_at))) * 1440.0 >= ?2 THEN 1
             ELSE 0
         END
         FROM page_revisions
         WHERE page_id = ?1",
        params![page_id, AUTOMATIC_REVISION_INTERVAL_MINUTES],
        |row| row.get(0),
    )?;
    if should_create {
        insert_revision(transaction, page_id, current)?;
    }
    Ok(())
}

fn insert_revision(
    transaction: &Transaction<'_>,
    page_id: &str,
    content: &(String, String, String),
) -> Result<String> {
    let id = new_id();
    transaction.execute(
        "INSERT INTO page_revisions (id, page_id, title, content_json, plain_text)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, page_id, content.0, content.1, content.2],
    )?;
    Ok(id)
}

fn refresh_search_index(connection: &Connection, page_id: &str) -> Result<()> {
    connection.execute("DELETE FROM page_search WHERE page_id = ?1", [page_id])?;
    connection.execute(
        "INSERT INTO page_search (page_id, title, plain_text, tags)
         SELECT p.id,
                p.title,
                p.plain_text,
                COALESCE(group_concat(t.name, ' '), '')
         FROM pages p
         LEFT JOIN page_tags pt ON pt.page_id = p.id
         LEFT JOIN tags t ON t.id = pt.tag_id
         WHERE p.id = ?1
         GROUP BY p.id",
        [page_id],
    )?;
    Ok(())
}

fn build_fts_query(value: &str) -> String {
    value
        .split_whitespace()
        .filter_map(|token| {
            let clean: String = token
                .chars()
                .filter(|character| character.is_alphanumeric() || *character == '_' || *character == '-')
                .collect();
            (!clean.is_empty()).then(|| format!("\"{}\"*", clean.replace('"', "\"\"")))
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn validate_document_json(value: &str) -> Result<()> {
    if value.len() > 50_000_000 {
        return Err(DatabaseError::Validation(
            "page content exceeds the 50 MB document limit".into(),
        ));
    }

    let parsed: serde_json::Value = serde_json::from_str(value)
        .map_err(|_| DatabaseError::Validation("page content is not valid JSON".into()))?;

    match parsed.get("type").and_then(|value| value.as_str()) {
        Some("doc") => Ok(()),
        Some("lenota-canvas") => validate_canvas_document(&parsed),
        _ => Err(DatabaseError::Validation(
            "page content must be a ProseMirror document or LeNota canvas".into(),
        )),
    }
}

fn validate_canvas_document(parsed: &serde_json::Value) -> Result<()> {
    let version = parsed.get("version").and_then(|value| value.as_u64());
    if version != Some(1) && version != Some(2) && version != Some(3) {
        return Err(DatabaseError::Validation(
            "unsupported LeNota canvas version".into(),
        ));
    }

    let containers = parsed
        .get("containers")
        .and_then(|value| value.as_array())
        .ok_or_else(|| DatabaseError::Validation("canvas containers must be an array".into()))?;

    if containers.len() > 10_000 {
        return Err(DatabaseError::Validation(
            "page contains too many note containers".into(),
        ));
    }

    for container in containers {
        let content = container
            .get("content")
            .ok_or_else(|| DatabaseError::Validation("note container is missing content".into()))?;
        if content.get("type").and_then(|value| value.as_str()) != Some("doc") {
            return Err(DatabaseError::Validation(
                "note container content must be a ProseMirror document".into(),
            ));
        }

        for key in ["x", "y", "width", "minHeight", "zIndex"] {
            let number = container.get(key).and_then(|value| value.as_f64());
            if match number { Some(number) => !number.is_finite(), None => true } {
                return Err(DatabaseError::Validation(
                    format!("note container has an invalid {key}"),
                ));
            }
        }
    }

    if version == Some(2) || version == Some(3) {
        let ink = parsed
            .get("ink")
            .and_then(|value| value.as_array())
            .ok_or_else(|| DatabaseError::Validation("canvas ink must be an array".into()))?;
        if ink.len() > 100_000 {
            return Err(DatabaseError::Validation("page contains too many ink strokes".into()));
        }
        for stroke in ink {
            let tool = stroke.get("tool").and_then(|value| value.as_str());
            if tool != Some("pen") && tool != Some("highlighter") {
                return Err(DatabaseError::Validation("ink stroke has an invalid tool".into()));
            }
            let width = stroke.get("width").and_then(|value| value.as_f64());
            if match width { Some(value) => !value.is_finite() || value <= 0.0 || value > 100.0, None => true } {
                return Err(DatabaseError::Validation("ink stroke has an invalid width".into()));
            }
            let points = stroke.get("points").and_then(|value| value.as_array())
                .ok_or_else(|| DatabaseError::Validation("ink stroke points must be an array".into()))?;
            if points.len() > 100_000 {
                return Err(DatabaseError::Validation("ink stroke contains too many points".into()));
            }
            for point in points {
                for key in ["x", "y", "pressure"] {
                    let number = point.get(key).and_then(|value| value.as_f64());
                    if match number { Some(value) => !value.is_finite(), None => true } {
                        return Err(DatabaseError::Validation(format!("ink point has an invalid {key}")));
                    }
                }
            }
        }
    }


    if version == Some(3) {
        let shapes = parsed
            .get("shapes")
            .and_then(|value| value.as_array())
            .ok_or_else(|| DatabaseError::Validation("canvas shapes must be an array".into()))?;
        if shapes.len() > 100_000 {
            return Err(DatabaseError::Validation("page contains too many shapes".into()));
        }
        for shape in shapes {
            let kind = shape.get("kind").and_then(|value| value.as_str());
            if !matches!(kind, Some("rectangle" | "ellipse" | "line" | "arrow")) {
                return Err(DatabaseError::Validation("canvas shape has an invalid kind".into()));
            }
            for key in ["x1", "y1", "x2", "y2", "strokeWidth"] {
                let number = shape.get(key).and_then(|value| value.as_f64());
                if match number { Some(value) => !value.is_finite(), None => true } {
                    return Err(DatabaseError::Validation(format!("canvas shape has an invalid {key}")));
                }
            }
            let width = shape.get("strokeWidth").and_then(|value| value.as_f64()).unwrap_or(0.0);
            if width <= 0.0 || width > 100.0 {
                return Err(DatabaseError::Validation("canvas shape has an invalid stroke width".into()));
            }
        }
        let background = parsed
            .get("background")
            .and_then(|value| value.as_object())
            .ok_or_else(|| DatabaseError::Validation("canvas background must be an object".into()))?;
        let pattern = background.get("pattern").and_then(|value| value.as_str());
        if !matches!(pattern, Some("plain" | "grid" | "ruled")) {
            return Err(DatabaseError::Validation("canvas background has an invalid pattern".into()));
        }
        let spacing = background.get("spacing").and_then(|value| value.as_f64()).unwrap_or(0.0);
        if !spacing.is_finite() || !(8.0..=200.0).contains(&spacing) {
            return Err(DatabaseError::Validation("canvas background has an invalid spacing".into()));
        }
    }
    Ok(())
}

fn validated_name(value: &str) -> Result<&str> {
    validate_name(value).map_err(|error| DatabaseError::Validation(error.to_string()))
}

fn validated_page_title(value: &str) -> Result<&str> {
    validate_page_title(value).map_err(|error| DatabaseError::Validation(error.to_string()))
}

fn validated_tag_name(value: &str) -> Result<&str> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 40 {
        return Err(DatabaseError::Validation(
            "tag names must contain between 1 and 40 characters".into(),
        ));
    }
    Ok(value)
}

fn validated_color(value: &str) -> Result<&str> {
    let valid = value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|character| character.is_ascii_hexdigit());
    if valid {
        Ok(value)
    } else {
        Err(DatabaseError::Validation(
            "color must be a six-digit hexadecimal color".into(),
        ))
    }
}

fn ensure_active_exists(connection: &Connection, table: &str, id: &str) -> Result<()> {
    let query = format!("SELECT 1 FROM {table} WHERE id = ?1 AND deleted_at IS NULL");
    let exists = connection
        .query_row(&query, [id], |_| Ok(()))
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(DatabaseError::NotFound)
    }
}

fn ensure_tag_exists(connection: &Connection, id: &str) -> Result<()> {
    let exists = connection
        .query_row("SELECT 1 FROM tags WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(DatabaseError::NotFound)
    }
}

fn update_name(connection: &Connection, table: &str, id: &str, name: &str) -> Result<()> {
    let query = format!(
        "UPDATE {table}
         SET name = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND deleted_at IS NULL"
    );
    changed_or_not_found(connection.execute(&query, params![id, name])?)
}

fn update_color(connection: &Connection, table: &str, id: &str, color: &str) -> Result<()> {
    let query = format!(
        "UPDATE {table}
         SET color = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND deleted_at IS NULL"
    );
    changed_or_not_found(connection.execute(&query, params![id, color])?)
}

fn changed_or_not_found(changed: usize) -> Result<()> {
    if changed == 0 {
        Err(DatabaseError::NotFound)
    } else {
        Ok(())
    }
}

fn next_order_key(
    connection: &Connection,
    table: &str,
    parent: Option<(&str, &str)>,
) -> Result<f64> {
    let value: Option<f64> = if let Some((column, id)) = parent {
        let query = format!(
            "SELECT MAX(order_key) FROM {table} WHERE {column} = ?1 AND deleted_at IS NULL"
        );
        connection.query_row(&query, [id], |row| row.get(0))?
    } else {
        let query = format!("SELECT MAX(order_key) FROM {table} WHERE deleted_at IS NULL");
        connection.query_row(&query, [], |row| row.get(0))?
    };
    Ok(value.unwrap_or(0.0) + ORDER_STEP)
}

fn insert_trash_entry(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
    title: &str,
    parent_title: Option<&str>,
) -> Result<String> {
    let id = new_id();
    transaction.execute(
        "INSERT INTO trash_entries (id, entity_type, entity_id, title, parent_title)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, entity_type, entity_id, title, parent_title],
    )?;
    Ok(id)
}

fn ensure_restore_parent_is_active(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
) -> Result<()> {
    let parent_active = match entity_type {
        "notebook" => true,
        "section" => transaction
            .query_row(
                "SELECT n.deleted_at IS NULL
                 FROM sections s JOIN notebooks n ON n.id = s.notebook_id
                 WHERE s.id = ?1",
                [entity_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(false),
        "page" => transaction
            .query_row(
                "SELECT s.deleted_at IS NULL AND n.deleted_at IS NULL
                 FROM pages p
                 JOIN sections s ON s.id = p.section_id
                 JOIN notebooks n ON n.id = s.notebook_id
                 WHERE p.id = ?1",
                [entity_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(false),
        _ => return Err(DatabaseError::Validation("unknown trash entity type".into())),
    };

    if parent_active {
        Ok(())
    } else {
        Err(DatabaseError::Validation(
            "restore the parent notebook or section first".into(),
        ))
    }
}

fn delete_entity(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
) -> Result<()> {
    match entity_type {
        "notebook" => {
            transaction.execute(
                "DELETE FROM trash_entries
                 WHERE (entity_type = 'notebook' AND entity_id = ?1)
                    OR (entity_type = 'section' AND entity_id IN (
                        SELECT id FROM sections WHERE notebook_id = ?1
                    ))
                    OR (entity_type = 'page' AND entity_id IN (
                        SELECT p.id FROM pages p
                        JOIN sections s ON s.id = p.section_id
                        WHERE s.notebook_id = ?1
                    ))",
                [entity_id],
            )?;
            transaction.execute(
                "DELETE FROM page_search
                 WHERE page_id IN (
                    SELECT p.id FROM pages p JOIN sections s ON s.id = p.section_id
                    WHERE s.notebook_id = ?1
                 )",
                [entity_id],
            )?;
            transaction.execute("DELETE FROM notebooks WHERE id = ?1", [entity_id])?;
        }
        "section" => {
            transaction.execute(
                "DELETE FROM trash_entries
                 WHERE (entity_type = 'section' AND entity_id = ?1)
                    OR (entity_type = 'page' AND entity_id IN (
                        SELECT id FROM pages WHERE section_id = ?1
                    ))",
                [entity_id],
            )?;
            transaction.execute(
                "DELETE FROM page_search
                 WHERE page_id IN (SELECT id FROM pages WHERE section_id = ?1)",
                [entity_id],
            )?;
            transaction.execute("DELETE FROM sections WHERE id = ?1", [entity_id])?;
        }
        "page" => {
            transaction.execute(
                "DELETE FROM trash_entries WHERE entity_type = 'page' AND entity_id = ?1",
                [entity_id],
            )?;
            transaction.execute("DELETE FROM page_search WHERE page_id = ?1", [entity_id])?;
            transaction.execute("DELETE FROM pages WHERE id = ?1", [entity_id])?;
        }
        _ => return Err(DatabaseError::Validation("unknown trash entity type".into())),
    }
    Ok(())
}

fn prune_old_backups(backup_dir: &Path, keep: usize) -> Result<()> {
    if !backup_dir.exists() { return Ok(()); }
    let mut entries = Vec::new();
    for entry in fs::read_dir(backup_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !is_backup_file(&path) { continue; }
        let modified = entry.metadata()?.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        entries.push((modified, path));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in entries.into_iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn latest_backup_modified_time(backup_dir: &Path) -> Result<Option<SystemTime>> {
    if !backup_dir.exists() {
        return Ok(None);
    }
    let mut latest = None;
    for entry in fs::read_dir(backup_dir)? {
        let entry = entry?;
        if !is_backup_file(&entry.path()) {
            continue;
        }
        let modified = entry.metadata()?.modified()?;
        latest = Some(latest.map_or(modified, |current: SystemTime| current.max(modified)));
    }
    Ok(latest)
}

fn is_backup_file(path: &Path) -> bool {
    path.is_file()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("workspace-") && name.ends_with(".sqlite3"))
}

fn new_id() -> String {
    Uuid::now_v7().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_and_loads_workspace() {
        let database = Database::open_in_memory().unwrap();
        let tree = database.load_workspace_tree().unwrap();
        assert_eq!(tree.notebooks.len(), 1);
        assert_eq!(tree.notebooks[0].sections.len(), 1);
        assert_eq!(tree.notebooks[0].sections[0].pages.len(), 1);
    }

    #[test]
    fn creates_moves_renames_and_updates_rich_page() {
        let database = Database::open_in_memory().unwrap();
        let tree = database.load_workspace_tree().unwrap();
        let notebook_id = &tree.notebooks[0].id;
        let first_section_id = &tree.notebooks[0].sections[0].id;
        let second_section_id = database.create_section(notebook_id, "Second").unwrap();
        database.rename_section(&second_section_id, "Archive").unwrap();
        let page_id = database.create_page(first_section_id, "Draft").unwrap();
        database.move_page(&page_id, &second_section_id).unwrap();
        let json = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Saved body"}]}]}"#;
        database
            .update_page(&page_id, "Renamed", json, "Saved body")
            .unwrap();
        let page = database.get_page(&page_id).unwrap();
        assert_eq!(page.title, "Renamed");
        assert_eq!(page.plain_text, "Saved body");
        assert_eq!(page.section_id, second_section_id);
    }

    #[test]
    fn searches_tags_and_page_text() {
        let database = Database::open_in_memory().unwrap();
        let page_id = database.load_workspace_tree().unwrap().notebooks[0].sections[0].pages[0]
            .id
            .clone();
        let tag = database.create_tag("important", "#ef4444").unwrap();
        database.add_tag_to_page(&page_id, &tag.id).unwrap();
        assert_eq!(database.search_pages("important").unwrap().len(), 1);
        assert_eq!(database.search_pages("Linux").unwrap().len(), 1);
    }

    #[test]
    fn creates_and_restores_revision() {
        let database = Database::open_in_memory().unwrap();
        let page_id = database.load_workspace_tree().unwrap().notebooks[0].sections[0].pages[0]
            .id
            .clone();
        let revision_id = database.create_page_revision(&page_id).unwrap();
        database
            .update_page(&page_id, "Changed", DEFAULT_DOCUMENT, "")
            .unwrap();
        let restored = database
            .restore_page_revision(&page_id, &revision_id)
            .unwrap();
        assert_eq!(restored.title, "Welcome");
    }

    #[test]
    fn trashes_and_restores_a_page() {
        let database = Database::open_in_memory().unwrap();
        let tree = database.load_workspace_tree().unwrap();
        let page_id = tree.notebooks[0].sections[0].pages[0].id.clone();
        database.trash_page(&page_id).unwrap();
        assert!(matches!(database.get_page(&page_id), Err(DatabaseError::NotFound)));
        let trash = database.list_trash().unwrap();
        assert_eq!(trash.len(), 1);
        database.restore_trash_entry(&trash[0].id).unwrap();
        assert_eq!(database.get_page(&page_id).unwrap().id, page_id);
    }

    #[test]
    fn restoring_notebook_does_not_restore_previously_trashed_page() {
        let database = Database::open_in_memory().unwrap();
        let tree = database.load_workspace_tree().unwrap();
        let notebook_id = tree.notebooks[0].id.clone();
        let page_id = tree.notebooks[0].sections[0].pages[0].id.clone();
        database.trash_page(&page_id).unwrap();
        database.trash_notebook(&notebook_id).unwrap();

        let trash = database.list_trash().unwrap();
        let notebook_trash = trash
            .iter()
            .find(|entry| entry.entity_type == "notebook")
            .unwrap();
        database.restore_trash_entry(&notebook_trash.id).unwrap();

        let restored_tree = database.load_workspace_tree().unwrap();
        assert_eq!(restored_tree.notebooks.len(), 1);
        assert!(restored_tree.notebooks[0].sections[0].pages.is_empty());
        assert!(matches!(database.get_page(&page_id), Err(DatabaseError::NotFound)));
    }

    #[test]
    fn deleting_trashed_parent_removes_descendant_trash_entries() {
        let database = Database::open_in_memory().unwrap();
        let tree = database.load_workspace_tree().unwrap();
        let notebook_id = tree.notebooks[0].id.clone();
        let page_id = tree.notebooks[0].sections[0].pages[0].id.clone();
        database.trash_page(&page_id).unwrap();
        database.trash_notebook(&notebook_id).unwrap();

        let notebook_trash_id = database
            .list_trash()
            .unwrap()
            .into_iter()
            .find(|entry| entry.entity_type == "notebook")
            .unwrap()
            .id;
        database.delete_trash_entry(&notebook_trash_id).unwrap();

        assert!(database.list_trash().unwrap().is_empty());
    }

    #[test]
    fn accepts_canvas_v3_with_shapes_ink_and_background() {
        let database = Database::open_in_memory().unwrap();
        let page_id = database.load_workspace_tree().unwrap().notebooks[0].sections[0].pages[0]
            .id
            .clone();
        let json = r##"{"type":"lenota-canvas","version":3,"viewport":{"x":100,"y":80,"zoom":1},"containers":[{"id":"c1","x":20,"y":30,"width":420,"minHeight":80,"zIndex":1,"content":{"type":"doc","content":[{"type":"paragraph"}]},"plainText":""}],"ink":[{"id":"i1","tool":"pen","color":"#ffffff","width":2.5,"points":[{"x":10,"y":10,"pressure":0.5},{"x":20,"y":20,"pressure":0.7}]}],"shapes":[{"id":"s1","kind":"arrow","x1":10,"y1":10,"x2":90,"y2":90,"stroke":"#ffffff","fill":"transparent","strokeWidth":2}],"background":{"pattern":"ruled","color":"#242428","spacing":28}}"##;
        database.update_page(&page_id, "Canvas v3", json, "").unwrap();
        assert_eq!(database.get_page(&page_id).unwrap().title, "Canvas v3");
    }

    #[test]
    fn creates_nests_and_assigns_section_groups() {
        let database = Database::open_in_memory().unwrap();
        let tree = database.load_workspace_tree().unwrap();
        let notebook_id = tree.notebooks[0].id.clone();
        let section_id = tree.notebooks[0].sections[0].id.clone();
        let parent_id = database.create_section_group(&notebook_id, "Work", None).unwrap();
        let child_id = database.create_section_group(&notebook_id, "Project", Some(&parent_id)).unwrap();
        database.move_section_to_group(&section_id, Some(&child_id)).unwrap();
        let tree = database.load_workspace_tree().unwrap();
        assert_eq!(tree.notebooks[0].section_groups.len(), 2);
        assert_eq!(tree.notebooks[0].sections[0].section_group_id.as_deref(), Some(child_id.as_str()));
        assert_eq!(tree.notebooks[0].section_groups.iter().find(|group| group.id == child_id).unwrap().parent_group_id.as_deref(), Some(parent_id.as_str()));
    }

    #[test]
    fn rejects_section_group_cycles() {
        let database = Database::open_in_memory().unwrap();
        let notebook_id = database.load_workspace_tree().unwrap().notebooks[0].id.clone();
        let parent_id = database.create_section_group(&notebook_id, "Parent", None).unwrap();
        let child_id = database.create_section_group(&notebook_id, "Child", Some(&parent_id)).unwrap();
        assert!(matches!(database.set_section_group_parent(&parent_id, Some(&child_id)), Err(DatabaseError::Validation(_))));
    }

    #[test]
    fn updates_notebook_section_and_group_colors() {
        let database = Database::open_in_memory().unwrap();
        let tree = database.load_workspace_tree().unwrap();
        let notebook_id = tree.notebooks[0].id.clone();
        let section_id = tree.notebooks[0].sections[0].id.clone();
        let group_id = database.create_section_group(&notebook_id, "Colored", None).unwrap();
        database.set_notebook_color(&notebook_id, "#112233").unwrap();
        database.set_section_color(&section_id, "#445566").unwrap();
        database.set_section_group_color(&group_id, "#778899").unwrap();
        let tree = database.load_workspace_tree().unwrap();
        assert_eq!(tree.notebooks[0].color, "#112233");
        assert_eq!(tree.notebooks[0].sections[0].color, "#445566");
        assert_eq!(tree.notebooks[0].section_groups.iter().find(|group| group.id == group_id).unwrap().color, "#778899");
    }

    #[test]
    fn positions_pages_before_after_and_as_child() {
        let database = Database::open_in_memory().unwrap();
        let section_id = database.load_workspace_tree().unwrap().notebooks[0].sections[0].id.clone();
        let first = database.create_page(&section_id, "First").unwrap();
        let second = database.create_page(&section_id, "Second").unwrap();
        let third = database.create_page(&section_id, "Third").unwrap();
        database.position_page(&third, &first, "before").unwrap();
        let pages = database.load_workspace_tree().unwrap().notebooks[0].sections[0].pages.clone();
        let third_index = pages.iter().position(|page| page.id == third).unwrap();
        let first_index = pages.iter().position(|page| page.id == first).unwrap();
        assert!(third_index < first_index);
        database.position_page(&second, &first, "child").unwrap();
        assert_eq!(database.get_page(&second).unwrap().parent_page_id.as_deref(), Some(first.as_str()));
        database.position_page(&second, &third, "after").unwrap();
        assert_eq!(database.get_page(&second).unwrap().parent_page_id, None);
    }

    #[test]
    fn creates_a_consistent_backup() {
        let database = Database::open_in_memory().unwrap();
        let directory = std::env::temp_dir().join(format!("lenota-test-{}", new_id()));
        let backup = database.create_backup(&directory).unwrap();
        assert!(Path::new(&backup.path).exists());
        let restored = Database::open(&backup.path).unwrap();
        assert_eq!(restored.load_workspace_tree().unwrap().notebooks.len(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
