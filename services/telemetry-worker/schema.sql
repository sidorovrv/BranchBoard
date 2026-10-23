CREATE TABLE IF NOT EXISTS daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_on TEXT NOT NULL,
  payload_id TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS daily_payload_id ON daily (payload_id);

CREATE INDEX IF NOT EXISTS daily_received_on ON daily (received_on);

CREATE TABLE IF NOT EXISTS update_checks (
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  node INTEGER NOT NULL,
  install TEXT NOT NULL,
  auto INTEGER NOT NULL,
  first INTEGER NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (day, version, os, arch, node, install, auto, first)
);
