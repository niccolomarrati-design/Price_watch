-- schema.sql — struttura del database D1 per Price Watch

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free', -- free | pro | max | god
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
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS price_history (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price REAL NOT NULL,
  date INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_history_product ON price_history(product_id, date);
CREATE INDEX IF NOT EXISTS idx_products_due_check ON products(last_checked_at);
