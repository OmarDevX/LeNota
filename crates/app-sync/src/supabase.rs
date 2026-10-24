//! Free managed provider: Auth + PostgREST RPCs + private Storage. No edge
//! function, Docker service, secret administrator key, or rented server is needed.
use super::*;
use reqwest::{Method, blocking::RequestBuilder};
use sha2::{Digest, Sha256};
const LIMIT: u64 = 50_000_000;

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn public_key(key: &str) -> Result<&str> {
    let key = key.trim();
    // New project keys are explicit about whether they are safe in a client.
    if !key.starts_with("sb_publishable_")
        || key.len() > 4096
        || key.bytes().any(|b| b.is_ascii_whitespace())
    {
        return Err("Use the Supabase publishable key beginning sb_publishable_. Never use a secret or service-role key.".into());
    }
    Ok(key)
}
fn request(
    client: &Client,
    settings: &Value,
    method: Method,
    path: &str,
) -> Result<RequestBuilder> {
    let url = settings["serverUrl"]
        .as_str()
        .ok_or("Missing Supabase project URL")?;
    let key = public_key(settings["publicKey"].as_str().unwrap_or(""))?;
    let request = client
        .request(method, format!("{url}{path}"))
        .header("apikey", key);
    Ok(if let Some(token) = settings["token"].as_str() {
        request.bearer_auth(token)
    } else {
        request
    })
}
fn session(settings: &mut Value, response: &Value) -> Result<()> {
    let token = response["access_token"].as_str().filter(|s| !s.is_empty()).ok_or("Confirm your email or create a confirmed user in Supabase Authentication → Users, then sign in.")?;
    let user = &response["user"];
    let id = user["id"]
        .as_str()
        .ok_or("Supabase returned an invalid user")?;
    if settings["userId"].is_string() && settings["userId"] != id {
        return Err("The linked account identity changed. Use the original Supabase user.".into());
    }
    settings["userId"] = json!(id);
    settings["email"] = user["email"].clone();
    settings["token"] = json!(token);
    settings["refreshToken"] = response["refresh_token"].clone();
    settings["expiresAt"] = json!(
        response["expires_at"]
            .as_u64()
            .unwrap_or_else(|| now_seconds() + response["expires_in"].as_u64().unwrap_or(3600))
    );
    Ok(())
}
fn refresh(database: &Database, client: &Client, settings: &mut Value) -> Result<()> {
    if settings["expiresAt"]
        .as_u64()
        .is_some_and(|expiry| expiry > now_seconds() + 120)
    {
        return Ok(());
    }
    let refresh_token = settings["refreshToken"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Sign in again to renew your session")?;
    let response = request(
        client,
        settings,
        Method::POST,
        "/auth/v1/token?grant_type=refresh_token",
    )?
    .json(&json!({"refresh_token":refresh_token}))
    .send()
    .map_err(network_error)?;
    if matches!(response.status().as_u16(), 400 | 401) {
        settings["token"] = Value::Null;
        settings["refreshToken"] = Value::Null;
        database
            .set_sync_settings(settings)
            .map_err(|e| e.to_string())?;
        return Err("Session expired. Sign in again; your offline notes are safe.".into());
    }
    let response = read_json(response)?;
    session(settings, &response)?;
    // Persist rotated refresh tokens immediately, before any other network request.
    database
        .set_sync_settings(settings)
        .map_err(|e| e.to_string())
}
pub(super) fn login(
    engine: &SyncEngine,
    url: String,
    key: String,
    email: String,
    password: String,
    signup: bool,
) -> Result<Value> {
    let _guard = engine.gate.lock().map_err(|_| "Sync is unavailable")?;
    let url = normalized_url(&url, false)?;
    let key = public_key(&key)?.to_owned();
    let (old, _) = engine.database.sync_state().map_err(|e| e.to_string())?;
    if old["userId"].is_string()
        && (old["provider"] != "supabase"
            || old["serverUrl"] != url
            || old["email"].as_str() != Some(email.trim().to_lowercase().as_str()))
    {
        return Err(
            "This workspace is linked to another account/server. Sign in to its original account."
                .into(),
        );
    }
    let mut settings = json!({"provider":"supabase","serverUrl":url,"publicKey":key,"allowHttp":false,"userId":old["userId"],"lastSyncedAt":old["lastSyncedAt"],"remoteVersion":old["remoteVersion"]});
    let response = read_json(
        request(
            &client()?,
            &settings,
            Method::POST,
            if signup {
                "/auth/v1/signup"
            } else {
                "/auth/v1/token?grant_type=password"
            },
        )?
        .json(&json!({"email":email.trim().to_lowercase(),"password":password}))
        .send()
        .map_err(network_error)?,
    )?;
    session(&mut settings, &response)?;
    engine
        .database
        .set_sync_settings(&settings)
        .map_err(|e| e.to_string())?;
    status(&engine.database)
}
pub(super) fn logout(database: &Database, settings: &mut Value) -> Result<Value> {
    let old = settings.clone();
    settings["token"] = Value::Null;
    settings["refreshToken"] = Value::Null;
    database
        .set_sync_settings(settings)
        .map_err(|e| e.to_string())?;
    if let Ok(c) = client() {
        if let Ok(r) = request(&c, &old, Method::POST, "/auth/v1/logout?scope=local") {
            let _ = r.timeout(Duration::from_secs(5)).send();
        }
    }
    status(database)
}
fn object(id: &str, row: &Value, settings: &Value) -> Result<String> {
    let id = safe_name(&json!(id))?.to_owned();
    let user = safe_name(&settings["userId"])?;
    let name = safe_name(&row["stored_path"])?;
    Ok(format!("lenota-notes/{user}/{id}/{name}"))
}
fn local_file(
    database: &Database,
    id: &str,
    root: &std::path::Path,
    row: &Value,
) -> Result<fs::File> {
    let path = fs::canonicalize(
        database
            .get_attachment(id)
            .map_err(|e| e.to_string())?
            .stored_path,
    )
    .map_err(|_| "A local attachment is missing. Restore it from a backup before syncing.")?;
    if !path.starts_with(root) {
        return Err("Attachment is outside the managed workspace".into());
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size > LIMIT {
        return Err("Supabase Free supports attachments up to 50 MB. Split or remove this large attachment before syncing.".into());
    }
    if Some(size) != row["size_bytes"].as_u64() {
        return Err("An attachment has changed unexpectedly".into());
    }
    Ok(file)
}
fn digest(mut source: impl Read) -> Result<(u64, Vec<u8>)> {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut size = 0;
    loop {
        let n = source
            .read(&mut buffer)
            .map_err(|_| "Attachment transfer interrupted")?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > LIMIT {
            return Err("Attachment exceeds 50 MB".into());
        }
        hash.update(&buffer[..n]);
    }
    Ok((size, hash.finalize().to_vec()))
}
fn verify_uploaded(remote: Response, local: fs::File) -> Result<()> {
    if digest(checked(remote)?.take(LIMIT + 1))? != digest(local)? {
        return Err("Attachment ID collision. Existing cloud file was preserved.".into());
    }
    Ok(())
}
fn upload(
    database: &Database,
    client: &Client,
    settings: &Value,
    snapshot: &Value,
    baseline: &Value,
    directory: &std::path::Path,
) -> Result<()> {
    let root = fs::canonicalize(directory).map_err(|e| e.to_string())?;
    let attachments = snapshot["attachments"]
        .as_object()
        .ok_or("Invalid attachments")?;
    for (index, (id, row)) in attachments.iter().enumerate() {
        // Already-acknowledged immutable files need no network request at all.
        if baseline["attachments"].get(id) == Some(row) {
            continue;
        }
        trace(format!(
            "Uploading attachment {}/{}",
            index + 1,
            attachments.len()
        ));
        let object = object(id, row, settings)?;
        let file = local_file(database, id, &root, row)?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let sent = request(
            client,
            settings,
            Method::POST,
            &format!("/storage/v1/object/{object}"),
        )?
        .header("Content-Length", size)
        .header(
            "Content-Type",
            row["mime_type"]
                .as_str()
                .unwrap_or("application/octet-stream"),
        )
        .header("x-upsert", "false")
        .body(file)
        .send();
        let upload_failure = match sent {
            Ok(response) if response.status().is_success() => {
                trace(format!("Attachment {} acknowledged", index + 1));
                continue;
            }
            Ok(response) => {
                // An early rejection can also interrupt the reply body. Retain
                // its error, but first check whether this exact file is present.
                let code = response.status().as_u16();
                let mut raw = String::new();
                response.take(16_384).read_to_string(&mut raw).ok();
                let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
                trace(format!(
                    "Attachment {} upload returned HTTP {code}; checking cloud file",
                    index + 1
                ));
                parsed["message"].as_str().or_else(|| parsed["error"].as_str())
                    .map(String::from)
                    .unwrap_or_else(|| format!("Could not upload private attachment (HTTP {code}); check Storage setup and quota"))
            }
            Err(error) => {
                // A service can close an upload stream early for an existing
                // immutable object, or lose its reply after saving a new object.
                trace(format!(
                    "Attachment {} upload reply interrupted; checking cloud file",
                    index + 1
                ));
                network_error(error)
            }
        };
        // A successful GET is sufficient only when both size and SHA-256 agree.
        // Never overwrite a different object or accept an upload that is absent.
        let remote = request(
            client,
            settings,
            Method::GET,
            &format!("/storage/v1/object/authenticated/{object}"),
        )?
        .send()
        .map_err(network_error)?;
        if remote.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(upload_failure);
        }
        verify_uploaded(remote, local_file(database, id, &root, row)?)?;
        trace(format!("Attachment {} verified", index + 1));
    }
    Ok(())
}
fn download(
    client: &Client,
    settings: &Value,
    snapshot: &Value,
    directory: &std::path::Path,
) -> Result<()> {
    let attachments = snapshot["attachments"]
        .as_object()
        .ok_or("Invalid remote attachments")?;
    for (index, (id, row)) in attachments.iter().enumerate() {
        let name = safe_name(&row["stored_path"])?;
        let size = row["size_bytes"]
            .as_u64()
            .filter(|s| *s <= LIMIT)
            .ok_or("Invalid attachment size")?;
        let target = directory.join(name);
        if fs::metadata(&target).is_ok_and(|m| m.is_file() && m.len() == size) {
            continue;
        }
        trace(format!(
            "Downloading attachment {}/{}",
            index + 1,
            attachments.len()
        ));
        let object = object(id, row, settings)?;
        let response = checked(
            request(
                client,
                settings,
                Method::GET,
                &format!("/storage/v1/object/authenticated/{object}"),
            )?
            .send()
            .map_err(network_error)?,
        )?;
        let temporary = directory.join(format!(".sync-{}", uuid::Uuid::now_v7()));
        let result = (|| -> Result<()> {
            let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
            let written = std::io::copy(&mut response.take(LIMIT + 1), &mut file)
                .map_err(|_| "Attachment download interrupted. Retry sync.")?;
            if written != size {
                return Err("Incomplete attachment download. Retry sync.".into());
            }
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        trace(format!("Downloaded attachment {}", index + 1));
    }
    Ok(())
}
pub(super) fn prepare(engine: &SyncEngine) -> Result<Value> {
    trace("Waiting for sync lock");
    let _guard = engine.gate.lock().map_err(|_| "Sync is unavailable")?;
    trace("Reading local sync state and notes");
    let (mut settings, baseline) = engine.database.sync_state().map_err(|e| e.to_string())?;
    if !settings["token"].is_string() {
        return Err("Sign in to sync".into());
    }
    let baseline = if baseline.as_object().is_some_and(|o| o.is_empty()) {
        empty_snapshot()
    } else {
        baseline
    };
    let captured = engine.database.sync_snapshot().map_err(|e| e.to_string())?;
    let client = client()?;
    trace("Checking sign-in session");
    refresh(&engine.database, &client, &mut settings)?;
    let mut known = settings["remoteVersion"].as_i64().unwrap_or(-1);
    let mut incoming = None;
    let mut conflicts = Vec::new();
    // At most five optimistic retries. The local captured snapshot is unchanged;
    // SQLite independently rejects the import if the user edited during the fetch.
    for attempt in 0..5 {
        trace(format!(
            "Fetching cloud workspace (attempt {})",
            attempt + 1
        ));
        let pull = read_json(
            request(&client, &settings, Method::POST, "/rest/v1/rpc/lenota_pull")?
                .json(&json!({"p_known_version":known}))
                .send()
                .map_err(network_error)?,
        )?;
        let version = pull["version"]
            .as_i64()
            .filter(|v| *v >= 0)
            .ok_or("Run supabase/setup.sql in your project's SQL Editor first")?;
        let remote = if pull["snapshot"].is_null() {
            if version != known {
                return Err("Invalid cloud version response".into());
            }
            baseline.clone()
        } else {
            pull["snapshot"].clone()
        };
        trace(format!("Cloud version {version}; merging notes"));
        let (merged, found) = merge::merge(&baseline, &captured, &remote)?;
        if merged != remote {
            trace("Uploading local attachments");
            upload(
                &engine.database,
                &client,
                &settings,
                &captured,
                &baseline,
                &engine.attachment_dir,
            )?;
            trace("Checking files needed on this device");
            download(&client, &settings, &merged, &engine.attachment_dir)?;
            // Validate all SQLite constraints before cloud commit, without touching
            // the live device workspace or its acknowledgement checkpoint.
            trace("Validating merged workspace in temporary SQLite database");
            let validation = Database::open_in_memory().map_err(|e| e.to_string())?;
            validation
                .apply_sync_snapshot(
                    &validation.sync_snapshot().map_err(|e| e.to_string())?,
                    &merged,
                    &engine.attachment_dir,
                    &json!({}),
                )
                .map_err(|e| e.to_string())?;
            trace("Saving notes to cloud (lenota_push)");
            let pushed = read_json(
                request(&client, &settings, Method::POST, "/rest/v1/rpc/lenota_push")?
                    .json(&json!({"p_expected_version":version,"p_snapshot":merged}))
                    .send()
                    .map_err(network_error)?,
            )?;
            if pushed["committed"] != true {
                trace("Cloud changed during sync; retrying merge");
                known = -1;
                continue;
            }
            settings["remoteVersion"] = pushed["version"].clone();
            trace(format!(
                "Cloud commit complete: version {}",
                pushed["version"]
            ));
        } else {
            trace("Cloud notes already match; checking local files");
            download(&client, &settings, &merged, &engine.attachment_dir)?;
            settings["remoteVersion"] = json!(version);
        }
        incoming = Some(merged);
        conflicts = found;
        break;
    }
    let incoming = incoming.ok_or(
        "Another device is updating your notes. Retry sync shortly; local changes are safe.",
    )?;
    if settings["lastSyncedAt"].is_null() {
        trace("Creating first-sync local backup");
        let info = engine
            .database
            .create_backup(&engine.backup_dir)
            .map_err(|e| e.to_string())?;
        snapshot_attachments(&engine.attachment_dir, &engine.backup_dir, &info.file_name)
            .map_err(|e| e.to_string())?;
    }
    settings["lastSyncedAt"] = json!((now_seconds() * 1000).to_string());
    trace("Cloud preparation complete");
    Ok(json!({"captured":captured,"incoming":incoming,"settings":settings,"conflicts":conflicts}))
}

impl SyncEngine {
    pub fn login_supabase(
        &self,
        url: String,
        public_key: String,
        email: String,
        password: String,
        signup: bool,
    ) -> Result<Value> {
        login(self, url, public_key, email, password, signup)
    }
}
