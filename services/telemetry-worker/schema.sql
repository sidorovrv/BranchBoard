CREATE TABLE IF NOT EXISTS daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_on TEXT NOT NULL,
  payload_id TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS daily_payload_id ON daily (payload_id);

CREATE INDEX IF NOT EXISTS daily_received_on ON daily (received_on);
