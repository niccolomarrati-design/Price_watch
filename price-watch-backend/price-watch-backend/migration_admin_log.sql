-- migration_admin_log.sql — aggiunge la tabella dei log di esecuzione
-- usata dal pannello gestore (statistiche e log controlli).
-- Esegui con:
-- npx wrangler d1 execute price-watch-db --remote --file=migration_admin_log.sql

CREATE TABLE IF NOT EXISTS execution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT,
  product_id TEXT,
  product_title TEXT,
  result TEXT NOT NULL, -- ok | changed | error
  message TEXT
);

CREATE INDEX IF NOT EXISTS idx_exec_log_ts ON execution_log(ts DESC);
