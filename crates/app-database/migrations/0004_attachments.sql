CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_attachments_page_id ON attachments(page_id, created_at);
PRAGMA user_version = 4;
