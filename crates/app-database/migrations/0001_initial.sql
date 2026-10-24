PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notebooks (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#7c3aed',
    order_key   REAL NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sections (
    id           TEXT PRIMARY KEY NOT NULL,
    notebook_id  TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    color        TEXT NOT NULL DEFAULT '#a78bfa',
    order_key    REAL NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sections_notebook_order
ON sections(notebook_id, order_key);

CREATE TABLE IF NOT EXISTS pages (
    id            TEXT PRIMARY KEY NOT NULL,
    section_id    TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    title         TEXT NOT NULL DEFAULT '',
    content_json  TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',
    plain_text    TEXT NOT NULL DEFAULT '',
    order_key     REAL NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pages_section_order
ON pages(section_id, order_key);

PRAGMA user_version = 1;
