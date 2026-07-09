CREATE TABLE IF NOT EXISTS lean_signals (
  scan_date   TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  region      TEXT,
  sector      TEXT,
  signal      TEXT NOT NULL,
  signals       TEXT,
  signal_count  INTEGER,
  rvol        REAL,
  ath_pct     REAL,
  day_pct     REAL,
  stage2      INTEGER,
  dist_pivot  REAL,
  score       INTEGER,
  price       REAL,
  rs          INTEGER,
  ingested_at TEXT,
  PRIMARY KEY (scan_date, ticker)
);
CREATE INDEX IF NOT EXISTS idx_lean_date  ON lean_signals(scan_date);
CREATE INDEX IF NOT EXISTS idx_lean_score ON lean_signals(score);
