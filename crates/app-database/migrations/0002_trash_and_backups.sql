BEGIN IMMEDIATE;

ALTER TABLE notebooks ADD COLUMN deleted_at TEXT;
ALTER TABLE notebooks ADD COLUMN trash_batch_id TEXT;

ALTER TABLE sections ADD COLUMN deleted_at TEXT;
ALTER TABLE sections ADD COLUMN trash_batch_id TEXT;

ALTER TABLE pages ADD COLUMN deleted_at TEXT;
ALTER TABLE pages ADD COLUMN trash_batch_id TEXT;

CREATE TABLE IF NOT EXISTS trash_entries (
    id           TEXT PRIMARY KEY NOT NULL,
    entity_type  TEXT NOT NULL CHECK (entity_type IN ('notebook', 'section', 'page')),
    entity_id    TEXT NOT NULL,
    title        TEXT NOT NULL,
    parent_title TEXT,
    deleted_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_notebooks_active_order
ON notebooks(deleted_at, order_key);

CREATE INDEX IF NOT EXISTS idx_sections_active_order
ON sections(notebook_id, deleted_at, order_key);

CREATE INDEX IF NOT EXISTS idx_pages_active_order
ON pages(section_id, deleted_at, order_key);

CREATE INDEX IF NOT EXISTS idx_trash_entries_deleted_at
ON trash_entries(deleted_at DESC);

PRAGMA user_version = 2;

COMMIT;
