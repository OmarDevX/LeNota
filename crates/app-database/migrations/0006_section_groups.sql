BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS section_groups (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    parent_group_id TEXT REFERENCES section_groups(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#8b5cf6',
    order_key REAL NOT NULL,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE sections ADD COLUMN section_group_id TEXT REFERENCES section_groups(id) ON DELETE SET NULL;
ALTER TABLE sections ADD COLUMN default_template_id TEXT;

CREATE INDEX IF NOT EXISTS idx_section_groups_notebook_order
ON section_groups(notebook_id, parent_group_id, order_key);

CREATE INDEX IF NOT EXISTS idx_sections_group_order
ON sections(notebook_id, section_group_id, order_key);

PRAGMA user_version = 6;

COMMIT;
