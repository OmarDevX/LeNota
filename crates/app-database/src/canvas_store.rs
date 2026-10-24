//! Incremental SQLite persistence for typed notes, ink, and shapes.
//!
//! The public page API still carries a complete canvas JSON document. SQLite
//! stores each object separately after the first canvas edit, so subsequent
//! saves write only changed objects. A marker is never exposed to callers,
//! page revisions, or cloud sync. All transitions happen in one transaction.
use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::{DatabaseError, Result};

pub(super) const CANVAS_MARKER: &str = "@lenota-canvas-objects-v1";
const KINDS: [&str; 3] = ["containers", "ink", "shapes"];

struct Item {
    kind: &'static str,
    id: String,
    position: i64,
    json: String,
}
struct Partition {
    metadata_json: String,
    items: Vec<Item>,
}

fn partition(content: &str) -> Result<Option<Partition>> {
    let mut root: Map<String, Value> = match serde_json::from_str::<Value>(content) {
        Ok(Value::Object(root)) => root,
        _ => return Ok(None), // Validated by validate_document_json before entry.
    };
    if root.get("type").and_then(Value::as_str) != Some("lenota-canvas") {
        return Ok(None);
    }

    // A malformed or old canvas is kept in the original legacy format, never
    // discarded. Unique, stable IDs are required for safe incremental writes.
    let mut items = Vec::new();
    for kind in KINDS {
        if let Some(value) = root.get_mut(kind) {
            let Value::Array(array) = value else { return Ok(None) };
            let mut seen = HashSet::new();
            for (position, item) in array.iter().enumerate() {
                let Some(id) = item.get("id").and_then(Value::as_str) else { return Ok(None) };
                if id.is_empty() || !seen.insert(id.to_string()) {
                    return Ok(None);
                }
                items.push(Item {
                    kind,
                    id: id.to_string(),
                    position: position as i64,
                    json: item.to_string(),
                });
            }
            array.clear();
        }
    }
    Ok(Some(Partition {
        metadata_json: Value::Object(root).to_string(),
        items,
    }))
}

