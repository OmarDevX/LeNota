//! Independent free AI providers. Credentials stay in native app storage.
use std::{fs, path::Path};
use serde::{Deserialize, Serialize};

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct Keys {
    pub openrouter: String,
    pub openai_images: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub openrouter_configured: bool,
    pub openai_images_configured: bool,
}
fn valid(key: &str) -> bool {
    (20..=1024).contains(&key.len()) && key.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}
impl Keys {
    pub fn configured(&self) -> bool { valid(&self.openrouter) || valid(&self.openai_images) }
    pub fn status(&self) -> Status { Status { openrouter_configured: valid(&self.openrouter), openai_images_configured: valid(&self.openai_images) } }
}
pub(crate) fn load(dir: &Path) -> Keys {
    fs::read(dir.join(".ai-backups.json")).ok().filter(|bytes| bytes.len() < 4096)
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}
pub(crate) fn save(dir: &Path, openrouter: Option<String>, remove_openrouter: bool, openai_images: Option<String>, remove_openai_images: bool) -> Result<Status, String> {
    let mut keys = load(dir);
    for (incoming, target, remove) in [(openrouter, &mut keys.openrouter, remove_openrouter), (openai_images, &mut keys.openai_images, remove_openai_images)] {
        if remove { target.clear(); }
        else if let Some(key) = incoming {
            let key = key.trim();
            if !valid(key) { return Err("API keys must contain 20–1024 visible characters without spaces.".into()); }
            *target = key.to_string();
        }
    }
    fs::create_dir_all(dir).map_err(|_| "Unable to create AI settings directory.")?;
    let temporary = dir.join(format!(".ai-backups-{}.tmp", uuid::Uuid::now_v7()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| "Unable to protect AI backup keys.")?;
        use std::io::Write;
        let bytes = serde_json::to_vec(&keys).map_err(|_| "Unable to encode AI settings.")?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "Unable to save AI backup keys.")?;
        fs::rename(&temporary, dir.join(".ai-backups.json")).map_err(|_| "Unable to activate AI backup keys.")?;
        Ok(keys.status())
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_header_injection() { assert!(!valid("a-long-key-with\r\ninjection")); assert!(valid("gsk_a-valid-synthetic-key")); }
    #[test]
    fn preserves_keys_and_supports_removal() {
        let dir = std::env::temp_dir().join(format!("lenota-keys-{}", uuid::Uuid::now_v7()));
        save(&dir, Some("sk-or-a-valid-synthetic-key".into()), false, Some("sk-test-example-image-key".into()), false).unwrap();
        assert!(load(&dir).status().openrouter_configured);
        assert!(load(&dir).status().openai_images_configured);
        assert!(save(&dir, Some("bad key".into()), false, None, false).is_err());
        assert!(load(&dir).status().openrouter_configured);
        save(&dir, None, true, None, false).unwrap();
        assert!(!load(&dir).status().openrouter_configured);
        assert!(load(&dir).status().openai_images_configured);
        save(&dir, None, false, None, true).unwrap();
        assert!(!load(&dir).status().openai_images_configured);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(dir.join(".ai-backups.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
