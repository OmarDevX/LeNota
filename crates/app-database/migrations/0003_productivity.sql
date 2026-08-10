BEGIN IMMEDIATE;

ALTER TABLE pages ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN last_opened_at TEXT;

CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
    color      TEXT NOT NULL DEFAULT '#8b5cf6',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS page_tags (
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (page_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_page_tags_tag ON page_tags(tag_id, page_id);

CREATE TABLE IF NOT EXISTS page_revisions (
    id           TEXT PRIMARY KEY NOT NULL,
    page_id      TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    content_json TEXT NOT NULL,
    plain_text   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_page_revisions_page_created
ON page_revisions(page_id, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(
    page_id UNINDEXED,
    title,
    plain_text,
    tags,
    tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO page_search (page_id, title, plain_text, tags)
SELECT p.id,
       p.title,
       p.plain_text,
       COALESCE(group_concat(t.name, ' '), '')
FROM pages p
LEFT JOIN page_tags pt ON pt.page_id = p.id
LEFT JOIN tags t ON t.id = pt.tag_id
GROUP BY p.id;

PRAGMA user_version = 3;

COMMIT;