pub(super) fn fingerprint(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

pub(super) fn has_same_payload(
    connection: &Connection,
    page_id: &str,
    current_raw: &str,
    new_raw: &str,
) -> Result<bool> {
    if current_raw != CANVAS_MARKER {
        return Ok(current_raw == new_raw);
    }
    let stored: Option<(String, i64)> = connection.query_row(
        "SELECT source_sha256, source_bytes FROM page_canvas_state WHERE page_id=?1",
        [page_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let stored = stored.ok_or_else(|| DatabaseError::Validation(
        "canvas object records are missing; refusing to overwrite this page".into()
    ))?;
    Ok(stored.1 == new_raw.len() as i64 && stored.0 == fingerprint(new_raw))
}

pub(super) fn load_content(connection: &Connection, page_id: &str, raw: &str) -> Result<String> {
    if raw != CANVAS_MARKER {
        return Ok(raw.to_string());
    }
    let metadata: Option<String> = connection.query_row(
        "SELECT metadata_json FROM page_canvas_state WHERE page_id=?1",
        [page_id], |row| row.get(0),
    ).optional()?;
    let metadata = metadata.ok_or_else(|| DatabaseError::Validation(
        "canvas object records are missing; restore a backup rather than resetting this page".into()
    ))?;
    let mut root: Value = serde_json::from_str(&metadata).map_err(|_| DatabaseError::Validation(
        "stored canvas metadata is corrupted".into()
    ))?;
    let obj = root.as_object_mut().ok_or_else(|| DatabaseError::Validation(
        "stored canvas metadata is invalid".into()
    ))?;
    let mut stmt = connection.prepare(
        "SELECT kind, item_json FROM page_canvas_items WHERE page_id=?1 ORDER BY kind, position"
    )?;
    let records = stmt.query_map([page_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for record in records {
        let (kind, raw_item) = record?;
        if !KINDS.contains(&kind.as_str()) {
            return Err(DatabaseError::Validation("unknown stored canvas item type".into()));
        }
        let item: Value = serde_json::from_str(&raw_item).map_err(|_| DatabaseError::Validation(
            "stored canvas item is corrupted".into()
        ))?;
        let target = obj.get_mut(&kind).and_then(Value::as_array_mut).ok_or_else(||
            DatabaseError::Validation("stored canvas group is missing".into())
        )?;
        target.push(item);
    }
    Ok(root.to_string())
}

/// Called inside the same transaction as page metadata and revision updates.
/// Non-canvas documents stay legacy, and stale per-object records are removed.
/// A fallback to the legacy format is always lossless.
pub(super) fn store_content(
    connection: &Connection,
    page_id: &str,
    content: &str,
) -> Result<&'static str> {
    let Some(partition) = partition(content)? else {
        connection.execute("DELETE FROM page_canvas_state WHERE page_id=?1", [page_id])?;
        return Ok("legacy");
    };
    let hash = fingerprint(content);
    connection.execute(
        "INSERT INTO page_canvas_state(page_id, metadata_json, source_sha256, source_bytes)
         VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(page_id) DO UPDATE SET
          metadata_json=excluded.metadata_json,
          source_sha256=excluded.source_sha256,
          source_bytes=excluded.source_bytes
         WHERE metadata_json IS NOT excluded.metadata_json
            OR source_sha256 IS NOT excluded.source_sha256
            OR source_bytes IS NOT excluded.source_bytes",
        params![page_id, partition.metadata_json, hash, content.len() as i64],
    )?;

    // Reconcile IDs, not the full JSON document. SQLite updates only the note,
    // shape, or stroke that actually changed (and objects whose order changed).
    // Read only small metadata (not entire stored notes/strokes), and issue
    // no INSERT/UPDATE statement at all for objects whose content and order
    // are unchanged. That keeps per-keystroke SQLite writes proportional to
    // changed objects, not the number of objects on the canvas.
    let mut existing: HashMap<(String, String), (i64, String)> = HashMap::new();
    {
        let mut stmt = connection.prepare(
            "SELECT kind, item_id, position, item_sha256 FROM page_canvas_items WHERE page_id=?1"
        )?;
        let rows = stmt.query_map([page_id], |row| {
            Ok((
                (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                (row.get::<_, i64>(2)?, row.get::<_, String>(3)?),
            ))
        })?;
        for row in rows {
            let (key, values) = row?;
            existing.insert(key, values);
        }
    }
    let mut insert = connection.prepare_cached(
        "INSERT INTO page_canvas_items(page_id,kind,item_id,position,item_json,item_sha256)
         VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(page_id,kind,item_id) DO UPDATE SET
           position=excluded.position,item_json=excluded.item_json,item_sha256=excluded.item_sha256
         WHERE position IS NOT excluded.position OR item_sha256 IS NOT excluded.item_sha256"
    )?;
    for item in partition.items {
        let hash = fingerprint(&item.json);
        let old = existing.remove(&(item.kind.to_string(), item.id.clone()));
        if old.as_ref().is_some_and(|(position, stored_hash)| {
            *position == item.position && *stored_hash == hash
        }) {
            continue;
        }
        insert.execute(params![page_id, item.kind, item.id, item.position, item.json, hash])?;
    }
    drop(insert);
    for ((kind, id), _) in existing {
        connection.execute(
            "DELETE FROM page_canvas_items WHERE page_id=?1 AND kind=?2 AND item_id=?3",
            params![page_id, kind, id],
        )?;
    }
    Ok("chunked")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    fn canvas(text: &str, extra: &str) -> String {
        serde_json::json!({
            "type": "lenota-canvas", "version": 3,
            "viewport": {"x":0,"y":0,"zoom":1},
            "containers": [
                {"id":"note-a","x":0,"y":0,"width":400,"minHeight":100,"zIndex":1,
                 "plainText":text,"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]}},
                {"id":"note-b","x":600,"y":0,"width":400,"minHeight":100,"zIndex":2,
                 "plainText":extra,"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":extra}]}]}}
            ],
            "ink": [{"id":"stroke","tool":"pen","width":3,"points":[{"x":1,"y":2,"pressure":1}]}],
            "shapes": [], "background":{"pattern":"grid"},"aiMemory": []
        }).to_string()
    }
    fn page_id(db: &Database) -> String {
        db.load_workspace_tree().unwrap().notebooks[0].sections[0].pages[0].id.clone()
    }
    #[test]
    fn incremental_save_updates_one_object_and_roundtrips() {
        let db = Database::open_in_memory().unwrap();
        let id = page_id(&db);
        let initial = canvas("hello", "unchanged");
        db.update_page(&id, "P", &initial, "hello unchanged").unwrap();
        assert_eq!(db.get_page(&id).unwrap().content_json.parse::<Value>().unwrap(), initial.parse::<Value>().unwrap());
        let conn = db.connection().unwrap();
        assert_eq!(conn.query_row("SELECT content_json FROM pages WHERE id=?1", [&id], |r| r.get::<_,String>(0)).unwrap(), CANVAS_MARKER);
        let before: String = conn.query_row("SELECT item_json FROM page_canvas_items WHERE page_id=?1 AND item_id='note-b'", [&id], |r| r.get(0)).unwrap();
        drop(conn);
        let edited = canvas("modified", "unchanged");
        // A trigger counts actual SQLite updates, not logical JSON equality.
        // Changing note-a must not UPDATE the large, unchanged note-b row.
        {
            let c = db.connection().unwrap();
            c.execute_batch("CREATE TABLE writes(item_id TEXT);
                CREATE TRIGGER track_canvas_update AFTER UPDATE ON page_canvas_items
                BEGIN INSERT INTO writes(item_id) VALUES(NEW.item_id); END;") .unwrap();
        }
        db.update_page(&id, "P", &edited, "modified unchanged").unwrap();
        assert_eq!(db.get_page(&id).unwrap().content_json.parse::<Value>().unwrap(), edited.parse::<Value>().unwrap());
        {
            let c = db.connection().unwrap();
            let mut statement = c.prepare("SELECT item_id FROM writes").unwrap();
            let modified: Vec<String> = statement.query_map([], |r| r.get(0)).unwrap()
                .collect::<std::result::Result<_, _>>().unwrap();
            assert_eq!(modified, vec!["note-a"]);
        }
        let conn = db.connection().unwrap();
        let after: String = conn.query_row("SELECT item_json FROM page_canvas_items WHERE page_id=?1 AND item_id='note-b'", [&id], |r| r.get(0)).unwrap();
        assert_eq!(before, after);
    }
    #[test]
    fn revisions_and_duplicates_include_entire_canvas() {
        let db = Database::open_in_memory().unwrap();
        let id = page_id(&db);
        let original = canvas("first", "second");
        db.update_page(&id, "P", &original, "first second").unwrap();
        let rev = db.create_page_revision(&id).unwrap();
        let copy = db.duplicate_page(&id).unwrap();
        assert_eq!(db.get_page(&copy).unwrap().content_json.parse::<Value>().unwrap(), original.parse::<Value>().unwrap());
        db.update_page(&id, "P", &canvas("third", "second"), "third second").unwrap();
        let restored = db.restore_page_revision(&id, &rev).unwrap();
        assert_eq!(restored.content_json.parse::<Value>().unwrap(), original.parse::<Value>().unwrap());
    }
    #[test]
    fn sync_snapshot_stays_portable_and_sync_apply_restores_content() {
        let db = Database::open_in_memory().unwrap();
        let id = page_id(&db);
        let original = canvas("portable", "other");
        db.update_page(&id, "P", &original, "portable other").unwrap();
        let snapshot = db.sync_snapshot().unwrap();
        let outgoing = snapshot["pages"][&id]["content_json"].as_str().unwrap();
        assert_ne!(outgoing, CANVAS_MARKER);
        assert_eq!(outgoing.parse::<Value>().unwrap(), original.parse::<Value>().unwrap());
    }
    #[test]
    fn incoming_sync_updates_an_object_backed_page_without_a_marker() {
        use std::path::Path;
        let db = Database::open_in_memory().unwrap();
        let id = page_id(&db);
        db.update_page(&id, "Local", &canvas("local", "data"), "local data").unwrap();
        let before = db.sync_snapshot().unwrap();
        let mut remote = before.clone();
        let updated = canvas("remote", "data");
        remote["pages"][&id]["title"] = Value::String("Remote".into());
        // The sync protocol normalizes JSON and file-path fields.
        remote["pages"][&id]["content_json"] = Value::String(
            updated.parse::<Value>().unwrap().to_string()
        );
        remote["pages"][&id]["plain_text"] = Value::String("remote data".into());
        assert!(db.apply_sync_snapshot(&before, &remote, Path::new("."), &serde_json::json!({})).unwrap());
        let loaded = db.get_page(&id).unwrap();
        assert_eq!(loaded.title, "Remote");
        assert_eq!(loaded.content_json.parse::<Value>().unwrap(), updated.parse::<Value>().unwrap());
        assert_eq!(db.sync_snapshot().unwrap(), remote);
    }
    #[test]
    fn invalid_sync_rolls_back_chunk_cleanup() {
        use std::path::Path;
        let db = Database::open_in_memory().unwrap();
        let id = page_id(&db);
        let saved = canvas("safe", "data");
        db.update_page(&id, "Local", &saved, "safe data").unwrap();
        let original = db.sync_snapshot().unwrap();
        let mut remote = original.clone();
        remote["pages"][&id]["section_id"] = Value::String("missing-section".into());
        assert!(db.apply_sync_snapshot(&original, &remote, Path::new("."), &serde_json::json!({})).is_err());
        assert_eq!(db.get_page(&id).unwrap().content_json.parse::<Value>().unwrap(), saved.parse::<Value>().unwrap());
        let c = db.connection().unwrap();
        let count: i64 = c.query_row("SELECT count(*) FROM page_canvas_items WHERE page_id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(count, 3);
    }
    #[test]
    fn reopen_object_storage_and_verify_data() {
        let dir = std::env::temp_dir().join(format!("lenota-stage2-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("workspace.sqlite3");
        let id;
        let initial = canvas("persistent", "data");
        {
            let db = Database::open(&path).unwrap();
            id = page_id(&db);
            db.update_page(&id, "P", &initial, "persistent data").unwrap();
        }
        {
            let db = Database::open(&path).unwrap();
            assert_eq!(db.get_page(&id).unwrap().content_json.parse::<Value>().unwrap(), initial.parse::<Value>().unwrap());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn migrating_an_existing_workspace_creates_a_one_time_rollback_backup() {
        let dir = std::env::temp_dir().join(format!("lenota-stage2-upgrade-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("workspace.sqlite3");
        {
            let legacy = Connection::open(&path).unwrap();
            for sql in [
                include_str!("../migrations/0001_initial.sql"),
                include_str!("../migrations/0002_trash_and_backups.sql"),
                include_str!("../migrations/0003_productivity.sql"),
                include_str!("../migrations/0004_attachments.sql"),
                include_str!("../migrations/0005_page_hierarchy.sql"),
                include_str!("../migrations/0006_section_groups.sql"),
                include_str!("../migrations/0007_sync.sql"),
            ] {
                legacy.execute_batch(sql).unwrap();
            }
        }
        let rollback = path.with_extension("pre-stage2.sqlite3");
        assert!(!rollback.exists());
        {
            let db = Database::open(&path).unwrap();
            assert!(rollback.exists());
            assert_eq!(db.load_workspace_tree().unwrap().notebooks.len(), 1);
            let id = page_id(&db);
            db.update_page(&id, "Saved", &canvas("content", "old"), "content old").unwrap();
        }
        {
            // The original backup must not be overwritten after migration.
            let backup = Connection::open(&rollback).unwrap();
            assert_eq!(backup.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 7);
            drop(backup);
            let db = Database::open(&path).unwrap();
            assert_eq!(db.get_page(&page_id(&db)).unwrap().title, "Saved");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn legacy_and_duplicate_ids_never_lose_content() {
        let db = Database::open_in_memory().unwrap();
        let id = page_id(&db);
        let bad = canvas("a", "b").replace("note-b", "note-a");
        db.update_page(&id, "P", &bad, "a b").unwrap();
        assert_eq!(db.get_page(&id).unwrap().content_json, bad);
        let conn = db.connection().unwrap();
        let count: i64 = conn.query_row("SELECT count(*) FROM page_canvas_state WHERE page_id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }
}
