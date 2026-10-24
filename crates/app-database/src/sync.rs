//! Complete portable snapshots with an atomic compare-and-apply guard.
//! The network never holds the workspace lock. Edits made during a request cause
//! a retry, never replacement of an in-progress local edit.
use super::*;
use rusqlite::types::{Value as SqlValue, ValueRef};
use serde_json::{Map, Value};

pub const SYNC_TABLES: &[&str] = &[
    "notebooks",
    "section_groups",
    "sections",
    "pages",
    "tags",
    "page_tags",
    "page_revisions",
    "trash_entries",
    "attachments",
];

fn json_error(error: impl std::fmt::Display) -> DatabaseError {
    DatabaseError::Validation(format!("Invalid sync data: {error}"))
}
fn columns(connection: &Connection, table: &str) -> Result<Vec<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(names
        .into_iter()
        .filter(|name| name != "last_opened_at")
        .collect())
}
// Page content also embeds attachment paths (audio cards, file cards, images).
// Canonical references on the wire must not contain either device's filesystem.
fn rewrite_document(
    value: &mut Value,
    attachments: Option<&Map<String, Value>>,
    directory: Option<&Path>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                rewrite_document(item, attachments, directory);
            }
        }
        Value::Object(object) => {
            if let Some(attrs) = object.get_mut("attrs").and_then(Value::as_object_mut) {
                if let Some(id) = attrs
                    .get("attachmentId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(String::from)
                {
                    let portable = format!("lenota-attachment:{id}");
                    let path = directory.and_then(|root| {
                        attachments?
                            .get(&id)?
                            .get("stored_path")?
                            .as_str()
                            .map(|name| root.join(name).to_string_lossy().into_owned())
                    });
                    if attrs.contains_key("storedPath") {
                        attrs.insert(
                            "storedPath".into(),
                            if directory.is_some() {
                                path.map(Value::String).unwrap_or(Value::Null)
                            } else {
                                Value::String(portable.clone())
                            },
                        );
                    }
                    if attrs.contains_key("src") {
                        // Managed image/audio views resolve attachmentId to bytes.
                        attrs.insert(
                            "src".into(),
                            if directory.is_some() {
                                Value::Null
                            } else {
                                Value::String(portable)
                            },
                        );
                    }
                }
            }
            for child in object.values_mut() {
                rewrite_document(child, attachments, directory);
            }
        }
        _ => {}
    }
}
fn document_json(
    raw: &Value,
    attachments: Option<&Map<String, Value>>,
    directory: Option<&Path>,
) -> Result<Value> {
    let mut doc: Value =
        serde_json::from_str(raw.as_str().ok_or_else(|| json_error("Invalid document"))?)
            .map_err(json_error)?;
    rewrite_document(&mut doc, attachments, directory);
    Ok(Value::String(doc.to_string()))
}

fn snapshot(connection: &Connection) -> Result<Value> {
    let mut tables = Map::new();
    for table in SYNC_TABLES {
        let names = columns(connection, table)?;
        let mut statement =
            connection.prepare(&format!("SELECT {} FROM {table}", names.join(",")))?;
        let mut rows = statement.query([])?;
        let mut records = Map::new();
        while let Some(row) = rows.next()? {
            let mut record = Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => Value::from(n),
                    ValueRef::Real(n) => Value::from(n),
                    ValueRef::Text(s) => Value::String(String::from_utf8_lossy(s).into_owned()),
                    ValueRef::Blob(_) => return Err(json_error("Unexpected binary column")),
                };
                record.insert(name.clone(), value);
            }
            if *table == "pages" || *table == "page_revisions" {
                if *table == "pages" {
                    let page_id = record["id"].as_str().ok_or_else(|| json_error("Page ID"))?;
                    let raw = record["content_json"].as_str().ok_or_else(|| json_error("Page content"))?;
                    record.insert("content_json".into(), Value::String(
                        canvas_store::load_content(connection, page_id, raw)?
                    ));
                }
                record.insert(
                    "content_json".into(),
                    document_json(&record["content_json"], None, None)?,
                );
            }
            if *table == "attachments" {
                let path = record["stored_path"]
                    .as_str()
                    .ok_or_else(|| json_error("Attachment path"))?;
                // Windows and Unix workspace paths must produce the same wire name.
                let name = path
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(path)
                    .chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() || "._-".contains(c) {
                            c
                        } else {
                            '_'
                        }
                    })
                    .take(200)
                    .collect::<String>();
                record.insert("stored_path".into(), Value::String(name));
            }
            let key = if *table == "page_tags" {
                format!(
                    "{}|{}",
                    record["page_id"].as_str().unwrap_or(""),
                    record["tag_id"].as_str().unwrap_or("")
                )
            } else {
                record["id"]
                    .as_str()
                    .ok_or_else(|| json_error("Missing record ID"))?
                    .to_owned()
            };
            records.insert(key, Value::Object(record));
        }
        tables.insert((*table).into(), Value::Object(records));
    }
    Ok(Value::Object(tables))
}
fn sql_value(value: &Value) -> Result<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Number(n) if n.is_i64() => SqlValue::Integer(n.as_i64().unwrap()),
        Value::Number(n) => SqlValue::Real(n.as_f64().ok_or_else(|| json_error("Number"))?),
        _ => return Err(json_error("Column must be a string, number, or null")),
    })
}

