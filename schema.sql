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
  status TEXT NOT NULL DEFAULT 'approved',  -- 'approved' shows on the site; 'pending' waits for a human OK
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lab_comments_path
  ON lab_comments (path, status);

CREATE INDEX IF NOT EXISTS idx_lab_comments_ip
  ON lab_comments (ip_hash, created_at);
