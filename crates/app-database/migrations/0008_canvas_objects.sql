-- Canvas objects are written independently. Legacy content_json remains readable;
-- edited canvases are migrated atomically and reassembled at API/sync boundaries.
CREATE TABLE IF NOT EXISTS page_canvas_state (
    page_id        TEXT PRIMARY KEY NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    metadata_json  TEXT NOT NULL,
    source_sha256  TEXT NOT NULL,
    source_bytes   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS page_canvas_items (
    page_id    TEXT NOT NULL REFERENCES page_canvas_state(page_id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK(kind IN ('containers', 'ink', 'shapes')),
    item_id    TEXT NOT NULL,
    position   INTEGER NOT NULL,
    item_json  TEXT NOT NULL,
    item_sha256 TEXT NOT NULL,
    PRIMARY KEY(page_id, kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_page_canvas_items_order
    ON page_canvas_items(page_id, kind, position);
PRAGMA user_version = 8;
