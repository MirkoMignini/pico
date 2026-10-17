CREATE TABLE IF NOT EXISTS memory_evidence(memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE, source_id TEXT NOT NULL, quote TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_dependencies(memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, source_id TEXT NOT NULL, PRIMARY KEY(memory_id,source_id));
CREATE INDEX IF NOT EXISTS memory_dependencies_source ON memory_dependencies(source_id);
CREATE INDEX IF NOT EXISTS memories_source ON memories(source_id);
CREATE INDEX IF NOT EXISTS reviews_pending ON reviews(status,next_at);
CREATE INDEX IF NOT EXISTS retrieval_source ON retrieval(source_id);
CREATE INDEX IF NOT EXISTS messages_run ON messages(run_id);
-- Derived indexes can be rebuilt without changing retained statements or reviewed facts.
DELETE FROM vectors;
DELETE FROM retrieval;
INSERT INTO retrieval(id,kind,text,source_id,event_at,entity) SELECT id,'message',text,id,event_at,NULL FROM messages WHERE role='user';
-- Legacy table IDs can overlap; match the normal last-write-wins derivative rebuild.
INSERT OR REPLACE INTO retrieval(id,kind,text,source_id,event_at,entity) SELECT id,'memory',entity||' '||key||': '||value,source_id,event_at,entity FROM memories WHERE status IN ('current','candidate','superseded');
INSERT OR REPLACE INTO retrieval(id,kind,text,source_id,event_at,entity) SELECT 'media:'||attachment_id,'media-derivative',text,source_id,recorded_at,NULL FROM media_derivatives;
INSERT OR REPLACE INTO retrieval(id,kind,text,source_id,event_at,entity) SELECT 'mail:'||id,'mail',data,id,event_at,NULL FROM mail;
