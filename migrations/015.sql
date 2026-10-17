-- Family links grant narrow application capabilities, never owner IPC access.
CREATE TABLE IF NOT EXISTS family_peers (
  instance_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  alias TEXT NOT NULL COLLATE NOCASE UNIQUE,
  public_key TEXT NOT NULL,
  socket TEXT NOT NULL,
  reminders INTEGER NOT NULL CHECK(reminders IN (0,1)),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  created_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS family_shares (
  peer_id TEXT NOT NULL REFERENCES family_peers(instance_id),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK(permission IN ('read','edit')),
  source_id TEXT,
  PRIMARY KEY(peer_id,document_id)
);
-- No message/list bodies or private keys in protocol receipts.
CREATE TABLE IF NOT EXISTS family_requests (
  peer_id TEXT NOT NULL REFERENCES family_peers(instance_id),
  request_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  action TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(peer_id,request_id,direction)
);
CREATE INDEX IF NOT EXISTS family_request_rate ON family_requests(peer_id,direction,created_at);
CREATE TABLE IF NOT EXISTS family_reminders (
  schedule_id TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  peer_id TEXT NOT NULL REFERENCES family_peers(instance_id)
);
