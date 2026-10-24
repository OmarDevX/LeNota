//! Real Rust clients, independent SQLite files, and the real HTTP sync server.
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
        let root = std::env::temp_dir().join(format!("lenota-sync-test-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&root).unwrap();
        let server = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../server");
        let mut child = Command::new("python3")
            .current_dir(server)
            .args(["-u", "-c", "import sys; from sync_server import Store,make_server; s=make_server(Store(sys.argv[1]),port=0); print(s.server_port,flush=True); s.serve_forever()"])
            .arg(root.join("cloud")).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let port: u16 = line
            .trim()
            .parse()
            .expect("Python test server failed to start");
        Self {
            child,
            root,
            url: format!("http://127.0.0.1:{port}"),
        }
    }
    fn device(&self, name: &str) -> (Arc<Database>, SyncEngine, PathBuf) {
        let directory = self.root.join(name);
        let attachments = directory.join("attachments");
        fs::create_dir_all(&attachments).unwrap();
        let db = Arc::new(Database::open(directory.join("workspace.sqlite3")).unwrap());
        let engine = SyncEngine::new(db.clone(), attachments.clone(), directory.join("backups"));
        (db, engine, attachments)
    }
    fn login(&self, engine: &SyncEngine, signup: bool) {
        engine
            .login(
                self.url.clone(),
                "me@example.com".into(),
                "correct horse battery staple".into(),
                signup,
                false,
            )
            .unwrap();
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
    let result = engine.finish().unwrap();
    assert_eq!(result["applied"], true);
    result
}
fn body(text: &str) -> String {
    json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
        .to_string()
}

#[test]
fn pc_phone_round_trip_attachments_conflicts_and_inflight_edits() {
    let setup = Setup::start();
    let (pc, pc_sync, pc_files) = setup.device("pc");
    let (phone, phone_sync, phone_files) = setup.device("phone");
    setup.login(&pc_sync, true);
    let section = pc.load_workspace_tree().unwrap().notebooks[0].sections[0]
        .id
        .clone();
    let page = pc.create_page(&section, "My real note").unwrap();
    pc.update_page(
        &page,
        "My real note",
        &body("written on PC"),
        "written on PC",
    )
    .unwrap();
    let path = pc_files.join("test-image.png");
    fs::write(&path, b"saved image bytes").unwrap();
    let attachment = pc
        .add_attachment_record(&page, "image.png", &path.to_string_lossy(), "image/png", 17)
        .unwrap();
    let card = json!({"type":"doc","content":[{"type":"attachmentCard","attrs":{"attachmentId":attachment.id,"storedPath":path.to_string_lossy(),"fileName":"image.png","src":"asset://pc-only-path"}}]});
    pc.update_page(&page, "My real note", &card.to_string(), "written on PC")
        .unwrap();
    sync(&pc_sync);
    setup.login(&phone_sync, false);
    sync(&phone_sync);
    assert_eq!(phone.get_page(&page).unwrap().plain_text, "written on PC");
    assert_eq!(
        fs::read(phone_files.join("test-image.png")).unwrap(),
        b"saved image bytes"
    );
    let phone_doc: Value =
        serde_json::from_str(&phone.get_page(&page).unwrap().content_json).unwrap();
    assert_eq!(
        phone_doc["content"][0]["attrs"]["storedPath"],
        phone_files
            .join("test-image.png")
            .to_string_lossy()
            .as_ref()
    );
    assert!(phone_doc["content"][0]["attrs"]["src"].is_null());
    let portable = phone.sync_snapshot().unwrap();
    assert!(
        !portable["pages"][&page]["content_json"]
            .as_str()
            .unwrap()
            .contains(phone_files.to_str().unwrap())
    );
    assert!(
        phone
            .get_attachment(&attachment.id)
            .unwrap()
            .stored_path
            .starts_with(phone_files.to_str().unwrap())
    );
    phone
        .update_page(
            &page,
            "My real note",
            &body("edited on phone"),
            "edited on phone",
        )
        .unwrap();
    sync(&phone_sync);
    sync(&pc_sync);
    assert_eq!(pc.get_page(&page).unwrap().plain_text, "edited on phone");
    // Pull the same acknowledged workspace on both devices before concurrent edits.
    sync(&phone_sync);
    pc.update_page(
        &page,
        "My real note",
        &body("PC concurrent"),
        "PC concurrent",
    )
    .unwrap();
    phone
        .update_page(
            &page,
            "My real note",
            &body("Phone concurrent"),
            "Phone concurrent",
        )
        .unwrap();
    sync(&pc_sync);
    let merged = sync(&phone_sync);
    assert!(!merged["conflicts"].as_array().unwrap().is_empty());
    sync(&pc_sync);
    assert_eq!(pc.get_page(&page).unwrap().plain_text, "Phone concurrent");
    assert_eq!(
        pc.list_page_revisions(&page)
            .unwrap()
            .iter()
            .filter(|r| r.id.starts_with("sync-"))
            .count(),
        2
    );
    // A local edit after the request snapshot is captured refuses the import.
    pc_sync.prepare().unwrap();
    pc.update_page(
        &page,
        "Local edit during request",
        &body("keep this"),
        "keep this",
    )
    .unwrap();
    let refused = pc_sync.finish().unwrap();
    assert_eq!(refused["applied"], false);
    assert_eq!(pc.get_page(&page).unwrap().plain_text, "keep this");
    sync(&pc_sync);
    sync(&phone_sync);
    assert_eq!(phone.get_page(&page).unwrap().plain_text, "keep this");
    // Deletion propagates and a stale unedited phone cannot resurrect it.
    pc.trash_page(&page).unwrap();
    sync(&pc_sync);
    sync(&phone_sync);
    assert!(phone.get_page(&page).is_err());
}

#[test]
fn logout_keeps_binding_and_native_client_rejects_insecure_remote_urls() {
    let setup = Setup::start();
    let (db, engine, _) = setup.device("pc");
    setup.login(&engine, true);
    sync(&engine);
    let baseline = db.sync_state().unwrap().1;
    engine.logout().unwrap();
    assert_eq!(engine.status().unwrap()["signedIn"], false);
    assert_eq!(db.sync_state().unwrap().1, baseline);
    assert!(
        engine
            .login(
                setup.url.clone(),
                "other@example.com".into(),
                "correct horse battery staple".into(),
                true,
                false
            )
            .is_err()
    );
    setup.login(&engine, false);
    assert_eq!(engine.status().unwrap()["signedIn"], true);
    let (_, empty_engine, _) = setup.device("unbound");
    assert!(
        empty_engine
            .login(
                "http://notes.example.com".into(),
                "x@example.com".into(),
                "correct horse battery staple".into(),
                false,
                false
            )
            .unwrap_err()
            .contains("HTTPS")
    );
}
