-- schema.sql — struttura del database D1 per Price Watch

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free', -- free | pro | max | god
  notify_mode TEXT NOT NULL DEFAULT 'any_drop', -- target | any_drop | any_change
  browser_run_enabled INTEGER NOT NULL DEFAULT 0, -- 0 = spento (risparmia ore), 1 = acceso
  check_interval_minutes INTEGER, -- NULL = usa il default del piano
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  current_price REAL,
  target_price REAL,
  last_checked_at INTEGER,
  last_check_error TEXT,
  pending_variants TEXT, -- JSON array di prezzi candidati quando la pagina è ambigua (varianti multiple)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS price_history (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price REAL NOT NULL,
  date INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT,
  product_id TEXT,
  product_title TEXT,
  result TEXT NOT NULL, -- ok | changed | error
  message TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_history_product ON price_history(product_id, date);
CREATE INDEX IF NOT EXISTS idx_products_due_check ON products(last_checked_at);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_exec_log_ts ON execution_log(ts DESC);
