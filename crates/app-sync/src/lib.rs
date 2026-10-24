//! Native HTTP works on PC and mobile without WebView CORS or mixed-content rules.
mod merge;
mod supabase;
use app_database::Database;
use reqwest::blocking::{Client, Response};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

pub type Result<T> = std::result::Result<T, String>;
const MAX_JSON: u64 = 64 * 1024 * 1024;
const MAX_FILE: u64 = 100_000_000;

fn client() -> Result<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Unable to initialize sync networking".into())
}
fn checked(response: Response) -> Result<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let mut raw = String::new();
    response.take(16_384).read_to_string(&mut raw).ok();
    let message = serde_json::from_str::<Value>(&raw).ok().and_then(|v| {
        ["error_description", "msg", "message", "error"]
            .iter()
            .find_map(|key| v[*key].as_str().map(String::from))
    });
    Err(message.unwrap_or_else(|| format!("Sync server returned HTTP {}", status.as_u16())))
}
fn read_json(response: Response) -> Result<Value> {
    let mut bytes = Vec::new();
    checked(response)?
        .take(MAX_JSON + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Server response was interrupted")?;
    if bytes.len() as u64 > MAX_JSON {
        return Err("Sync response exceeds 64 MiB".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "This address did not return a valid LeNota sync response".into())
}
// Opt-in diagnostics contain stages/counts only, never credentials or note text.
fn trace(message: impl std::fmt::Display) {
    if std::env::var_os("LENOTA_SYNC_TRACE").is_some_and(|value| value == "1") {
        eprintln!(
            "[LeNota sync {}] {message}",
            chrono::Utc::now().format("%H:%M:%S")
        );
    }
}
fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        trace("HTTP request timed out");
        "Sync request timed out. Retry sync; your notes are saved locally.".into()
    } else {
        trace(format!(
            "HTTP request failed (connect={}, body={})",
            error.is_connect(),
            error.is_body()
        ));
        "Cannot reach the sync server. Check the address and connection. Your notes are saved locally.".into()
    }
}
fn normalized_url(raw: &str, allow_http: bool) -> Result<String> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|_| "Enter a complete server address, such as https://notes.example.com")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "Use the server's base address without credentials, paths, or query parameters".into(),
        );
    }
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if url.scheme() != "https" && !(url.scheme() == "http" && (local || allow_http)) {
        return Err("Use HTTPS, or explicitly allow HTTP for a trusted local network".into());
    }
    Ok(url.to_string().trim_end_matches('/').into())
}
fn empty_snapshot() -> Value {
    let mut result = serde_json::Map::new();
    for table in [
        "notebooks",
        "section_groups",
        "sections",
        "pages",
        "tags",
        "page_tags",
        "page_revisions",
        "trash_entries",
        "attachments",
    ] {
        result.insert(table.into(), json!({}));
    }
    Value::Object(result)
}
fn status(database: &Database) -> Result<Value> {
    let (settings, baseline) = database.sync_state().map_err(|e| e.to_string())?;
    let pending = if settings["userId"].is_string() {
        database.sync_snapshot().map_err(|e| e.to_string())? != baseline
    } else {
        false
    };
    Ok(json!({
        "signedIn": settings["token"].as_str().is_some_and(|s| !s.is_empty()),
        "email": settings["email"], "serverUrl": settings["serverUrl"],
        "lastSyncedAt": settings["lastSyncedAt"], "pending": pending,
        "allowHttp": settings["allowHttp"].as_bool().unwrap_or(false),
        "provider": settings["provider"].as_str().unwrap_or(if settings["userId"].is_string() { "selfHosted" } else { "supabase" }),
        "publicKey": settings["publicKey"],
    }))
}
fn safe_name(raw: &Value) -> Result<&str> {
    let name = raw.as_str().ok_or("Invalid attachment name")?;
    if name.is_empty()
        || name.len() > 200
        || name.starts_with('.')
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("Unsafe attachment name in sync data".into());
    }
    Ok(name)
}
fn perform_sync(
    database: Arc<Database>,
    gate: Arc<Mutex<()>>,
    attachment_dir: PathBuf,
    backup_dir: PathBuf,
) -> Result<Value> {
    let _guard = gate.lock().map_err(|_| "Sync is unavailable")?;
    let (mut settings, baseline) = database.sync_state().map_err(|e| e.to_string())?;
    let token = settings["token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Sign in to sync")?
        .to_owned();
    let url = normalized_url(
        settings["serverUrl"].as_str().unwrap_or(""),
        settings["allowHttp"].as_bool().unwrap_or(false),
    )?;
    let baseline = if baseline.as_object().is_some_and(|o| o.is_empty()) {
        empty_snapshot()
    } else {
        baseline
    };
    let captured = database.sync_snapshot().map_err(|e| e.to_string())?;
    let client = client()?;
    let root = fs::canonicalize(&attachment_dir).map_err(|e| e.to_string())?;
    for (id, record) in captured["attachments"]
        .as_object()
        .ok_or("Invalid attachment collection")?
    {
        let name = safe_name(&record["stored_path"])?;
        let endpoint = format!("{url}/v1/files/{name}");
        let exists = client
            .head(&endpoint)
            .bearer_auth(&token)
            .send()
            .map_err(network_error)?;
        if exists.status() == reqwest::StatusCode::UNAUTHORIZED {
            settings["token"] = Value::Null;
            database
                .set_sync_settings(&settings)
                .map_err(|e| e.to_string())?;
        }
        if exists.status().is_success() {
            continue;
        }
        if exists.status() != reqwest::StatusCode::NOT_FOUND {
            checked(exists)?;
        }
        let attachment = database.get_attachment(id).map_err(|e| e.to_string())?;
        let source = fs::canonicalize(&attachment.stored_path).map_err(
            |_| "A local attachment is missing. Restore it from a backup before syncing.",
        )?;
        if !source.starts_with(&root) {
            return Err("Attachment is outside the managed workspace".into());
        }
        let file = fs::File::open(&source).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        if size > MAX_FILE || Some(size) != record["size_bytes"].as_u64() {
            return Err("Attachment is too large or has changed unexpectedly".into());
        }
        checked(
            client
                .put(&endpoint)
                .bearer_auth(&token)
                .header("Content-Length", size)
                .body(file)
                .send()
                .map_err(network_error)?,
        )?;
    }
    let response = client
        .post(format!("{url}/v1/sync"))
        .bearer_auth(&token)
        .json(&json!({"protocol":1,"baseline":baseline,"snapshot":captured}))
        .send()
        .map_err(network_error)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        settings["token"] = Value::Null;
        database
            .set_sync_settings(&settings)
            .map_err(|e| e.to_string())?;
    }
    let response = read_json(response)?;
    let incoming = &response["snapshot"];
    for record in incoming["attachments"]
        .as_object()
        .ok_or("Server returned invalid attachment data")?
        .values()
    {
        let name = safe_name(&record["stored_path"])?;
        let size = record["size_bytes"]
            .as_u64()
            .filter(|s| *s <= MAX_FILE)
            .ok_or("Invalid attachment size")?;
        let target = attachment_dir.join(name);
        if fs::metadata(&target).is_ok_and(|m| m.is_file() && m.len() == size) {
            continue;
        }
        let download = checked(
            client
                .get(format!("{url}/v1/files/{name}"))
                .bearer_auth(&token)
                .send()
                .map_err(network_error)?,
        )?;
        let temporary = attachment_dir.join(format!(".sync-{}", uuid::Uuid::now_v7()));
        let result = (|| -> Result<()> {
            let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
            let copied = std::io::copy(&mut download.take(MAX_FILE + 1), &mut file)
                .map_err(|_| "Attachment download interrupted. Retry sync.")?;
            if copied != size {
                return Err("Attachment download was incomplete. Retry sync.".into());
            }
            file.flush().map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
    }
    // Keep a recovery point before the first merge/import on this device.
    if settings["lastSyncedAt"].is_null() {
        let info = database
            .create_backup(&backup_dir)
            .map_err(|e| e.to_string())?;
        snapshot_attachments(&attachment_dir, &backup_dir, &info.file_name)
            .map_err(|e| e.to_string())?;
    }
    // The timestamp is informational, never a conflict-resolution clock.
    settings["lastSyncedAt"] = json!(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string()
    );
    Ok(
        json!({"captured":captured,"incoming":incoming,"settings":settings,"conflicts":response["conflicts"]}),
    )
}

/// One account-bound local workspace. Native callers run methods off the UI thread.
pub struct SyncEngine {
    database: Arc<Database>,
    gate: Arc<Mutex<()>>,
    pending: Mutex<Option<Value>>,
    attachment_dir: PathBuf,
    backup_dir: PathBuf,
}
impl SyncEngine {
    pub fn new(database: Arc<Database>, attachment_dir: PathBuf, backup_dir: PathBuf) -> Self {
        Self {
            database,
            gate: Arc::new(Mutex::new(())),
            pending: Mutex::new(None),
            attachment_dir,
            backup_dir,
        }
    }
    pub fn status(&self) -> Result<Value> {
        status(&self.database)
    }
    pub fn login(
        &self,
        server_url: String,
        email: String,
        password: String,
        signup: bool,
        allow_http: bool,
    ) -> Result<Value> {
        let database = &self.database;
        let _guard = self.gate.lock().map_err(|_| "Sync is unavailable")?;
        let url = normalized_url(&server_url, allow_http)?;
        let (old, _) = database.sync_state().map_err(|e| e.to_string())?;
        // Binding survives sign-out. Silently moving a workspace to another user's
        // account could expose private notes. Use a separate app data profile instead.
        if old["userId"].is_string()
            && (old["serverUrl"].as_str() != Some(&url)
                || old["email"].as_str() != Some(email.trim().to_lowercase().as_str()))
        {
            return Err(format!(
                "This workspace is linked to {} on {}. Sign in to that account to keep syncing it.",
                old["email"].as_str().unwrap_or("your account"),
                old["serverUrl"].as_str().unwrap_or("your server")
            ));
        }
        let response = read_json(
            client()?
                .post(format!(
                    "{url}/v1/{}",
                    if signup { "signup" } else { "login" }
                ))
                .json(&json!({"email": email, "password": password}))
                .send()
                .map_err(network_error)?,
        )?;
        if response["token"].as_str().is_none()
            || response["userId"].as_str().is_none()
            || response["email"].as_str().is_none()
        {
            return Err("Server returned an invalid account response".into());
        }
        if old["userId"].is_string() && old["userId"] != response["userId"] {
            return Err(
                "The server account identity changed. Restore your original sync server database."
                    .into(),
            );
        }
        let settings = json!({"serverUrl": url, "email": response["email"], "userId": response["userId"], "token": response["token"], "allowHttp": allow_http, "lastSyncedAt": old["lastSyncedAt"]});
        database
            .set_sync_settings(&settings)
            .map_err(|e| e.to_string())?;
        status(database)
    }
    pub fn logout(&self) -> Result<Value> {
        let database = &self.database;
        let _guard = self.gate.lock().map_err(|_| "Sync is unavailable")?;
        let (mut settings, _) = database.sync_state().map_err(|e| e.to_string())?;
        if settings["provider"] == "supabase" {
            return supabase::logout(database, &mut settings);
        }
        let url = settings["serverUrl"].as_str().unwrap_or("").to_owned();
        let token = settings["token"].as_str().unwrap_or("").to_owned();
        settings["token"] = Value::Null;
        database
            .set_sync_settings(&settings)
            .map_err(|e| e.to_string())?;
        // Offline sign-out always succeeds locally. Online sign-out also revokes
        // this device's token. Other device sessions remain signed in.
        if !token.is_empty() {
            if let Ok(c) = client() {
                let _ = c
                    .post(format!("{url}/v1/logout"))
                    .timeout(Duration::from_secs(5))
                    .bearer_auth(token)
                    .send();
            }
        }
        status(database)
    }
    pub fn finish(&self) -> Result<Value> {
        trace("Applying prepared sync to this device");
        let database = &self.database;
        let _guard = self.gate.lock().map_err(|_| "Sync is unavailable")?;
        let prepared = self
            .pending
            .lock()
            .map_err(|_| "Sync is unavailable")?
            .take()
            .ok_or("No sync is ready to apply")?;
        let (settings, _) = database.sync_state().map_err(|e| e.to_string())?;
        if settings["token"] != prepared["settings"]["token"] || settings["token"].is_null() {
            return Err("Sign-in changed. Retry sync.".into());
        }
        let changed = prepared["captured"] != prepared["incoming"];
        let applied = database
            .apply_sync_snapshot(
                &prepared["captured"],
                &prepared["incoming"],
                &self.attachment_dir,
                &prepared["settings"],
            )
            .map_err(|e| e.to_string())?;
        trace(format!(
            "Local commit complete: applied={applied}, changed={changed}"
        ));
        Ok(
            json!({"applied":applied,"changed":applied && changed,"conflicts":if applied { prepared["conflicts"].clone() } else { json!([]) },"status":status(database)?}),
        )
    }
    pub fn prepare(&self) -> Result<Value> {
        trace("Starting sync preparation");
        let prepared =
            if self.database.sync_state().map_err(|e| e.to_string())?.0["provider"] == "supabase" {
                supabase::prepare(self)?
            } else {
                perform_sync(
                    self.database.clone(),
                    self.gate.clone(),
                    self.attachment_dir.clone(),
                    self.backup_dir.clone(),
                )?
            };
        let changed = prepared["captured"] != prepared["incoming"];
        *self.pending.lock().map_err(|_| "Sync is unavailable")? = Some(prepared);
        trace("Sync prepared; waiting for local commit");
        Ok(json!({"prepared":true,"changed":changed}))
    }
}

fn snapshot_attachments(
    attachment_dir: &std::path::Path,
    backup_dir: &std::path::Path,
    file_name: &str,
) -> std::io::Result<()> {
    let stem = file_name.strip_suffix(".sqlite3").unwrap_or(file_name);
    let destination = backup_dir.join(format!("{stem}-attachments"));
    fs::create_dir_all(&destination)?;
    for entry in fs::read_dir(attachment_dir)? {
        let entry = entry?;
        if !entry.path().is_file() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        fs::copy(entry.path(), destination.join(entry.file_name()))?;
    }
    Ok(())
}
