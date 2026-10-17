CREATE TABLE IF NOT EXISTS generated_images (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id),
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  quality TEXT NOT NULL,
  size TEXT NOT NULL,
  usage TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS generated_images_run ON generated_images(run_id);
CREATE TABLE IF NOT EXISTS generated_image_sources (
  attachment_id TEXT NOT NULL REFERENCES generated_images(attachment_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  PRIMARY KEY(attachment_id,source_id)
);
CREATE INDEX IF NOT EXISTS generated_image_sources_source ON generated_image_sources(source_id);