impl Database {
    pub fn sync_snapshot(&self) -> Result<Value> {
        snapshot(&*self.connection()?)
    }
    pub fn sync_state(&self) -> Result<(Value, Value)> {
        let connection = self.connection()?;
        let (settings, baseline): (String, String) = connection.query_row(
            "SELECT settings_json, baseline_json FROM sync_state WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((
            serde_json::from_str(&settings).map_err(json_error)?,
            serde_json::from_str(&baseline).map_err(json_error)?,
        ))
    }
    pub fn set_sync_settings(&self, settings: &Value) -> Result<()> {
        self.connection()?.execute(
            "UPDATE sync_state SET settings_json=?1 WHERE id=1",
            [settings.to_string()],
        )?;
        Ok(())
    }
    pub fn apply_sync_snapshot(
        &self,
        expected: &Value,
        incoming: &Value,
        attachment_dir: &Path,
        settings: &Value,
    ) -> Result<bool> {
        let mut connection = self.connection()?;
        if snapshot(&connection)? != *expected {
            return Ok(false);
        }
        let tables = incoming
            .as_object()
            .ok_or_else(|| json_error("Snapshot must be an object"))?;
        if tables.len() != SYNC_TABLES.len() {
            return Err(json_error("Incompatible snapshot schema"));
        }
        let transaction = connection.transaction()?;
        if incoming == expected {
            transaction.execute(
                "UPDATE sync_state SET settings_json=?1,baseline_json=?2 WHERE id=1",
                params![settings.to_string(), incoming.to_string()],
            )?;
            transaction.commit()?;
            return Ok(true);
        }
        transaction.execute_batch("PRAGMA defer_foreign_keys=ON;")?;
        // Incoming sync snapshots always contain full JSON documents. Remove
        // local object caches before applying the portable page records.
        // A rejected sync leaves these intact because everything is atomic.
        transaction.execute("DELETE FROM page_canvas_state", [])?;
        // Remove absent records child-first. UPSERT below restores any links that
        // ON DELETE SET NULL affected. Do not use INSERT OR REPLACE (it cascades).
        for table in SYNC_TABLES.iter().rev() {
            let incoming_rows = tables
                .get(*table)
                .and_then(Value::as_object)
                .ok_or_else(|| json_error(table))?;
            let existing = expected[*table]
                .as_object()
                .ok_or_else(|| json_error(table))?;
            for (key, record) in existing {
                if incoming_rows.contains_key(key) {
                    continue;
                }
                if *table == "page_tags" {
                    transaction.execute(
                        "DELETE FROM page_tags WHERE page_id=?1 AND tag_id=?2",
                        params![record["page_id"].as_str(), record["tag_id"].as_str()],
                    )?;
                } else {
                    transaction.execute(&format!("DELETE FROM {table} WHERE id=?1"), [key])?;
                }
            }
        }
        for table in SYNC_TABLES {
            let names = columns(&transaction, table)?;
            let records = tables[*table]
                .as_object()
                .ok_or_else(|| json_error(table))?;
            let primary = if *table == "page_tags" {
                "page_id,tag_id"
            } else {
                "id"
            };
            let updates = names
                .iter()
                .filter(|n| {
                    n.as_str() != "id"
                        && !(*table == "page_tags" && ["page_id", "tag_id"].contains(&n.as_str()))
                })
                .map(|n| format!("{n}=excluded.{n}"))
                .collect::<Vec<_>>();
            let suffix = if updates.is_empty() {
                "DO NOTHING".into()
            } else {
                format!("DO UPDATE SET {}", updates.join(","))
            };
            let query = format!(
                "INSERT INTO {table} ({}) VALUES ({}) ON CONFLICT ({primary}) {suffix}",
                names.join(","),
                vec!["?"; names.len()].join(",")
            );
            for (key, raw) in records {
                let mut record = raw
                    .as_object()
                    .ok_or_else(|| json_error("Invalid record"))?
                    .clone();
                if record.len() != names.len()
                    || names.iter().any(|name| !record.contains_key(name))
                {
                    return Err(json_error(format!("Incompatible {table} columns")));
                }
                let expected_key = if *table == "page_tags" {
                    format!(
                        "{}|{}",
                        record["page_id"].as_str().unwrap_or(""),
                        record["tag_id"].as_str().unwrap_or("")
                    )
                } else {
                    record["id"].as_str().unwrap_or("").into()
                };
                if expected_key != *key {
                    return Err(json_error("Record key mismatch"));
                }
                if *table == "attachments" {
                    let name = record["stored_path"]
                        .as_str()
                        .ok_or_else(|| json_error("Attachment name"))?;
                    if name.is_empty()
                        || !name
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                        || name.starts_with('.')
                    {
                        return Err(json_error("Unsafe attachment name"));
                    }
                    let path = attachment_dir.join(name);
                    let size = record["size_bytes"]
                        .as_u64()
                        .ok_or_else(|| json_error("Attachment size"))?;
                    if fs::metadata(&path)?.len() != size {
                        return Err(json_error("Attachment is missing or incomplete"));
                    }
                    record.insert(
                        "stored_path".into(),
                        Value::String(path.to_string_lossy().into_owned()),
                    );
                }
                if *table == "pages" || *table == "page_revisions" {
                    record.insert(
                        "content_json".into(),
                        document_json(
                            &record["content_json"],
                            tables["attachments"].as_object(),
                            Some(attachment_dir),
                        )?,
                    );
                }
                let values = names
                    .iter()
                    .map(|name| sql_value(&record[name]))
                    .collect::<Result<Vec<_>>>()?;
                transaction.execute(&query, rusqlite::params_from_iter(values))?;
            }
        }
        transaction.execute_batch("DELETE FROM page_search;
            INSERT INTO page_search(page_id,title,plain_text,tags)
            SELECT p.id,p.title,p.plain_text,COALESCE(group_concat(t.name,' '),'')
            FROM pages p LEFT JOIN page_tags pt ON pt.page_id=p.id LEFT JOIN tags t ON t.id=pt.tag_id GROUP BY p.id;")?;
        let bad_links: i64 =
            transaction.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })?;
        if bad_links != 0 {
            return Err(json_error("Broken notebook/page links"));
        }
        transaction.execute(
            "UPDATE sync_state SET settings_json=?1,baseline_json=?2 WHERE id=1",
            params![settings.to_string(), incoming.to_string()],
        )?;
        transaction.commit()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sync_is_atomic_and_rejects_edits_during_network_request() {
        let db = Database::open_in_memory().unwrap();
        let original = db.sync_snapshot().unwrap();
        let mut remote = original.clone();
        let id = remote["pages"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        remote["pages"][&id]["title"] = Value::String("From phone".into());
        assert!(
            db.apply_sync_snapshot(&original, &remote, Path::new("."), &serde_json::json!({}))
                .unwrap()
        );
        assert_eq!(db.get_page(&id).unwrap().title, "From phone");
        // last_opened_at does not produce spurious sync changes.
        assert_eq!(db.sync_snapshot().unwrap(), remote);
        db.update_page(&id, "New local edit", DEFAULT_DOCUMENT, "local")
            .unwrap();
        assert!(
            !db.apply_sync_snapshot(&remote, &original, Path::new("."), &serde_json::json!({}))
                .unwrap()
        );
        assert_eq!(db.get_page(&id).unwrap().title, "New local edit");
    }
    #[test]
    fn invalid_links_roll_back_workspace_and_baseline() {
        let db = Database::open_in_memory().unwrap();
        let original = db.sync_snapshot().unwrap();
        let mut remote = original.clone();
        let id = remote["pages"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        remote["pages"][&id]["section_id"] = Value::String("missing".into());
        assert!(
            db.apply_sync_snapshot(&original, &remote, Path::new("."), &serde_json::json!({}))
                .is_err()
        );
        assert_eq!(db.sync_snapshot().unwrap(), original);
        assert_eq!(db.sync_state().unwrap().1, serde_json::json!({}));
    }
}
