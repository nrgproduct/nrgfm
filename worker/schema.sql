-- the play log (kept one year) and the devices that played
CREATE TABLE IF NOT EXISTS plays (
  id TEXT PRIMARY KEY,      -- one play (made by the page)
  ts INTEGER NOT NULL,      -- when it started (unix seconds)
  who TEXT NOT NULL,        -- the browser/device that played it (a random id kept in that browser)
  url TEXT, tid TEXT, title TEXT,
  sec INTEGER,              -- seconds actually played
  dur INTEGER,              -- length of the track (seconds), when known
  city TEXT, country TEXT   -- roughly where (from Cloudflare; the IP address itself is not stored)
);
CREATE INDEX IF NOT EXISTS plays_ts ON plays(ts);
CREATE INDEX IF NOT EXISTS plays_who ON plays(who, ts);
CREATE TABLE IF NOT EXISTS devices (
  who TEXT PRIMARY KEY,
  name TEXT,                -- a name given on the Activity page ("MacBook", "iPhone"); empty for guests
  owner INTEGER DEFAULT 0,  -- played with the editing key on that device
  city TEXT, country TEXT,
  first INTEGER, last INTEGER
);
