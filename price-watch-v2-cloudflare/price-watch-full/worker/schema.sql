-- Price Watch — schema D1 (SQLite)
-- Applica con:  wrangler d1 execute price-watch-db --file=schema.sql

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Utenti ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY,           -- UUID
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  password_salt TEXT    NOT NULL,
  plan          TEXT    NOT NULL DEFAULT 'free', -- free | pro | max | god
  notify_mode   TEXT    NOT NULL DEFAULT 'any_drop', -- target | any_drop | any_change
  notify_all_drops INTEGER NOT NULL DEFAULT 1,
  quiet_start   TEXT,                          -- "22:00" oppure NULL
  quiet_end     TEXT,                          -- "08:00" oppure NULL
  stripe_customer_id TEXT,                     -- per futura integrazione Stripe
  created_at    INTEGER NOT NULL               -- Unix ms
);

-- ── Prodotti monitorati ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id                TEXT    PRIMARY KEY,       -- UUID
  user_id           TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url               TEXT    NOT NULL,
  title             TEXT,
  current_price     REAL,
  target_price      REAL,
  active            INTEGER NOT NULL DEFAULT 1, -- 0 = eliminato (soft delete)
  last_check_at     INTEGER,                   -- Unix ms
  last_check_error  TEXT,
  created_at        INTEGER NOT NULL           -- Unix ms
);
CREATE INDEX IF NOT EXISTS idx_products_user   ON products(user_id, active);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

-- ── Storico prezzi ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  TEXT    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price       REAL    NOT NULL,
  recorded_at INTEGER NOT NULL                -- Unix ms
);
CREATE INDEX IF NOT EXISTS idx_history_product ON price_history(product_id, recorded_at DESC);

-- ── Log di esecuzione (controlli automatici e manuali) ────────────────────────
CREATE TABLE IF NOT EXISTS execution_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,             -- Unix ms
  user_id       TEXT,
  product_id    TEXT,
  product_title TEXT,
  result        TEXT NOT NULL,               -- ok | changed | error
  message       TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_ts ON execution_log(ts DESC);
