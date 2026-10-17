-- Keep retained evidence and owner-reviewed facts; replace only the old derived vector index.
DROP TABLE IF EXISTS vectors;
CREATE TABLE IF NOT EXISTS mem0_vectors(
  id TEXT PRIMARY KEY,
  record_id TEXT UNIQUE REFERENCES retrieval(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  version TEXT NOT NULL,
  vector BLOB NOT NULL,
  payload TEXT NOT NULL
);
-- Entity boosts are rebuildable. Conservative invalidation prevents erased names surviving.
CREATE TRIGGER IF NOT EXISTS mem0_erase_entities AFTER DELETE ON retrieval BEGIN
  DELETE FROM mem0_vectors WHERE collection='entities';
END;
