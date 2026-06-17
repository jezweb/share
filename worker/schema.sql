-- share — D1 schema. Plain DDL only; wrangler wraps the file atomically itself.
-- (Do not add explicit SQL transaction-control statements: D1 rejects them, AND
-- wrangler's file parser scans comment text for those keywords, so even naming
-- them here breaks `d1 execute --file`. Lived 2026-06-17.)

-- A share is a FOLDER of files in R2 under sites/<slug>/. This table holds only
-- the metadata; the page(s) and assets live in R2, served at the keyed URL.
CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,   -- readable-prefix + random-token; the URL lock
  title       TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,               -- NULL = no expiry; else unix seconds
  meta        TEXT,                   -- JSON: { keys: {<token>:<name>}, notify: <webhook-url> }
  views       INTEGER NOT NULL DEFAULT 0,  -- times the index page has been served (opened?)
  viewed_at   INTEGER                 -- unix seconds of the most recent view, NULL if never
);

CREATE INDEX IF NOT EXISTS idx_shares_slug ON shares(slug);

CREATE TABLE IF NOT EXISTS responses (
  id          TEXT PRIMARY KEY,
  share_id    TEXT NOT NULL,
  responder   TEXT,                   -- resolved from a per-person key, else NULL
  data        TEXT NOT NULL,          -- JSON payload from share.submit/comment/custom
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_responses_share ON responses(share_id);
