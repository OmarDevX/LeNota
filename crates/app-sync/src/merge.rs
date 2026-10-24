//! Three-way merge for the managed backend. Repeated pushes are idempotent;
//! client clocks never choose a winner, and conflicting page bodies are archived.
use crate::{Result, empty_snapshot};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};

fn stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn meaningful(row: &Value) -> Value {
    let mut row = row.clone();
    if let Some(object) = row.as_object_mut() {
        object.remove("updated_at");
        object.remove("created_at");
    }
    row
}
pub(crate) fn shape(snapshot: &Value) -> Result<()> {
    let expected = empty_snapshot();
    let object = snapshot.as_object().ok_or("Invalid workspace snapshot")?;
    if object.len() != expected.as_object().unwrap().len() {
        return Err("Incompatible sync schema".into());
    }
    for table in expected.as_object().unwrap().keys() {
        let rows = object
            .get(table)
            .and_then(Value::as_object)
            .ok_or("Invalid record collection")?;
        if rows.len() > 100_000 || rows.values().any(|row| !row.is_object()) {
            return Err("Invalid or oversized record collection".into());
        }
    }
    Ok(())
}
fn restore(
    result: &mut Value,
    sources: &[&Value],
    table: &str,
    id: &str,
    conflicts: &mut Vec<Value>,
) -> Result<()> {
    if id.is_empty() || result[table].get(id).is_some() {
        return Ok(());
    }
    for source in sources {
        if let Some(row) = source[table].get(id) {
            result[table][id] = row.clone();
            conflicts.push(json!({"table":table,"id":id,"reason":"kept parent of an edited item"}));
            return Ok(());
        }
    }
    Err("An edited item has no recoverable parent".into())
}
fn reference(row: &Value, field: &str) -> Result<String> {
    row[field]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("Invalid {field} reference"))
}

