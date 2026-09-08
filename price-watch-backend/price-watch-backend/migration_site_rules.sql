-- migration_site_rules.sql — tabella per l'auto-apprendimento: quando
-- Gemini AI risolve un prezzo, salva un "indizio" per quel dominio così i
-- controlli futuri sullo stesso sito sono veloci e gratuiti (niente
-- chiamata AI), a meno che il sito non cambi di nuovo grafica.
-- Esegui con:
-- npx wrangler d1 execute price-watch-db --remote --file=migration_site_rules.sql

CREATE TABLE IF NOT EXISTS site_rules (
  domain TEXT PRIMARY KEY,
  anchor TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
