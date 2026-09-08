-- migration_variants.sql — aggiunge il supporto per prodotti con più varianti
-- di prezzo rilevate (es. pagine Amazon con "T598 PlayStation" / "T598 Xbox"),
-- così l'utente può scegliere quale prezzo monitorare invece di far
-- indovinare al sistema (che a volte sbaglia leggendo un numero a caso).
-- Esegui con:
-- npx wrangler d1 execute price-watch-db --remote --file=migration_variants.sql

ALTER TABLE products ADD COLUMN pending_variants TEXT;
