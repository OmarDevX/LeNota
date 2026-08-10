use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

use app_core::{
    Attachment, BackupInfo, NotebookNode, Page, PageLocation, PageRevision, PageSummary, SectionNode, Tag, TrashEntry, WorkspaceTree,
};
use serde::Serialize;
use tauri::State;

use crate::{AppState, LiveAiWorker};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    fn database(error: app_database::DatabaseError) -> Self {
        let code = match error {
            app_database::DatabaseError::Validation(_) => "validation_error",
            app_database::DatabaseError::NotFound => "not_found",
            app_database::DatabaseError::Io(_) => "file_error",
            _ => "database_error",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAiStatus {
    configured: bool,
    provider: &'static str,
}

type CommandResult<T> = Result<T, CommandError>;

#[tauri::command]
pub fn load_workspace(state: State<'_, AppState>) -> CommandResult<WorkspaceTree> {
    state
        .database
        .load_workspace_tree()
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn get_page(page_id: String, state: State<'_, AppState>) -> CommandResult<Page> {
    state.database.get_page(&page_id).map_err(CommandError::database)
}

#[tauri::command]
pub fn create_notebook(name: String, state: State<'_, AppState>) -> CommandResult<String> {
    state
        .database
        .create_notebook(&name)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn create_section(
    notebook_id: String,
    name: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    state
        .database
        .create_section(&notebook_id, &name)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn create_section_group(
    notebook_id: String,
    name: String,
    parent_group_id: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    state.database.create_section_group(&notebook_id, &name, parent_group_id.as_deref()).map_err(CommandError::database)
}

#[tauri::command]
pub fn rename_section_group(
    group_id: String,
    name: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.database.rename_section_group(&group_id, &name).map_err(CommandError::database)
}

#[tauri::command]
pub fn set_section_group_parent(
    group_id: String,
    parent_group_id: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.database.set_section_group_parent(&group_id, parent_group_id.as_deref()).map_err(CommandError::database)
}

#[tauri::command]
pub fn move_section_to_group(
    section_id: String,
    group_id: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.database.move_section_to_group(&section_id, group_id.as_deref()).map_err(CommandError::database)
}

#[tauri::command]
pub fn delete_section_group(
    group_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.database.delete_section_group(&group_id).map_err(CommandError::database)
}

#[tauri::command]
pub fn create_page(
    section_id: String,
    title: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    state
        .database
        .create_page(&section_id, &title)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn create_page_with_content(
    section_id: String,
    title: String,
    content_json: String,
    plain_text: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    state
        .database
        .create_page_with_content(&section_id, &title, &content_json, &plain_text)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn duplicate_page(page_id: String, state: State<'_, AppState>) -> CommandResult<String> {
    state
        .database
        .duplicate_page(&page_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn rename_notebook(
    notebook_id: String,
    name: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .rename_notebook(&notebook_id, &name)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn set_notebook_color(
    notebook_id: String,
    color: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.database.set_notebook_color(&notebook_id, &color).map_err(CommandError::database)
}

#[tauri::command]
pub fn rename_section(
    section_id: String,
    name: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .rename_section(&section_id, &name)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn set_section_color(
    section_id: String,
    color: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.database.set_section_color(&section_id, &color).map_err(CommandError::database)
}

#[tauri::command]
pub fn set_section_group_color(
    group_id: String,
    color: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.database.set_section_group_color(&group_id, &color).map_err(CommandError::database)
}

#[tauri::command]
pub fn set_section_default_template(
    section_id: String,
    template_id: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.database.set_section_default_template(&section_id, template_id.as_deref()).map_err(CommandError::database)
}

#[tauri::command]
pub fn move_section(
    section_id: String,
    notebook_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .move_section(&section_id, &notebook_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn move_page(
    page_id: String,
    section_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .move_page(&page_id, &section_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn set_page_parent(
    page_id: String,
    parent_page_id: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .set_page_parent(&page_id, parent_page_id.as_deref())
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn reorder_page(
    page_id: String,
    direction: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.database.reorder_page(&page_id, &direction).map_err(CommandError::database)
}

#[tauri::command]
pub fn position_page(
    page_id: String,
    target_page_id: String,
    placement: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state.database.position_page(&page_id, &target_page_id, &placement).map_err(CommandError::database)
}

#[tauri::command]
pub fn check_workspace_integrity(state: State<'_, AppState>) -> CommandResult<String> {
    state.database.integrity_check().map_err(CommandError::database)
}

#[tauri::command]
pub fn update_page(
    page_id: String,
    title: String,
    content_json: String,
    plain_text: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .update_page(&page_id, &title, &content_json, &plain_text)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn set_page_favorite(
    page_id: String,
    is_favorite: bool,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .set_page_favorite(&page_id, is_favorite)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> CommandResult<Vec<Tag>> {
    state.database.list_tags().map_err(CommandError::database)
}

#[tauri::command]
pub fn create_tag(
    name: String,
    color: String,
    state: State<'_, AppState>,
) -> CommandResult<Tag> {
    state
        .database
        .create_tag(&name, &color)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn add_tag_to_page(
    page_id: String,
    tag_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .add_tag_to_page(&page_id, &tag_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn remove_tag_from_page(
    page_id: String,
    tag_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .remove_tag_from_page(&page_id, &tag_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn search_pages(
    query: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<PageLocation>> {
    state
        .database
        .search_pages(&query)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn list_recent_pages(state: State<'_, AppState>) -> CommandResult<Vec<PageLocation>> {
    state
        .database
        .list_recent_pages()
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn list_favorite_pages(state: State<'_, AppState>) -> CommandResult<Vec<PageLocation>> {
    state
        .database
        .list_favorite_pages()
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn create_page_revision(
    page_id: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    state
        .database
        .create_page_revision(&page_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn list_page_revisions(
    page_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<PageRevision>> {
    state
        .database
        .list_page_revisions(&page_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn restore_page_revision(
    page_id: String,
    revision_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Page> {
    state
        .database
        .restore_page_revision(&page_id, &revision_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn trash_notebook(
    notebook_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .trash_notebook(&notebook_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn trash_section(
    section_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .trash_section(&section_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn trash_page(page_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    state
        .database
        .trash_page(&page_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn list_trash(state: State<'_, AppState>) -> CommandResult<Vec<TrashEntry>> {
    state.database.list_trash().map_err(CommandError::database)
}

#[tauri::command]
pub fn restore_trash_entry(
    trash_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .restore_trash_entry(&trash_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn delete_trash_entry(
    trash_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    state
        .database
        .delete_trash_entry(&trash_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn empty_trash(state: State<'_, AppState>) -> CommandResult<()> {
    state.database.empty_trash().map_err(CommandError::database)
}

#[tauri::command]
pub fn create_backup(state: State<'_, AppState>) -> CommandResult<BackupInfo> {
    let info = state.database.create_backup(&state.backup_dir).map_err(CommandError::database)?;
    crate::snapshot_attachments(&state.attachment_dir, &state.backup_dir, &info.file_name).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Database backup succeeded, but attachment snapshot failed: {error}"),
    })?;
    Ok(info)
}

#[tauri::command]
pub fn list_backups(state: State<'_, AppState>) -> CommandResult<Vec<BackupInfo>> {
    state
        .database
        .list_backups(&state.backup_dir)
        .map_err(CommandError::database)
}


#[tauri::command]
pub fn list_attachments(page_id: String, state: State<'_, AppState>) -> CommandResult<Vec<Attachment>> {
    state.database.list_attachments(&page_id).map_err(CommandError::database)
}

#[tauri::command]
pub fn import_attachment(
    page_id: String,
    source_path: String,
    state: State<'_, AppState>,
) -> CommandResult<Attachment> {
    let source = Path::new(&source_path);
    let file_name = source.file_name().and_then(|name| name.to_str()).ok_or_else(|| CommandError {
        code: "invalid_path",
        message: "The selected file has no valid file name.".into(),
    })?;
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("");
    let stored_name = if extension.is_empty() {
        uuid::Uuid::now_v7().to_string()
    } else {
        format!("{}.{}", uuid::Uuid::now_v7(), extension)
    };
    let destination = state.attachment_dir.join(stored_name);
    let metadata = fs::metadata(source).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Unable to read selected file: {error}"),
    })?;
    fs::copy(source, &destination).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Unable to copy attachment: {error}"),
    })?;
    let mime_type = mime_guess::from_path(source).first_or_octet_stream().to_string();
    state.database.add_attachment_record(
        &page_id,
        file_name,
        &destination.to_string_lossy(),
        &mime_type,
        metadata.len(),
    ).map_err(CommandError::database)
}

#[tauri::command]
pub fn import_attachment_bytes(
    page_id: String,
    file_name: String,
    mime_type: String,
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> CommandResult<Attachment> {
    if bytes.is_empty() || bytes.len() > 100_000_000 {
        return Err(CommandError {
            code: "validation_error",
            message: "Imported clipboard or recording data must be between 1 byte and 100 MB.".into(),
        });
    }
    let safe_name = Path::new(&file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("pasted-image.png");
    let extension = Path::new(safe_name).extension().and_then(|value| value.to_str()).unwrap_or("png");
    let stored_name = format!("{}.{}", uuid::Uuid::now_v7(), extension);
    let destination = state.attachment_dir.join(stored_name);
    fs::write(&destination, &bytes).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Unable to store pasted image: {error}"),
    })?;
    let detected_mime = if mime_type.trim().is_empty() {
        mime_guess::from_path(safe_name).first_or_octet_stream().to_string()
    } else {
        mime_type
    };
    state.database.add_attachment_record(
        &page_id,
        safe_name,
        &destination.to_string_lossy(),
        &detected_mime,
        bytes.len() as u64,
    ).map_err(CommandError::database)
}

#[tauri::command]
pub fn read_attachment_bytes(
    attachment_id: String,
    state: State<'_, AppState>,
) -> CommandResult<tauri::ipc::Response> {
    let attachment = state
        .database
        .get_attachment(&attachment_id)
        .map_err(CommandError::database)?;

    let root = fs::canonicalize(&state.attachment_dir).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Unable to resolve the attachment directory: {error}"),
    })?;
    let path = fs::canonicalize(Path::new(&attachment.stored_path)).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Unable to resolve the audio attachment: {error}"),
    })?;
    if !path.starts_with(&root) {
        return Err(CommandError {
            code: "validation_error",
            message: "Attachment path is outside LeNota managed storage.".into(),
        });
    }
    let metadata = fs::metadata(&path).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Unable to inspect the audio attachment: {error}"),
    })?;
    if metadata.len() > 250_000_000 {
        return Err(CommandError {
            code: "validation_error",
            message: "In-app playback is limited to recordings smaller than 250 MB.".into(),
        });
    }
    let bytes = fs::read(&path).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Unable to read the audio attachment: {error}"),
    })?;
    Ok(tauri::ipc::Response::new(bytes))
}

fn validate_ocr_language(language: Option<String>) -> CommandResult<String> {
    let language = language.unwrap_or_else(|| "eng".into());
    if language.is_empty() || language.len() > 64 || !language.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-')) {
        return Err(CommandError { code: "validation_error", message: "OCR language must be a Tesseract language code such as eng, ara, or eng+ara.".into() });
    }
    Ok(language)
}

fn run_tesseract(path: &Path, language: &str, psm: u8) -> CommandResult<String> {
    let output = Command::new("tesseract")
        .arg(path)
        .arg("stdout")
        .arg("-l")
        .arg(language)
        .arg("--psm")
        .arg(psm.to_string())
        .output()
        .map_err(|error| CommandError {
            code: "ocr_engine_missing",
            message: if error.kind() == std::io::ErrorKind::NotFound {
                "Image and handwriting OCR require Tesseract. On Fedora run: sudo dnf install tesseract tesseract-langpack-eng (and any language packs you need).".into()
            } else { format!("Unable to start OCR engine: {error}") },
        })?;
    if !output.status.success() {
        return Err(CommandError { code: "ocr_failed", message: format!("OCR failed: {}", String::from_utf8_lossy(&output.stderr).trim()) });
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.len() > 2_000_000 {
        return Err(CommandError { code: "validation_error", message: "OCR output exceeded the 2 MB safety limit.".into() });
    }
    Ok(text)
}

#[tauri::command]
pub fn ocr_image_bytes(
    bytes: Vec<u8>,
    language: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    if bytes.is_empty() || bytes.len() > 25_000_000 {
        return Err(CommandError { code: "validation_error", message: "Handwriting OCR input must be between 1 byte and 25 MB.".into() });
    }
    let language = validate_ocr_language(language)?;
    // Store the transient raster inside app-managed storage so the OCR engine never receives an arbitrary path.
    let temp_path = state.attachment_dir.join(format!(".ink-ocr-{}.png", uuid::Uuid::now_v7()));
    fs::write(&temp_path, &bytes).map_err(|error| CommandError { code: "file_error", message: format!("Unable to prepare handwriting OCR image: {error}") })?;
    let result = run_tesseract(&temp_path, &language, 6);
    let _ = fs::remove_file(&temp_path);
    result
}



fn cloud_ai_python(ai_dir: &Path) -> CommandResult<PathBuf> {
    let candidate = std::env::var_os("LENOTA_AI_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("python3"));
    let _ = ai_dir;
    Ok(candidate)
}

fn spawn_cloud_ai_worker(ai_dir: &Path) -> CommandResult<LiveAiWorker> {
    let python = cloud_ai_python(ai_dir)?;
    let script = ai_dir.join("cloud_ai_worker.py");
    if !script.is_file() {
        return Err(CommandError { code: "cloud_ai_missing", message: "LeNota Gemini worker script is missing. Restart LeNota or reinstall the current milestone.".into() });
    }
    let mut child = Command::new(python)
        .arg("-u")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| CommandError { code: "cloud_ai_failed", message: format!("Unable to start the Gemini worker with Python 3: {error}") })?;
    let stdin = child.stdin.take().ok_or_else(|| CommandError { code: "cloud_ai_failed", message: "Gemini worker stdin was unavailable.".into() })?;
    let stdout = child.stdout.take().ok_or_else(|| CommandError { code: "cloud_ai_failed", message: "Gemini worker stdout was unavailable.".into() })?;
    Ok(LiveAiWorker { child, stdin, stdout: BufReader::new(stdout) })
}


fn cloud_ai_request(
    ai_dir: &Path,
    worker_slot: &Arc<Mutex<Option<LiveAiWorker>>>,
    request: serde_json::Value,
) -> CommandResult<serde_json::Value> {
    let mut guard = worker_slot.lock().map_err(|_| CommandError { code: "cloud_ai_failed", message: "Gemini worker lock was poisoned.".into() })?;
    let needs_spawn = match guard.as_mut() {
        Some(worker) => worker.child.try_wait().map_err(|error| CommandError { code: "cloud_ai_failed", message: format!("Unable to inspect Gemini worker: {error}") })?.is_some(),
        None => true,
    };
    if needs_spawn {
        *guard = Some(spawn_cloud_ai_worker(ai_dir)?);
    }
    let worker = guard.as_mut().expect("worker created");
    let line = serde_json::to_string(&request).map_err(|error| CommandError { code: "cloud_ai_failed", message: format!("Unable to encode Gemini request: {error}") })?;
    worker.stdin.write_all(line.as_bytes()).and_then(|_| worker.stdin.write_all(b"\n")).and_then(|_| worker.stdin.flush())
        .map_err(|error| CommandError { code: "cloud_ai_failed", message: format!("Unable to send request to Gemini: {error}") })?;

    for _ in 0..2048 {
        let mut response_line = String::new();
        let read = worker.stdout.read_line(&mut response_line).map_err(|error| CommandError { code: "cloud_ai_failed", message: format!("Unable to read Gemini response: {error}") })?;
        if read == 0 {
            *guard = None;
            return Err(CommandError { code: "cloud_ai_failed", message: "Gemini worker stopped before returning a result.".into() });
        }
        let Some(payload) = response_line.trim().strip_prefix("LNJSON:") else { continue; };
        let value: serde_json::Value = serde_json::from_str(payload).map_err(|error| CommandError { code: "cloud_ai_failed", message: format!("Gemini worker returned invalid JSON: {error}") })?;
        if let Some(message) = value.get("error").and_then(|value| value.as_str()) {
            return Err(CommandError { code: "cloud_ai_failed", message: message.to_string() });
        }
        return Ok(value);
    }
    Err(CommandError { code: "cloud_ai_failed", message: "Gemini worker produced too much diagnostic output without a result.".into() })
}

fn cloud_ai_key_path(ai_dir: &Path) -> PathBuf {
    ai_dir.join(".gemini-api-key")
}

fn read_cloud_ai_key(ai_dir: &Path) -> CommandResult<String> {
    if let Ok(value) = std::env::var("GOOGLE_API_KEY").or_else(|_| std::env::var("GEMINI_API_KEY")) {
        let key = value.trim().to_string();
        if !key.is_empty() { return Ok(key); }
    }
    let key = fs::read_to_string(cloud_ai_key_path(ai_dir))
        .map_err(|_| CommandError { code: "cloud_ai_unconfigured", message: "Gemini Cloud AI is not configured. Add an API key from the drawing toolbar first.".into() })?
        .trim()
        .to_string();
    if key.is_empty() {
        return Err(CommandError { code: "cloud_ai_unconfigured", message: "Gemini Cloud AI API key is empty.".into() });
    }
    Ok(key)
}

fn valid_cloud_ai_key(key: &str) -> bool {
    // Gemini keys are opaque credentials. New AI Studio auth keys use the
    // `AQ.` form, while older standard keys commonly use `AIza...`. Validate
    // only transport safety instead of freezing another provider-specific
    // prefix/alphabet into the app. Visible ASCII excludes spaces and CR/LF
    // header injection while allowing Google's current period separator.
    (20..=1024).contains(&key.len())&&key.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

#[tauri::command]
pub fn cloud_ai_status(state: State<'_, AppState>) -> CloudAiStatus {
    CloudAiStatus { configured: read_cloud_ai_key(&state.ai_dir).is_ok(), provider: "Gemini" }
}

#[tauri::command]
pub fn configure_cloud_ai(api_key: Option<String>, state: State<'_, AppState>) -> CommandResult<CloudAiStatus> {
    let path = cloud_ai_key_path(&state.ai_dir);
    let Some(key) = api_key.map(|value| value.trim().to_string()) else {
        if path.exists() {
            fs::remove_file(&path).map_err(|error| CommandError { code: "file_error", message: format!("Unable to remove the Gemini API key: {error}") })?;
        }
        let environment_key=std::env::var("GOOGLE_API_KEY").or_else(|_| std::env::var("GEMINI_API_KEY"));
        return Ok(CloudAiStatus { configured: environment_key.is_ok_and(|value| valid_cloud_ai_key(value.trim())), provider: "Gemini" });
    };
    if !valid_cloud_ai_key(&key) {
        return Err(CommandError { code: "validation_error", message: "Gemini API keys must contain 20–1024 visible characters with no spaces or line breaks.".into() });
    }
    let temporary = state.ai_dir.join(".gemini-api-key.tmp");
    fs::write(&temporary, key.as_bytes()).map_err(|error| CommandError { code: "file_error", message: format!("Unable to save the Gemini API key: {error}") })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| CommandError { code: "file_error", message: format!("Unable to protect the Gemini API key: {error}") })?;
    }
    fs::rename(&temporary, &path).map_err(|error| CommandError { code: "file_error", message: format!("Unable to activate the Gemini API key: {error}") })?;
    Ok(CloudAiStatus { configured: true, provider: "Gemini" })
}

#[cfg(test)]
mod cloud_ai_key_tests {
    use super::valid_cloud_ai_key;

    #[test]
    fn accepts_current_auth_and_legacy_key_shapes() {
        assert!(valid_cloud_ai_key("AQ.synthetic_auth-key_with.period_123456"));
        assert!(valid_cloud_ai_key("AIzaSyntheticLegacyKey_1234567890"));
    }

    #[test]
    fn rejects_header_injection_and_whitespace() {
        assert!(!valid_cloud_ai_key("AQ.synthetic key with spaces_123456"));
        assert!(!valid_cloud_ai_key("AQ.synthetic-key\r\nInjected:yes"));
    }
}

#[tauri::command]
pub async fn ocr_cloud_ink_image_bytes(
    bytes: Vec<u8>,
    mode: String,
    language: Option<String>,
    hint: Option<String>,
    timeout_ms: Option<u64>,
    state: State<'_, AppState>,
) -> CommandResult<serde_json::Value> {
    if bytes.is_empty() || bytes.len() > 10_000_000 {
        return Err(CommandError { code: "validation_error", message: "Cloud Ink input must be between 1 byte and 10 MB.".into() });
    }
    if !matches!(mode.as_str(), "auto" | "math" | "text") {
        return Err(CommandError { code: "validation_error", message: "Unknown Cloud Ink recognition mode.".into() });
    }
    let language = language.unwrap_or_else(|| "eng".into());
    if language.len() > 40 || language.chars().any(char::is_control) {
        return Err(CommandError { code: "validation_error", message: "Cloud Ink language hint is invalid.".into() });
    }
    let hint = hint.unwrap_or_default();
    if hint.len() > 500 {
        return Err(CommandError { code: "validation_error", message: "Cloud Ink vector hint is too long.".into() });
    }
    let api_key = read_cloud_ai_key(&state.ai_dir)?;
    let attachment_dir = state.attachment_dir.clone();
    let ai_dir = state.ai_dir.clone();
    let worker_slot = state.cloud_ai_worker.clone();
    let timeout_ms = timeout_ms.unwrap_or(15_000).clamp(2_000, 30_000);
    drop(state);
    tauri::async_runtime::spawn_blocking(move || {
        let temp_path = attachment_dir.join(format!(".cloud-ink-{}.png", uuid::Uuid::now_v7()));
        fs::write(&temp_path, &bytes).map_err(|error| CommandError { code: "file_error", message: format!("Unable to prepare the Cloud Ink image: {error}") })?;
        let result = (|| {
            let value = cloud_ai_request(&ai_dir, &worker_slot, serde_json::json!({
                "op":"cloud_ink", "path":temp_path, "api_key":api_key,
                "timeout_seconds":timeout_ms as f64 / 1000.0, "mode":mode,
                "language":language, "hint":hint,
            }))?;
            let kind = value.get("kind").and_then(|value| value.as_str()).unwrap_or_default();
            if !matches!(kind, "math" | "text") {
                return Err(CommandError { code: "cloud_ai_failed", message: "Gemini did not return text or math.".into() });
            }
            Ok(value)
        })();
        let _ = fs::remove_file(&temp_path);
        result
    })
    .await
    .map_err(|error| CommandError { code: "cloud_ai_failed", message: format!("Gemini worker stopped unexpectedly: {error}") })?
}


#[tauri::command]
pub async fn cloud_math_solve(
    latex: String,
    timeout_ms: Option<u64>,
    force_graph: Option<bool>,
    state: State<'_, AppState>,
) -> CommandResult<serde_json::Value> {
    let latex = latex.trim().to_string();
    if latex.is_empty() || latex.len() > 12_000 || !latex.contains('=') || latex.chars().any(|character| character == '\0') {
        return Err(CommandError { code: "validation_error", message: "Cloud Math requires a LaTeX question containing '=' (maximum 12,000 characters).".into() });
    }
    let api_key = read_cloud_ai_key(&state.ai_dir)?;
    let ai_dir = state.ai_dir.clone();
    let worker_slot = state.cloud_ai_worker.clone();
    let timeout_ms = timeout_ms.unwrap_or(30_000).clamp(2_000, 60_000);
    drop(state);
    tauri::async_runtime::spawn_blocking(move || {
        let value = cloud_ai_request(&ai_dir, &worker_slot, serde_json::json!({
            "op":"cloud_math_solve", "api_key":api_key, "latex":latex,
            "timeout_seconds":timeout_ms as f64 / 1000.0, "force_graph":force_graph.unwrap_or(false),
        }))?;
        let status = value.get("status").and_then(|entry| entry.as_str()).unwrap_or_default();
        if !matches!(status, "solved" | "identity" | "relation" | "not_solvable") {
            return Err(CommandError { code: "cloud_ai_failed", message: "Gemini returned an invalid math-solver response.".into() });
        }
        Ok(value)
    })
    .await
    .map_err(|error| CommandError { code: "cloud_ai_failed", message: format!("Gemini math worker stopped unexpectedly: {error}") })?
}

#[tauri::command]
pub async fn cloud_ask(
    prompt: String,
    page_context: Option<String>,
    timeout_ms: Option<u64>,
    state: State<'_, AppState>,
) -> CommandResult<serde_json::Value> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() || prompt.len() > 20_000 || prompt.chars().any(|character| character == '\0') {
        return Err(CommandError { code: "validation_error", message: "The /ask request must contain 1–20,000 characters.".into() });
    }
    let page_context = page_context.unwrap_or_default();
    if page_context.len() > 160_000 || page_context.chars().any(|character| character == '\0') {
        return Err(CommandError { code: "validation_error", message: "The current-page AI context exceeded the 160 KB safety limit.".into() });
    }
    let api_key = read_cloud_ai_key(&state.ai_dir)?;
    let ai_dir = state.ai_dir.clone();
    let worker_slot = state.cloud_ai_worker.clone();
    let timeout_ms = timeout_ms.unwrap_or(30_000).clamp(2_000, 60_000);
    drop(state);
    tauri::async_runtime::spawn_blocking(move || {
        let value = cloud_ai_request(&ai_dir, &worker_slot, serde_json::json!({
            "op":"cloud_ask", "api_key":api_key, "prompt":prompt, "page_context":page_context,
            "timeout_seconds":timeout_ms as f64 / 1000.0,
        }))?;
        if !value.get("blocks").is_some_and(|blocks| blocks.is_array()) {
            return Err(CommandError { code: "cloud_ai_failed", message: "Gemini returned invalid note content.".into() });
        }
        Ok(value)
    })
    .await
    .map_err(|error| CommandError { code: "cloud_ai_failed", message: format!("Gemini worker stopped unexpectedly: {error}") })?
}

#[tauri::command]
pub async fn cloud_ask_selection(
    bytes: Vec<u8>,
    prompt: String,
    page_context: Option<String>,
    timeout_ms: Option<u64>,
    state: State<'_, AppState>,
) -> CommandResult<serde_json::Value> {
    if bytes.is_empty() || bytes.len() > 15_000_000 {
        return Err(CommandError { code: "validation_error", message: "The visual selection must be a PNG between 1 byte and 15 MB.".into() });
    }
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() || prompt.len() > 20_000 || prompt.chars().any(|character| character == '\0') {
        return Err(CommandError { code: "validation_error", message: "The visual /ask request must contain 1–20,000 characters.".into() });
    }
    let page_context = page_context.unwrap_or_default();
    if page_context.len() > 160_000 || page_context.chars().any(|character| character == '\0') {
        return Err(CommandError { code: "validation_error", message: "The current-page AI context exceeded the 160 KB safety limit.".into() });
    }
    let api_key = read_cloud_ai_key(&state.ai_dir)?;
    let attachment_dir = state.attachment_dir.clone();
    let ai_dir = state.ai_dir.clone();
    let worker_slot = state.cloud_ai_worker.clone();
    let timeout_ms = timeout_ms.unwrap_or(30_000).clamp(2_000, 60_000);
    drop(state);
    tauri::async_runtime::spawn_blocking(move || {
        let temp_path = attachment_dir.join(format!(".cloud-ask-selection-{}.png", uuid::Uuid::now_v7()));
        fs::write(&temp_path, &bytes).map_err(|error| CommandError { code: "file_error", message: format!("Unable to prepare the visual selection: {error}") })?;
        let result = (|| {
            let value = cloud_ai_request(&ai_dir, &worker_slot, serde_json::json!({
                "op":"cloud_ask", "api_key":api_key, "prompt":prompt, "page_context":page_context,
                "image_path":temp_path, "timeout_seconds":timeout_ms as f64 / 1000.0,
            }))?;
            if !value.get("blocks").is_some_and(|blocks| blocks.is_array()) {
                return Err(CommandError { code: "cloud_ai_failed", message: "Gemini returned invalid note content.".into() });
            }
            Ok(value)
        })();
        let _ = fs::remove_file(&temp_path);
        result
    })
    .await
    .map_err(|error| CommandError { code: "cloud_ai_failed", message: format!("Gemini visual-selection worker stopped unexpectedly: {error}") })?
}


#[tauri::command]
pub fn ocr_attachment(
    attachment_id: String,
    language: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let attachment = state
        .database
        .get_attachment(&attachment_id)
        .map_err(CommandError::database)?;
    if !attachment.mime_type.starts_with("image/") {
        return Err(CommandError { code: "validation_error", message: "OCR currently supports image attachments.".into() });
    }
    let root = fs::canonicalize(&state.attachment_dir).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Unable to resolve the attachment directory: {error}"),
    })?;
    let path = fs::canonicalize(Path::new(&attachment.stored_path)).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Unable to resolve the image attachment: {error}"),
    })?;
    if !path.starts_with(&root) {
        return Err(CommandError { code: "validation_error", message: "Attachment path is outside LeNota managed storage.".into() });
    }
    let metadata = fs::metadata(&path).map_err(|error| CommandError { code: "file_error", message: format!("Unable to inspect image: {error}") })?;
    if metadata.len() > 75_000_000 {
        return Err(CommandError { code: "validation_error", message: "OCR is limited to images smaller than 75 MB.".into() });
    }
    let language = validate_ocr_language(language)?;
    run_tesseract(&path, &language, 6)
}

#[tauri::command]
pub fn prepare_microphone_access(state: State<'_, AppState>) -> CommandResult<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    // Keep the WebKitGTK permission gate open briefly. The frontend only calls
    // this after the user explicitly accepts LeNota's microphone prompt.
    state.microphone_permission_until_ms.store(
        now.saturating_add(15_000),
        std::sync::atomic::Ordering::Relaxed,
    );
    Ok(())
}

#[tauri::command]
pub fn render_pdf_printout(
    page_id: String,
    source_path: String,
    dpi: Option<u32>,
    first_page: Option<u32>,
    last_page: Option<u32>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<Attachment>> {
    let source = Path::new(&source_path);
    let is_pdf = source.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case("pdf"));
    if !is_pdf || !source.is_file() {
        return Err(CommandError { code: "validation_error", message: "Choose a readable PDF file.".into() });
    }
    // Confirm the target page before doing potentially expensive rendering work.
    state.database.list_attachments(&page_id).map_err(CommandError::database)?;

    let temp_dir = state.attachment_dir.join(format!(".pdf-printout-{}", uuid::Uuid::now_v7()));
    fs::create_dir_all(&temp_dir).map_err(|error| CommandError { code: "file_error", message: format!("Unable to create PDF render directory: {error}") })?;
    let prefix = temp_dir.join("page");
    let dpi = dpi.unwrap_or(144).clamp(72, 300);
    if let (Some(first), Some(last)) = (first_page, last_page) {
        if first == 0 || last == 0 || first > last {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(CommandError { code: "validation_error", message: "PDF page range is invalid.".into() });
        }
    }
    let mut renderer = Command::new("pdftoppm");
    renderer.arg("-png").arg("-r").arg(dpi.to_string());
    if let Some(first) = first_page.filter(|value| *value > 0) { renderer.arg("-f").arg(first.to_string()); }
    if let Some(last) = last_page.filter(|value| *value > 0) { renderer.arg("-l").arg(last.to_string()); }
    let output = renderer
        .arg(source)
        .arg(&prefix)
        .output()
        .map_err(|error| CommandError {
            code: "pdf_renderer_missing",
            message: if error.kind() == std::io::ErrorKind::NotFound {
                "PDF printouts require Poppler. On Fedora run: sudo dnf install poppler-utils".into()
            } else { format!("Unable to start PDF renderer: {error}") },
        })?;
    if !output.status.success() {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(CommandError {
            code: "pdf_render_failed",
            message: format!("Unable to render PDF: {}", String::from_utf8_lossy(&output.stderr).trim()),
        });
    }

    let mut rendered = fs::read_dir(&temp_dir)
        .map_err(|error| CommandError { code: "file_error", message: format!("Unable to read PDF output: {error}") })?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case("png")))
        .collect::<Vec<_>>();
    rendered.sort_by_key(|path| {
        path.file_stem().and_then(|value| value.to_str())
            .and_then(|value| value.rsplit('-').next())
            .and_then(|value| value.parse::<usize>().ok()).unwrap_or(usize::MAX)
    });
    if rendered.is_empty() {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(CommandError { code: "pdf_render_failed", message: "The PDF renderer produced no pages.".into() });
    }
    if rendered.len() > 200 {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(CommandError { code: "validation_error", message: "PDF printouts are currently limited to 200 pages per insertion.".into() });
    }

    let source_name = source.file_stem().and_then(|value| value.to_str()).unwrap_or("PDF");
    let mut attachments = Vec::with_capacity(rendered.len());
    for (index, rendered_path) in rendered.iter().enumerate() {
        let stored_name = format!("{}.png", uuid::Uuid::now_v7());
        let destination = state.attachment_dir.join(stored_name);
        if fs::rename(rendered_path, &destination).is_err() {
            fs::copy(rendered_path, &destination).map_err(|error| CommandError { code: "file_error", message: format!("Unable to store PDF page image: {error}") })?;
        }
        let size = fs::metadata(&destination).map_err(|error| CommandError { code: "file_error", message: format!("Unable to inspect PDF page image: {error}") })?.len();
        let file_name = format!("{} - page {}.png", source_name, index + 1);
        let attachment = state.database.add_attachment_record(
            &page_id, &file_name, &destination.to_string_lossy(), "image/png", size,
        ).map_err(CommandError::database)?;
        attachments.push(attachment);
    }
    let _ = fs::remove_dir_all(&temp_dir);
    Ok(attachments)
}

#[tauri::command]
pub fn remove_attachment(attachment_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    let stored_path = state.database.remove_attachment_record(&attachment_id).map_err(CommandError::database)?;
    match fs::remove_file(stored_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandError { code: "file_error", message: error.to_string() }),
    }
}

#[tauri::command]
pub fn export_page(
    page_id: String,
    destination_path: String,
    format: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let (title, plain_text) = state.database.page_export_data(&page_id).map_err(CommandError::database)?;
    let output = match format.as_str() {
        "markdown" => format!("# {}\n\n{}\n", title, plain_text),
        "html" => format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body><h1>{}</h1><pre style=\"white-space:pre-wrap;font-family:system-ui\">{}</pre></body></html>",
            escape_html(&title), escape_html(&title), escape_html(&plain_text),
        ),
        "text" => format!("{}\n\n{}\n", title, plain_text),
        _ => return Err(CommandError { code: "validation_error", message: "Unsupported export format.".into() }),
    };
    fs::write(destination_path, output).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Unable to export page: {error}"),
    })
}

fn escape_html(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}


#[tauri::command]
pub fn import_text_page(
    section_id: String,
    source_path: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let source = Path::new(&source_path);
    let text = fs::read_to_string(source).map_err(|error| CommandError {
        code: "file_error",
        message: format!("Unable to read imported document: {error}"),
    })?;
    let title = source.file_stem().and_then(|value| value.to_str()).unwrap_or("Imported page");
    let paragraphs: Vec<serde_json::Value> = text
        .split("\n\n")
        .map(|paragraph| paragraph.trim())
        .filter(|paragraph| !paragraph.is_empty())
        .map(|paragraph| serde_json::json!({
            "type": "paragraph",
            "content": [{ "type": "text", "text": paragraph }]
        }))
        .collect();
    let document = serde_json::json!({
        "type": "doc",
        "content": if paragraphs.is_empty() { vec![serde_json::json!({ "type": "paragraph" })] } else { paragraphs }
    });
    state.database.create_page_with_content(&section_id, title, &document.to_string(), &text)
        .map_err(CommandError::database)
}


fn safe_export_component(value: &str, fallback: &str) -> String {
    let mut out = value
        .chars()
        .map(|ch| if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { ch })
        .take(80)
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if out.is_empty() { out = fallback.to_string(); }
    out
}

fn export_page_to_directory(page: &PageSummary, prefix: &str, directory: &Path, state: &AppState) -> CommandResult<()> {
    let full = state.database.get_page(&page.id).map_err(CommandError::database)?;
    let short_id = page.id.get(..8).unwrap_or(&page.id);
    let stem = format!("{} {}-{}", prefix, safe_export_component(&full.title, "Untitled page"), short_id);
    let markdown_path = directory.join(format!("{stem}.md"));
    let markdown = format!("# {}\n\n{}\n", full.title, full.plain_text);
    fs::write(&markdown_path, markdown).map_err(|error| CommandError { code: "file_error", message: format!("Unable to export page: {error}") })?;

    let attachments = state.database.list_attachments(&page.id).map_err(CommandError::database)?;
    if !attachments.is_empty() {
        let attachment_dir = directory.join(format!("{stem} files"));
        fs::create_dir_all(&attachment_dir).map_err(|error| CommandError { code: "file_error", message: format!("Unable to create attachment export directory: {error}") })?;
        for attachment in attachments {
            let source = Path::new(&attachment.stored_path);
            if !source.exists() { continue; }
            let attachment_short_id = attachment.id.get(..8).unwrap_or(&attachment.id);
            let destination = attachment_dir.join(format!("{}-{}", attachment_short_id, safe_export_component(&attachment.file_name, "attachment")));
            fs::copy(source, destination).map_err(|error| CommandError { code: "file_error", message: format!("Unable to export attachment: {error}") })?;
        }
    }
    Ok(())
}

fn export_page_tree(pages: &[PageSummary], parent_id: Option<&str>, prefix: &str, directory: &Path, state: &AppState) -> CommandResult<()> {
    let children = pages.iter().filter(|page| page.parent_page_id.as_deref() == parent_id).collect::<Vec<_>>();
    for (index, page) in children.into_iter().enumerate() {
        let number = if prefix.is_empty() { format!("{:03}", index + 1) } else { format!("{}.{}", prefix, index + 1) };
        export_page_to_directory(page, &number, directory, state)?;
        export_page_tree(pages, Some(&page.id), &number, directory, state)?;
    }
    Ok(())
}

fn section_export_directory(root: &Path, notebook: &NotebookNode, section: &SectionNode) -> PathBuf {
    let mut path = root.to_path_buf();
    if let Some(group_id) = section.section_group_id.as_deref() {
        let mut chain = Vec::new();
        let mut cursor = Some(group_id);
        let mut guard = 0;
        while let Some(id) = cursor {
            if guard > 32 { break; }
            guard += 1;
            let Some(group) = notebook.section_groups.iter().find(|group| group.id == id) else { break; };
            chain.push(group);
            cursor = group.parent_group_id.as_deref();
        }
        for group in chain.into_iter().rev() {
            path.push(safe_export_component(&group.name, "Section group"));
        }
    }
    path.push(safe_export_component(&section.name, "Section"));
    path
}

#[tauri::command]
pub fn export_section_bundle(
    section_id: String,
    destination_path: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let tree = state.database.load_workspace_tree().map_err(CommandError::database)?;
    let (notebook, section) = tree.notebooks.iter().find_map(|notebook| {
        notebook.sections.iter().find(|section| section.id == section_id).map(|section| (notebook, section))
    }).ok_or_else(|| CommandError { code: "not_found", message: "Section was not found.".into() })?;
    let root = Path::new(&destination_path);
    let directory = section_export_directory(root, notebook, section);
    fs::create_dir_all(&directory).map_err(|error| CommandError { code: "file_error", message: format!("Unable to create export directory: {error}") })?;
    export_page_tree(&section.pages, None, "", &directory, state.inner())
}

#[tauri::command]
pub fn export_notebook_bundle(
    notebook_id: String,
    destination_path: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let tree = state.database.load_workspace_tree().map_err(CommandError::database)?;
    let notebook = tree.notebooks.iter().find(|notebook| notebook.id == notebook_id)
        .ok_or_else(|| CommandError { code: "not_found", message: "Notebook was not found.".into() })?;
    let root = Path::new(&destination_path).join(safe_export_component(&notebook.name, "Notebook"));
    fs::create_dir_all(&root).map_err(|error| CommandError { code: "file_error", message: format!("Unable to create notebook export directory: {error}") })?;
    for section in &notebook.sections {
        let directory = section_export_directory(&root, notebook, section);
        fs::create_dir_all(&directory).map_err(|error| CommandError { code: "file_error", message: format!("Unable to create section export directory: {error}") })?;
        export_page_tree(&section.pages, None, "", &directory, state.inner())?;
    }
    Ok(())
}
