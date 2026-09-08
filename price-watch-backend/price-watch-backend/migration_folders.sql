-- migration_folders.sql — aggiunge il sistema di cartelle: l'utente può
-- creare cartelle e spostarci dentro i prodotti per organizzarli come vuole.
-- Esegui con:
-- npx wrangler d1 execute price-watch-db --remote --file=migration_folders.sql

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

ALTER TABLE products ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_folder ON products(folder_id);
