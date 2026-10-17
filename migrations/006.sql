CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('import','note')),
  title TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  submission TEXT NOT NULL UNIQUE,
  attachment_id TEXT,
  source_id TEXT,
  channel TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL,
  event_at INTEGER,
  current_revision INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE document_revisions (
  document_id TEXT NOT NULL REFERENCES documents(id),
  revision INTEGER NOT NULL,
  original_hash TEXT NOT NULL,
  original_bytes INTEGER NOT NULL,
  note_text TEXT,
  markdown TEXT,
  representation_hash TEXT,
  conversion TEXT,
  extraction TEXT NOT NULL DEFAULT 'pending',
  lexical TEXT NOT NULL DEFAULT 'pending',
  semantic TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  PRIMARY KEY(document_id,revision)
);
CREATE TABLE document_jobs (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  FOREIGN KEY(document_id,revision) REFERENCES document_revisions(document_id,revision),
  PRIMARY KEY(document_id,revision)
);
CREATE INDEX document_jobs_pending ON document_jobs(status,next_at);
CREATE INDEX documents_source ON documents(source_id);
CREATE INDEX documents_attachment ON documents(attachment_id);
