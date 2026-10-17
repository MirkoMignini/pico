CREATE TABLE IF NOT EXISTS skill_packages(
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  description TEXT NOT NULL,
  metadata TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  directory TEXT NOT NULL,
  origin TEXT NOT NULL,
  PRIMARY KEY(skill_id,version),
  FOREIGN KEY(skill_id,version) REFERENCES skills(id,version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS skill_files(
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  content BLOB NOT NULL,
  executable INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(skill_id,version,path),
  FOREIGN KEY(skill_id,version) REFERENCES skills(id,version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS skill_sources(
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY(skill_id,version,source_id),
  FOREIGN KEY(skill_id,version) REFERENCES skills(id,version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS skill_activations(
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_id,skill_id),
  FOREIGN KEY(skill_id,version) REFERENCES skills(id,version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS skill_outputs(
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE
);
