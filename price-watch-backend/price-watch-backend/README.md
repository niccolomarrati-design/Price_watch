# Price Watch — Backend Cloudflare

Worker + D1 che fa da "cervello centrale": controlla i prezzi al posto tuo (anche a estensione chiusa), tenendo conto del piano di ogni utente per decidere quanto spesso controllare.

## 0. Prerequisiti

- Un account Cloudflare gratuito: [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
- Node.js installato sul tuo computer (per usare `npm` e `wrangler`, lo strumento a riga di comando di Cloudflare)

## 1. Installa le dipendenze e fai login

Apri un terminale dentro questa cartella (`price-watch-backend`) ed esegui:

```bash
npm install
npx wrangler login
```

Si aprirà il browser per autorizzare l'accesso al tuo account Cloudflare.

## 2. Crea il database D1

```bash
npx wrangler d1 create price-watch-db
```

Il comando stampa qualcosa tipo:

```
[[d1_databases]]
binding = "DB"
database_name = "price-watch-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Copia quel `database_id`** e incollalo dentro `wrangler.toml`, sostituendo `REPLACE_WITH_YOUR_DATABASE_ID`.

## 3. Crea le tabelle nel database

```bash
npm run db:migrate:remote
```

Questo esegue `schema.sql` sul database vero (in cloud). Per testare in locale prima di pubblicare, puoi usare `npm run db:migrate:local` e `npm run dev` invece di `deploy`.

## 4. Imposta il segreto per i token di accesso

Questo è ciò che firma le sessioni di login — deve essere una stringa lunga e casuale, tienila privata:

```bash
npx wrangler secret put JWT_SECRET
```

Ti chiederà di incollare il valore: usa una stringa lunga a caso (puoi generarla con `openssl rand -hex 32` nel terminale, oppure con qualsiasi generatore di password online).

## 5. Pubblica il Worker

```bash
npm run deploy
```

Alla fine ti darà un indirizzo tipo:

```
https://price-watch-backend.tuonome.workers.dev
```

**Questo è l'indirizzo dell'API** che poi va inserito nell'estensione (nella sezione Impostazioni → Account & Sync che ti preparo).

## 6. Verifica che funzioni (facoltativo, con curl)

```bash
curl -X POST https://price-watch-backend.tuonome.workers.dev/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@esempio.it","password":"password123"}'
```

Dovresti ricevere una risposta con un `token`. Se sì, il backend funziona.

## Cosa fa da solo, senza che tu debba fare nulla

- Un **Cron Trigger** fa girare il controllo prezzi ogni 15 minuti (configurato in `wrangler.toml`), ma internamente ogni prodotto viene ricontrollato solo se è "scaduto" in base al piano del proprietario:
  - Free → 1 volta al giorno
  - Pro → ogni ora
  - Max / God → ogni 15-20 minuti
- Lo storico prezzi viene ripulito automaticamente in base agli stessi limiti già visti nell'estensione (7 giorni / 3 mesi / 3 anni / illimitato).

## Costi attesi

Con questo disegno (controlli meno frequenti per chi non paga), anche con centinaia o migliaia di utenti dovresti restare comodamente dentro il piano gratuito di Cloudflare (100.000 richieste Worker/giorno, 5 milioni di letture e 100.000 scritture D1/giorno gratis). Se un giorno lo superi, il piano a pagamento è $5/mese fisso, non "a consumo" imprevedibile.

## Sicurezza — cosa sapere prima di aprire il servizio a tante persone

- Le password sono salvate con hash **PBKDF2 + salt** (non in chiaro), ma per un servizio vero vale la pena rivedere insieme le regole di sicurezza (rate limiting sui login per evitare tentativi a raffica, verifica email, reset password) — questa versione copre le basi ma non è ancora "pronta per il pubblico" su quel fronte.
- Il CORS è aperto a `*` per semplicità in fase di sviluppo — prima di un vero lancio pubblico andrebbe ristretto ai soli domini della tua estensione/app web.
