-- Lab Comments — database shape for Cloudflare D1.
-- Run it once (see README, install step 2):
--   wrangler d1 execute YOUR-DB-NAME --remote --file=./schema.sql
-- The worker also creates this table on its own the first time it runs,
-- so this file is the tidy path, not a hard step.

CREATE TABLE IF NOT EXISTS lab_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,        -- the page the comment belongs to, e.g. /news/my-post
  name TEXT NOT NULL,        -- the name the reader typed (plain text)
  body TEXT NOT NULL,        -- the comment itself (plain text)
  ip_hash TEXT,              -- SHA-256 scramble of the poster's address; the address itself is never stored
  status TEXT NOT NULL DEFAULT 'approved',  -- 'approved' shows on the site; 'pending' waits for a human OK; 'rejected' never shows
  report_count INTEGER NOT NULL DEFAULT 0,  -- v2: how many readers reported this comment; at 2 a shown comment goes back to 'pending'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- v2: one row per reader report. The same person (same scrambled
-- address) reporting the same comment twice is counted once.
CREATE TABLE IF NOT EXISTS lab_comment_reports (
  comment_id INTEGER NOT NULL,  -- the comment that was reported
  ip_hash TEXT,                 -- SHA-256 scramble of the reporter's address; the address itself is never stored
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(comment_id, ip_hash)
);

CREATE INDEX IF NOT EXISTS idx_lab_comments_path
  ON lab_comments (path, status);

CREATE INDEX IF NOT EXISTS idx_lab_comments_ip
  ON lab_comments (ip_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_lab_comments_path_time
  ON lab_comments (path, created_at);

CREATE INDEX IF NOT EXISTS idx_lab_comment_reports_ip
  ON lab_comment_reports (ip_hash, created_at);
