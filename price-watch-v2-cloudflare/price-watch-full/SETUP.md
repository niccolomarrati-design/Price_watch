# Price Watch v2.0 — Setup Completo
## Cloudflare Workers + D1 + Web App

---

## Architettura

```
[Web App HTML]  ←──HTTP──→  [Cloudflare Worker]  ←──SQL──→  [D1 Database]
  (browser)                   (API + Cron)                  (SQLite serverless)
                                    ↓
                          ogni ora via Cron Trigger
                          controlla TUTTI i prodotti
                          di TUTTI gli utenti
```

**Costo:** Cloudflare Free Tier copre 100.000 richieste/giorno e cron trigger inclusi. D1 è gratuito fino a 5GB. Per un'app piccola → costo zero.

---

## Passo 1 — Installa Wrangler (CLI Cloudflare)

```bash
npm install -g wrangler
wrangler login          # apre il browser per autenticarti
```

---

## Passo 2 — Crea il database D1

```bash
# Crea il database
wrangler d1 create price-watch-db

# L'output ti dà qualcosa tipo:
# ✅ Successfully created DB 'price-watch-db'
# database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copia il `database_id` e incollalo in `worker/wrangler.toml`:
```toml
[[d1_databases]]
binding       = "DB"
database_name = "price-watch-db"
database_id   = "INCOLLA-QUI-IL-TUO-ID"
```

---

## Passo 3 — Crea le tabelle

```bash
cd worker
wrangler d1 execute price-watch-db --file=schema.sql
```

Verifica:
```bash
wrangler d1 execute price-watch-db --command="SELECT name FROM sqlite_master WHERE type='table'"
```

---

## Passo 4 — Imposta i segreti

NON mettere le chiavi in wrangler.toml. Usa i secret cifrati:

```bash
# Chiave per firmare i token di login (min 32 caratteri casuali)
wrangler secret put TOKEN_SECRET
# → digita: una-stringa-lunga-e-casuale-almeno-32-caratteri

# Chiave gestore (quella che userai nell'app)
wrangler secret put ADMIN_KEY
# → digita: Niccolò_Quantistica
```

---

## Passo 5 — Deploy del Worker

```bash
cd worker
wrangler deploy
```

Output: `https://price-watch-api.TUO-NOME.workers.dev`

Salva questo URL — ti serve nel passo successivo.

---

## Passo 6 — Configura la Web App

Apri `webapp/index.html` e cerca questa riga in cima allo script:

```js
const API = (localStorage.getItem("pw_api") || "https://price-watch-api.TUO-NOME.workers.dev")
```

Puoi:
- **Opzione A (semplice):** Sostituisci `https://price-watch-api.TUO-NOME.workers.dev` con il tuo URL reale.
- **Opzione B (flessibile):** Lascia così — l'utente (o tu in console del browser) può fare `localStorage.setItem("pw_api", "https://...")` per sovrascrivere.

---

## Passo 7 — Pubblica la Web App

La web app è un file HTML statico. Puoi pubblicarla ovunque:

### A) Cloudflare Pages (gratis, consigliato)
```bash
# Dalla root del progetto
wrangler pages deploy webapp/ --project-name price-watch-app
# URL: https://price-watch-app.pages.dev
```

### B) GitHub Pages
Carica `webapp/index.html` su un repo GitHub, abilita Pages → branch main → cartella root.

### C) Qualsiasi hosting statico
Netlify, Vercel, o anche aprire il file direttamente nel browser (funziona per test locali).

---

## Passo 8 — Test

1. Apri la web app nel browser
2. Registra un account
3. Incolla l'URL di un prodotto Amazon (o altro e-commerce)
4. Il Worker recupera il prezzo → salva in D1 → risponde all'app
5. Ogni ora il cron trigger ricontrolla tutti i prodotti automaticamente

### Test del cron in locale:
```bash
wrangler dev --test-scheduled
# poi in un'altra finestra:
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

---

## Variabili d'ambiente — riepilogo

| Nome          | Come impostarla            | Descrizione                          |
|---------------|---------------------------|--------------------------------------|
| `TOKEN_SECRET`| `wrangler secret put`     | Stringa segreta per JWT (≥32 char)   |
| `ADMIN_KEY`   | `wrangler secret put`     | Chiave gestore (es. Niccolò_Quantistica) |
| `DB`          | binding in wrangler.toml  | D1 database                          |

---

## Struttura file

```
price-watch-full/
├── worker/
│   ├── index.js        ← Cloudflare Worker (API + Cron)
│   ├── schema.sql      ← Schema D1 (crea le tabelle)
│   └── wrangler.toml   ← Configurazione deploy
└── webapp/
    └── index.html      ← Web App (single file, deploy su Pages)
```

---

## API Reference

| Metodo | Endpoint                        | Auth         | Descrizione                      |
|--------|--------------------------------|--------------|----------------------------------|
| POST   | /api/auth/register              | —            | Crea account                     |
| POST   | /api/auth/login                 | —            | Login → restituisce token        |
| GET    | /api/me                         | Bearer       | Info account + piano             |
| GET    | /api/products                   | Bearer       | Lista prodotti                   |
| POST   | /api/products                   | Bearer       | Aggiunge prodotto (fetch prezzo) |
| DELETE | /api/products/:id               | Bearer       | Rimuove prodotto                 |
| PATCH  | /api/products/:id               | Bearer       | Aggiorna target/titolo           |
| GET    | /api/products/:id/history       | Bearer       | Storico prezzi                   |
| POST   | /api/check                      | Bearer       | Forza controllo immediato        |
| POST   | /api/admin/override-plan        | X-Admin-Key  | Sovrascrive piano utente         |
| GET    | /api/admin/log                  | X-Admin-Key  | Log esecuzione                   |
| DELETE | /api/admin/log                  | X-Admin-Key  | Svuota log                       |
| GET    | /api/admin/stats                | X-Admin-Key  | Statistiche globali              |

---

## Integrazione Stripe (per pagamenti reali)

1. Crea prodotti in [dashboard.stripe.com](https://dashboard.stripe.com) con prezzi ricorrenti
2. Crea un piccolo backend endpoint per la Checkout Session (es. altro Worker o Supabase Edge Function):
```js
// POST /create-checkout-session
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: priceId, quantity: 1 }],
  success_url: 'https://tua-app.pages.dev/?plan=pro',
  cancel_url:  'https://tua-app.pages.dev/',
  metadata: { userId }  // per aggiornare il piano dopo il pagamento
});
return { url: session.url };
```
3. Configura un webhook `checkout.session.completed` → chiama `/api/admin/override-plan`
4. Nel pannello gestore dell'app, inserisci la publishable key e l'URL del Customer Portal
