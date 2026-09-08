-- migration_settings.sql — aggiunge le nuove impostazioni utente
-- al database già esistente. Esegui questo con:
-- npx wrangler d1 execute price-watch-db --remote --file=migration_settings.sql

ALTER TABLE users ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'any_drop';
ALTER TABLE users ADD COLUMN browser_run_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN check_interval_minutes INTEGER;
