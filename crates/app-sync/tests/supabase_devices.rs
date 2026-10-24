//! Real Rust clients against a protocol simulator; SQL/RLS is tested separately
//! in real PostgreSQL (PGlite), not simulated here. No live project is contacted.
use app_database::Database;
use app_sync::SyncEngine;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
};
struct Setup {
    child: Child,
    root: PathBuf,
    url: String,
}
impl Setup {
    fn start() -> Self {
        let root =
            std::env::temp_dir().join(format!("lenota-managed-test-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&root).unwrap();
        let mut child = Command::new("python3")
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../server"))
            .args(["-u", "mock_supabase.py"])
            .arg(root.join("cloud"))
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut port = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut port)
            .unwrap();
        let port: u16 = port.trim().parse().expect("Mock Supabase failed to start");
        Self {
            child,
            root,
            url: format!("http://127.0.0.1:{port}"),
        }
    }
    fn device(&self, name: &str) -> (Arc<Database>, SyncEngine, PathBuf) {
        let root = self.root.join(name);
        let files = root.join("attachments");
        fs::create_dir_all(&files).unwrap();
        let db = Arc::new(Database::open(root.join("workspace.sqlite3")).unwrap());
        let engine = SyncEngine::new(db.clone(), files.clone(), root.join("backups"));
        (db, engine, files)
    }
    fn login(&self, engine: &SyncEngine, signup: bool) {
        engine
            .login_supabase(
                self.url.clone(),
                "sb_publishable_test".into(),
                "me@example.com".into(),
                "correct horse battery staple".into(),
                signup,
            )
            .unwrap();
    }
    fn stats(&self) -> Value {
        reqwest::blocking::get(format!("{}/test/stats", self.url))
            .unwrap()
            .json()
            .unwrap()
    }
}
impl Drop for Setup {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn sync(engine: &SyncEngine) -> Value {
    engine.prepare().unwrap();
    let r = engine.finish().unwrap();
    assert_eq!(r["applied"], true);
    r
}
fn doc(text: &str) -> String {
    json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
        .to_string()
}
#[test]
fn free_backend_round_trip_refresh_conflicts_and_low_bandwidth_polling() {
    let s = Setup::start();
    let (pc, pc_sync, files) = s.device("pc");
    let (phone, phone_sync, phone_files) = s.device("phone");
    s.login(&pc_sync, true);
    let section = pc.load_workspace_tree().unwrap().notebooks[0].sections[0]
        .id
        .clone();
    let page = pc.create_page(&section, "Cloud note").unwrap();
    pc.update_page(&page, "Cloud note", &doc("PC body"), "PC body")
        .unwrap();
    let file = files.join("picture.png");
    fs::write(&file, b"image").unwrap();
    let attachment = pc
        .add_attachment_record(
            &page,
            "picture.png",
            &file.to_string_lossy(),
            "image/png",
            5,
        )
        .unwrap();
    sync(&pc_sync);
    s.login(&phone_sync, false);
    sync(&phone_sync);
    sync(&pc_sync);
    sync(&phone_sync);
    assert_eq!(phone.get_page(&page).unwrap().plain_text, "PC body");
    assert_eq!(fs::read(phone_files.join("picture.png")).unwrap(), b"image");
    let before = s.stats();
    for _ in 0..3 {
        sync(&pc_sync);
    }
    let after = s.stats();
    assert_eq!(before["pushes"], after["pushes"]);
    assert_eq!(before["file_downloads"], after["file_downloads"]);
    assert_eq!(
        after["unchanged_pulls"].as_u64().unwrap() - before["unchanged_pulls"].as_u64().unwrap(),
        3
    );
    phone
        .update_page(&page, "Cloud note", &doc("Phone offline"), "Phone offline")
        .unwrap();
    sync(&phone_sync);
    sync(&pc_sync);
    assert_eq!(pc.get_page(&page).unwrap().plain_text, "Phone offline");
    // Expired access tokens refresh automatically; rotated refresh token is saved.
    let (mut settings, _) = pc.sync_state().unwrap();
    let previous = settings["refreshToken"].clone();
    settings["expiresAt"] = json!(1);
    pc.set_sync_settings(&settings).unwrap();
    sync(&pc_sync);
    assert_ne!(pc.sync_state().unwrap().0["refreshToken"], previous);
    assert_eq!(s.stats()["refreshes"], 1);
    pc.update_page(
        &page,
        "Cloud note",
        &doc("PC simultaneous"),
        "PC simultaneous",
    )
    .unwrap();
    phone
        .update_page(
            &page,
            "Cloud note",
            &doc("Phone simultaneous"),
            "Phone simultaneous",
        )
        .unwrap();
    sync(&pc_sync);
    let r = sync(&phone_sync);
    assert!(!r["conflicts"].as_array().unwrap().is_empty());
    sync(&pc_sync);
    assert_eq!(pc.get_page(&page).unwrap().plain_text, "Phone simultaneous");
    assert_eq!(
        pc.list_page_revisions(&page)
            .unwrap()
            .iter()
            .filter(|r| r.id.starts_with("sync-"))
            .count(),
        2
    );
    // A lost/delayed acknowledgement never overwrites a newer local draft.
    phone_sync.prepare().unwrap();
    phone
        .update_page(&page, "New draft", &doc("keep"), "keep")
        .unwrap();
    assert_eq!(phone_sync.finish().unwrap()["applied"], false);
    sync(&phone_sync);
    sync(&pc_sync);
    assert_eq!(pc.get_page(&page).unwrap().plain_text, "keep");
    // A compare-and-swap conflict is retried against the newer cloud workspace.
    reqwest::blocking::get(format!("{}/test/race", s.url)).unwrap();
    pc.update_page(&page, "New draft", &doc("after race"), "after race")
        .unwrap();
    sync(&pc_sync);
    assert_eq!(s.stats()["last_cas_conflict"], true);
    sync(&phone_sync);
    assert_eq!(phone.get_page(&page).unwrap().plain_text, "after race");
    assert_eq!(phone.get_attachment(&attachment.id).unwrap().size_bytes, 5);
    pc.trash_page(&page).unwrap();
    sync(&pc_sync);
    sync(&phone_sync);
    assert!(phone.get_page(&page).is_err());
    phone_sync.logout().unwrap();
    assert_eq!(phone_sync.status().unwrap()["signedIn"], false);
    s.login(&phone_sync, false);
    sync(&phone_sync);
    assert!(phone.get_page(&page).is_err());
}
#[test]
fn secret_keys_and_cross_account_workspace_switches_are_rejected() {
    let s = Setup::start();
    let (_, engine, _) = s.device("pc");
    assert!(
        engine
            .login_supabase(
                s.url.clone(),
                "sb_secret_private".into(),
                "me@example.com".into(),
                "correct horse battery staple".into(),
                true
            )
            .unwrap_err()
            .contains("publishable")
    );
    s.login(&engine, true);
    engine.logout().unwrap();
    assert!(
        engine
            .login_supabase(
                s.url.clone(),
                "sb_publishable_test".into(),
                "other@example.com".into(),
                "correct horse battery staple".into(),
                true
            )
            .is_err()
    );
}
