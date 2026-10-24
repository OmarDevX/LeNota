//! Run the production sync engine without the desktop WebView. Close LeNota
//! first. Diagnostic output contains counts/stages, not note text or tokens.
use app_database::Database;
use app_sync::SyncEngine;
use std::{path::PathBuf, sync::Arc};

fn run() -> Result<(), String> {
    let root = std::env::args_os().nth(1).map(PathBuf::from).ok_or(
        "Usage: LENOTA_SYNC_TRACE=1 cargo run -p app-sync --example diagnose_sync -- APP_DATA_DIRECTORY",
    )?;
    let path = root.join("workspace.sqlite3");
    if !path.is_file() || !root.join("attachments").is_dir() {
        return Err("Existing LeNota database/attachment directory not found. No new workspace was created.".into());
    }
    println!("Close the LeNota app before running this check.");
    let database = Arc::new(Database::open(&path).map_err(|e| e.to_string())?);
    let engine = SyncEngine::new(
        database.clone(),
        root.join("attachments"),
        root.join("backups"),
    );
    if engine.status()?["signedIn"] != true {
        return Err("This workspace is not signed in. Sign in through LeNota first.".into());
    }
    {
        let snapshot = database.sync_snapshot().map_err(|e| e.to_string())?;
        for table in ["pages", "attachments", "page_revisions"] {
            println!(
                "Local {table}: {}",
                snapshot[table].as_object().map_or(0, |rows| rows.len())
            );
        }
    }
    engine.prepare()?;
    let result = engine.finish()?;
    if result["applied"] != true {
        return Err("The workspace changed during sync. Close LeNota and retry this check.".into());
    }
    let (settings, _) = database.sync_state().map_err(|e| e.to_string())?;
    println!(
        "Sync completed. Cloud version: {}",
        settings["remoteVersion"]
    );
    println!(
        "Conflicts saved in History: {}",
        result["conflicts"].as_array().map_or(0, |rows| rows.len())
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Sync check failed: {error}");
        std::process::exit(1);
    }
}
