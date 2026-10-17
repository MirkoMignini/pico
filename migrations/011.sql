CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL CHECK(end_at > start_at),
  timezone TEXT NOT NULL,
  location TEXT NOT NULL,
  notes TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_events_time ON calendar_events(start_at,end_at);
CREATE TABLE IF NOT EXISTS calendar_sources (
  event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  PRIMARY KEY(event_id,source_id)
);
CREATE INDEX IF NOT EXISTS calendar_sources_source ON calendar_sources(source_id);
