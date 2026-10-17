CREATE TABLE action_sources(action_id TEXT NOT NULL REFERENCES pending_actions(id) ON DELETE CASCADE,source_id TEXT NOT NULL,PRIMARY KEY(action_id,source_id));
CREATE TABLE schedule_sources(schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,source_id TEXT NOT NULL,PRIMARY KEY(schedule_id,source_id));