pub(crate) fn merge(base: &Value, local: &Value, remote: &Value) -> Result<(Value, Vec<Value>)> {
    shape(base)?;
    shape(local)?;
    shape(remote)?;
    let mut result = remote.clone();
    let mut conflicts = Vec::new();
    let mut archive = Vec::new();
    for table in empty_snapshot().as_object().unwrap().keys() {
        let b_rows = base[table].as_object().unwrap();
        let l_rows = local[table].as_object().unwrap();
        let keys: BTreeSet<_> = b_rows.keys().chain(l_rows.keys()).cloned().collect();
        for id in keys {
            let b = b_rows.get(&id);
            let l = l_rows.get(&id);
            let r = remote[table].get(&id);
            if l == b
                || l == r
                || (l.is_some() && r.is_some() && meaningful(l.unwrap()) == meaningful(r.unwrap()))
            {
                continue;
            }
            if r == b {
                match l {
                    Some(row) => {
                        result[table][&id] = row.clone();
                    }
                    None => {
                        result[table].as_object_mut().unwrap().remove(&id);
                    }
                }
                continue;
            }
            if l.is_none() || r.is_none() {
                if let Some(row) = l.or(r) {
                    result[table][&id] = row.clone();
                    conflicts.push(json!({"table":table,"id":id,"reason":"delete-versus-edit; edited item kept"}));
                }
                continue;
            }
            let l = l.unwrap();
            let r = r.unwrap();
            let mut combined = r.clone();
            let mut overlap = false;
            if table == "pages" {
                let fields = ["content_json", "plain_text"];
                let lb: Vec<_> = fields.iter().map(|f| &l[*f]).collect();
                let rb: Vec<_> = fields.iter().map(|f| &r[*f]).collect();
                let bb: Vec<_> = fields
                    .iter()
                    .map(|f| b.map_or(&Value::Null, |row| &row[*f]))
                    .collect();
                if lb != bb {
                    for f in fields {
                        combined[f] = l[f].clone();
                    }
                    overlap |= rb != bb && rb != lb;
                }
            }
            for (field, value) in l.as_object().unwrap() {
                if field == "updated_at"
                    || (table == "pages"
                        && ["content_json", "plain_text"].contains(&field.as_str()))
                {
                    continue;
                }
                let old = b.and_then(|row| row.get(field)).unwrap_or(&Value::Null);
                if value != old {
                    combined[field] = value.clone();
                    overlap |= &r[field] != old && &r[field] != value;
                }
            }
            if l.get("deleted_at").is_some()
                && l["deleted_at"].is_null() != r["deleted_at"].is_null()
            {
                let active = if l["deleted_at"].is_null() { l } else { r };
                if meaningful(active) != meaningful(b.unwrap_or(&Value::Null)) {
                    combined = active.clone();
                    combined["deleted_at"] = Value::Null;
                    if combined.get("trash_batch_id").is_some() {
                        combined["trash_batch_id"] = Value::Null;
                    }
                    overlap = true;
                }
            }
            if combined.get("updated_at").is_some() {
                combined["updated_at"] = json!(stamp());
            }
            result[table][&id] = combined;
            if overlap {
                conflicts.push(json!({"table":table,"id":id,"reason":"concurrent edits"}));
                if table == "pages" {
                    archive.extend([l.clone(), r.clone()]);
                }
            }
        }
    }
    let conflict_pages: HashSet<String> = conflicts
        .iter()
        .filter(|item| item["table"] == "pages")
        .filter_map(|item| item["id"].as_str().map(String::from))
        .collect();
    for table in ["attachments", "page_revisions"] {
        for source in [base, remote, local] {
            for (id, row) in source[table].as_object().unwrap() {
                if row["page_id"]
                    .as_str()
                    .is_some_and(|id| conflict_pages.contains(id))
                {
                    result[table]
                        .as_object_mut()
                        .unwrap()
                        .entry(id)
                        .or_insert_with(|| row.clone());
                }
            }
        }
    }
    let sources = [local, remote, base];
    for table in ["attachments", "page_revisions", "page_tags"] {
        let rows: Vec<_> = result[table]
            .as_object()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for row in rows {
            restore(
                &mut result,
                &sources,
                "pages",
                &reference(&row, "page_id")?,
                &mut conflicts,
            )?;
            if table == "page_tags" {
                restore(
                    &mut result,
                    &sources,
                    "tags",
                    &reference(&row, "tag_id")?,
                    &mut conflicts,
                )?;
            }
        }
    }
    for (table, parent_table, field, optional, optional_table) in [
        ("pages", "sections", "section_id", "parent_page_id", "pages"),
        (
            "sections",
            "notebooks",
            "notebook_id",
            "section_group_id",
            "section_groups",
        ),
        (
            "section_groups",
            "notebooks",
            "notebook_id",
            "parent_group_id",
            "section_groups",
        ),
    ] {
        let rows: Vec<_> = result[table]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, row)| (id.clone(), row.clone()))
            .collect();
        for (id, row) in rows {
            restore(
                &mut result,
                &sources,
                parent_table,
                &reference(&row, field)?,
                &mut conflicts,
            )?;
            if row[optional]
                .as_str()
                .is_some_and(|p| result[optional_table].get(p).is_none())
            {
                result[table][&id][optional] = Value::Null;
            }
        }
    }
    for (table, parent_table, field) in [
        ("pages", "sections", "section_id"),
        ("sections", "notebooks", "notebook_id"),
    ] {
        let rows: Vec<_> = result[table]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, row)| (id.clone(), row.clone()))
            .collect();
        for (id, row) in rows {
            if !row["deleted_at"].is_null() || meaningful(&row) == meaningful(&base[table][&id]) {
                continue;
            }
            let parent = reference(&row, field)?;
            if !result[parent_table][&parent]["deleted_at"].is_null() {
                result[parent_table][&parent]["deleted_at"] = Value::Null;
                result[parent_table][&parent]["trash_batch_id"] = Value::Null;
                conflicts.push(json!({"table":parent_table,"id":parent,"reason":"restored parent of edited item"}));
            }
        }
    }
    for row in archive {
        let mut identity = Map::new();
        for field in ["id", "title", "content_json", "plain_text"] {
            identity.insert(field.into(), row[field].clone());
        }
        let id = format!(
            "sync-{:x}",
            Sha256::digest(Value::Object(identity).to_string().as_bytes())
        );
        result["page_revisions"].as_object_mut().unwrap().entry(id.clone()).or_insert_with(|| json!({
            "id":id,"page_id":row["id"],"title":row["title"],"content_json":row["content_json"],"plain_text":row["plain_text"],"created_at":stamp()
        }));
    }
    let mut used = HashSet::new();
    for (id, row) in result["tags"].as_object_mut().unwrap() {
        let mut name = row["name"].as_str().ok_or("Invalid tag name")?.to_owned();
        if used.contains(&name.to_lowercase()) {
            name = format!("{name} ({})", id.chars().take(8).collect::<String>());
            while used.contains(&name.to_lowercase()) {
                name.push('+');
            }
            row["name"] = json!(name);
        }
        used.insert(name.to_lowercase());
    }
    let remove: Vec<_> = result["trash_entries"]
        .as_object()
        .unwrap()
        .iter()
        .filter_map(|(id, row)| {
            let table = match row["entity_type"].as_str() {
                Some("page") => "pages",
                Some("section") => "sections",
                Some("notebook") => "notebooks",
                _ => return Some(id.clone()),
            };
            let key = row["entity_id"].as_str().unwrap_or("");
            (result[table].get(key).is_none() || result[table][key]["deleted_at"].is_null())
                .then(|| id.clone())
        })
        .collect();
    for id in remove {
        result["trash_entries"].as_object_mut().unwrap().remove(&id);
    }
    for (table, parent, scope) in [
        ("pages", "parent_page_id", "section_id"),
        ("section_groups", "parent_group_id", "notebook_id"),
    ] {
        let ids: Vec<_> = result[table].as_object().unwrap().keys().cloned().collect();
        for id in ids {
            let mut seen = HashSet::from([id.clone()]);
            let mut ancestor = result[table][&id][parent].as_str().map(String::from);
            while let Some(key) = ancestor {
                if !seen.insert(key.clone())
                    || result[table][&key][scope] != result[table][&id][scope]
                {
                    result[table][&id][parent] = Value::Null;
                    conflicts.push(json!({"table":table,"id":id,"reason":"conflicting hierarchy moves; item kept at top level"}));
                    break;
                }
                ancestor = result[table][&key][parent].as_str().map(String::from);
            }
        }
    }
    Ok((result, conflicts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_database::Database;
    fn fixture() -> (Value, String) {
        let db = Database::open_in_memory().unwrap();
        let value = db.sync_snapshot().unwrap();
        let id = value["pages"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        (value, id)
    }
    #[test]
    fn merge_preserves_both_bodies_and_retry_has_no_extra_revisions() {
        let (base, id) = fixture();
        let mut local = base.clone();
        let mut remote = base.clone();
        local["pages"][&id]["plain_text"] = json!("phone");
        local["pages"][&id]["content_json"] =
            json!(r#"{"type":"doc","content":[{"type":"text","text":"phone"}]}"#);
        remote["pages"][&id]["plain_text"] = json!("pc");
        remote["pages"][&id]["content_json"] =
            json!(r#"{"type":"doc","content":[{"type":"text","text":"pc"}]}"#);
        let (merged, conflicts) = merge(&base, &local, &remote).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(merged["page_revisions"].as_object().unwrap().len(), 2);
        let (repeated, _) = merge(&base, &local, &merged).unwrap();
        assert_eq!(repeated, merged);
    }
    #[test]
    fn stale_download_does_not_resurrect_deletion_but_new_edit_is_kept() {
        let (base, id) = fixture();
        let mut deleted = base.clone();
        deleted["pages"].as_object_mut().unwrap().remove(&id);
        let (downloaded, _) = merge(&base, &base, &deleted).unwrap();
        assert!(downloaded["pages"].get(&id).is_none());
        let mut edited = base.clone();
        edited["pages"][&id]["title"] = json!("edited offline");
        let (recovered, _) = merge(&base, &edited, &deleted).unwrap();
        assert_eq!(recovered["pages"][&id]["title"], "edited offline");
    }
}

#[cfg(test)]
mod reference_tests {
    use super::*;
    use app_database::Database;
    use std::{
        io::Write,
        path::PathBuf,
        process::{Command, Stdio},
    };
    fn body(row: &mut Value, text: &str) {
        row["plain_text"] = json!(text);
        row["content_json"] =
            json!(json!({"type":"doc","content":[{"type":"text","text":text}]}).to_string());
    }
    fn strip_dates(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.remove("created_at");
                map.remove("updated_at");
                for v in map.values_mut() {
                    strip_dates(v);
                }
            }
            Value::Array(items) => {
                for v in items {
                    strip_dates(v);
                }
            }
            _ => {}
        }
    }
    #[test]
    fn managed_merge_matches_tested_server_for_deletion_hierarchy_tags_and_body_conflicts() {
        let db = Database::open_in_memory().unwrap();
        let original = db.sync_snapshot().unwrap();
        let p = original["pages"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        let s = original["sections"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        let n = original["notebooks"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        let mut cases = Vec::new();
        let mut local = original.clone();
        let mut remote = original.clone();
        local["pages"][&p]["title"] = json!("PC title");
        body(&mut remote["pages"][&p], "phone body");
        cases.push((original.clone(), local, remote));
        let mut local = original.clone();
        let mut remote = original.clone();
        body(&mut local["pages"][&p], "PC version");
        body(&mut remote["pages"][&p], "phone version");
        cases.push((original.clone(), local, remote));
        let mut deleted = original.clone();
        deleted["pages"].as_object_mut().unwrap().clear();
        let mut edited = original.clone();
        body(&mut edited["pages"][&p], "survives deletion");
        cases.push((original.clone(), deleted, edited));
        let mut deleted = original.clone();
        deleted["pages"][&p]["deleted_at"] = json!("2026-10-12T00:00:00Z");
        let mut edited = original.clone();
        body(&mut edited["pages"][&p], "survives trash");
        cases.push((original.clone(), deleted, edited));
        let mut local = original.clone();
        let mut row = local["pages"][&p].clone();
        row["id"] = json!("new-offline-page");
        local["pages"]["new-offline-page"] = row;
        cases.push((original.clone(), local, empty_snapshot()));
        let mut base = original.clone();
        let mut row = base["pages"][&p].clone();
        row["id"] = json!("q");
        base["pages"]["q"] = row;
        let mut local = base.clone();
        let mut remote = base.clone();
        local["pages"][&p]["parent_page_id"] = json!("q");
        remote["pages"]["q"]["parent_page_id"] = json!(&p);
        cases.push((base, local, remote));
        let mut local = original.clone();
        let mut remote = original.clone();
        for (target, id) in [(&mut local, "a"), (&mut remote, "b")] {
            target["tags"][id] =
                json!({"id":id,"name":"Study","color":"#ffffff","created_at":"now"});
            target["page_tags"][format!("{p}|{id}")] = json!({"page_id":p,"tag_id":id});
        }
        cases.push((original.clone(), local, remote));
        let mut deleted = original.clone();
        deleted["notebooks"][&n]["deleted_at"] = json!("2026-10-12T00:00:00Z");
        deleted["sections"][&s]["deleted_at"] = json!("2026-10-12T00:00:00Z");
        deleted["pages"][&p]["deleted_at"] = json!("2026-10-12T00:00:00Z");
        let mut edited = original.clone();
        body(&mut edited["pages"][&p], "edited in deleted notebook");
        cases.push((original.clone(), deleted, edited));
        let mut base = original.clone();
        base["attachments"]["a"] = json!({"id":"a","page_id":p,"stored_path":"image.png","file_name":"image.png","mime_type":"image/png","size_bytes":4,"created_at":"now"});
        let mut deleted = base.clone();
        deleted["pages"].as_object_mut().unwrap().clear();
        deleted["attachments"].as_object_mut().unwrap().clear();
        let mut edited = base.clone();
        body(&mut edited["pages"][&p], "edited image page");
        cases.push((base, deleted, edited));
        for (index, (base, local, remote)) in cases.into_iter().enumerate() {
            let (mut actual, _) = merge(&base, &local, &remote).unwrap();
            let mut child=Command::new("python3").current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../server"))
                .args(["-c","import json,sys; from sync_server import merge; a=json.load(sys.stdin); print(json.dumps(merge(*a)[0]))"])
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(json!([base, local, remote]).to_string().as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            let mut expected: Value = serde_json::from_slice(&output.stdout).unwrap();
            strip_dates(&mut actual);
            strip_dates(&mut expected);
            assert_eq!(actual, expected, "Reference merge case {index}");
        }
    }
}
