-- Topic labels organize evidence; they never change its provenance or authority.
CREATE TABLE IF NOT EXISTS memory_tags(
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY(memory_id,tag)
);
CREATE INDEX IF NOT EXISTS memory_tags_lookup ON memory_tags(tag,memory_id);
