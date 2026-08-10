mod commands;

use std::{fs, io::BufReader, path::PathBuf, process::{Child, ChildStdin, ChildStdout}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::{SystemTime, UNIX_EPOCH}};

use app_database::Database;
use tauri::Manager;

pub(crate) struct LiveAiWorker {
    pub(crate) child: Child,
    pub(crate) stdin: ChildStdin,
    pub(crate) stdout: BufReader<ChildStdout>,
}

impl Drop for LiveAiWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct AppState {
    database: Arc<Database>,
    backup_dir: PathBuf,
    attachment_dir: PathBuf,
    ai_dir: PathBuf,
    cloud_ai_worker: Arc<Mutex<Option<LiveAiWorker>>>,
    microphone_permission_until_ms: Arc<AtomicU64>,
}

fn unix_time_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}


pub(crate) fn snapshot_attachments(
    attachment_dir: &std::path::Path,
    backup_dir: &std::path::Path,
    backup_file_name: &str,
) -> std::io::Result<()> {
    let stem = backup_file_name.strip_suffix(".sqlite3").unwrap_or(backup_file_name);
    let destination = backup_dir.join(format!("{stem}-attachments"));
    if destination.exists() {
        fs::remove_dir_all(&destination)?;
    }
    fs::create_dir_all(&destination)?;
    if attachment_dir.exists() {
        for entry in fs::read_dir(attachment_dir)? {
            let entry = entry?;
            let source = entry.path();
            if !source.is_file() { continue; }
            let target = destination.join(entry.file_name());
            if fs::hard_link(&source, &target).is_err() {
                fs::copy(&source, &target)?;
            }
        }
    }
    prune_orphan_attachment_snapshots(backup_dir)
}

fn prune_orphan_attachment_snapshots(backup_dir: &std::path::Path) -> std::io::Result<()> {
    if !backup_dir.exists() { return Ok(()); }
    for entry in fs::read_dir(backup_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() { continue; }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else { continue; };
        let Some(stem) = name.strip_suffix("-attachments") else { continue; };
        if !backup_dir.join(format!("{stem}.sqlite3")).exists() {
            let _ = fs::remove_dir_all(path);
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let backup_dir = app_data_dir.join("backups");
            let attachment_dir = app_data_dir.join("attachments");
            let ai_dir = app_data_dir.join("ai");
            fs::create_dir_all(&attachment_dir)?;
            fs::create_dir_all(&ai_dir)?;
            // Keep the dependency-free Gemini bridge alongside app-managed data.
            // It speaks a small JSON-lines protocol and stores no model weights.
            fs::write(ai_dir.join("cloud_ai_worker.py"), include_str!("cloud_ai_worker.py"))?;
            let database_path = app_data_dir.join("workspace.sqlite3");
            let database = Arc::new(Database::open(database_path).map_err(|error| {
                std::io::Error::other(format!("failed to initialize database: {error}"))
            })?);

            match database.create_backup_if_due(&backup_dir) {
                Ok(Some(info)) => {
                    if let Err(error) = snapshot_attachments(&attachment_dir, &backup_dir, &info.file_name) {
                        eprintln!("automatic attachment backup failed: {error}");
                    }
                }
                Ok(None) => {}
                Err(error) => eprintln!("automatic backup failed: {error}"),
            }

            let microphone_permission_until_ms = Arc::new(AtomicU64::new(0));

            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                use webkit2gtk::{PermissionRequestExt, WebViewExt};
                let permission_gate = microphone_permission_until_ms.clone();
                window.with_webview(move |platform_webview| {
                    let webview = platform_webview.inner();
                    webview.connect_permission_request(move |_, request| {
                        // WebKitGTK denies user-media permission requests by default when the
                        // embedder does not handle this signal. The frontend opens an explicit
                        // LeNota permission prompt first, then arms this short-lived gate.
                        if permission_gate.load(Ordering::Relaxed) >= unix_time_ms() {
                            request.allow();
                        } else {
                            request.deny();
                        }
                        true
                    });
                })?;
            }

            app.manage(AppState {
                database,
                backup_dir,
                attachment_dir,
                ai_dir,
                cloud_ai_worker: Arc::new(Mutex::new(None)),
                microphone_permission_until_ms,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_workspace,
            commands::get_page,
            commands::create_notebook,
            commands::create_section,
            commands::create_section_group,
            commands::rename_section_group,
            commands::set_section_group_parent,
            commands::move_section_to_group,
            commands::delete_section_group,
            commands::create_page,
            commands::create_page_with_content,
            commands::duplicate_page,
            commands::rename_notebook,
            commands::set_notebook_color,
            commands::rename_section,
            commands::set_section_color,
            commands::set_section_group_color,
            commands::set_section_default_template,
            commands::move_section,
            commands::move_page,
            commands::set_page_parent,
            commands::reorder_page,
            commands::position_page,
            commands::check_workspace_integrity,
            commands::update_page,
            commands::set_page_favorite,
            commands::list_tags,
            commands::create_tag,
            commands::add_tag_to_page,
            commands::remove_tag_from_page,
            commands::search_pages,
            commands::list_recent_pages,
            commands::list_favorite_pages,
            commands::create_page_revision,
            commands::list_page_revisions,
            commands::restore_page_revision,
            commands::trash_notebook,
            commands::trash_section,
            commands::trash_page,
            commands::list_trash,
            commands::restore_trash_entry,
            commands::delete_trash_entry,
            commands::empty_trash,
            commands::create_backup,
            commands::list_backups,
            commands::list_attachments,
            commands::import_attachment,
            commands::import_attachment_bytes,
            commands::read_attachment_bytes,
            commands::ocr_attachment,
            commands::ocr_image_bytes,
            commands::cloud_ai_status,
            commands::configure_cloud_ai,
            commands::ocr_cloud_ink_image_bytes,
            commands::cloud_math_solve,
            commands::cloud_ask,
            commands::cloud_ask_selection,
            commands::prepare_microphone_access,
            commands::render_pdf_printout,
            commands::remove_attachment,
            commands::export_page,
            commands::export_section_bundle,
            commands::export_notebook_bundle,
            commands::import_text_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LeNota");
}
