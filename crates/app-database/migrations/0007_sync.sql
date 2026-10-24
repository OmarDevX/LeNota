-- Device-local account credentials and acknowledged server snapshot. Never synced.
CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    settings_json TEXT NOT NULL DEFAULT '{}',
    baseline_json TEXT NOT NULL DEFAULT '{}'
);
INSERT OR IGNORE INTO sync_state(id) VALUES (1);
PRAGMA user_version = 7;
