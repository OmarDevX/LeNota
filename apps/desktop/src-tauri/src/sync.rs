//! Native command adapters. HTTP and conflict-safe persistence live in app-sync.
use crate::AppState;
use serde_json::Value;
use tauri::State;
type Result<T> = std::result::Result<T, String>;

#[tauri::command]
pub async fn sync_status(state: State<'_, AppState>) -> Result<Value> {
    let engine = state.sync_engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.status())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sync_login(
    server_url: String,
    email: String,
    password: String,
    signup: bool,
    allow_http: bool,
    provider: Option<String>,
    public_key: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value> {
    let engine = state.sync_engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if provider.as_deref() == Some("supabase") {
            engine.login_supabase(
                server_url,
                public_key.unwrap_or_default(),
                email,
                password,
                signup,
            )
        } else {
            engine.login(server_url, email, password, signup, allow_http)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sync_logout(state: State<'_, AppState>) -> Result<Value> {
    let engine = state.sync_engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.logout())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> Result<Value> {
    let engine = state.sync_engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.prepare())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sync_finish(state: State<'_, AppState>) -> Result<Value> {
    let engine = state.sync_engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.finish())
        .await
        .map_err(|e| e.to_string())?
}
