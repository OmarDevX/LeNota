BEGIN IMMEDIATE;

ALTER TABLE pages ADD COLUMN parent_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pages_parent_order
ON pages(section_id, parent_page_id, order_key);

PRAGMA user_version = 5;

COMMIT;
