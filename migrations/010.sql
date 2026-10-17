CREATE TABLE IF NOT EXISTS web_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('search','page')),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  data TEXT NOT NULL,
  body BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS web_source_dependencies (
  web_id TEXT NOT NULL REFERENCES web_sources(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  PRIMARY KEY(web_id,source_id)
);
CREATE INDEX IF NOT EXISTS web_dependency_source ON web_source_dependencies(source_id);
