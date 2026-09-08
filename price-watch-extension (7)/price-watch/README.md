# Price Watch — Estensione Chrome

Monitora il prezzo dei prodotti che ti interessano e ti avvisa quando scende.

## Come installarla (modalità sviluppatore)

1. Scarica ed estrai questa cartella sul tuo computer.
2. Apri Chrome e vai su `chrome://extensions`.
3. In alto a destra, attiva **"Modalità sviluppatore"**.
4. Clicca **"Carica estensione non pacchettizzata"** ("Load unpacked").
5. Seleziona la cartella `price-watch`.
6. L'icona 💰 comparirà nella barra delle estensioni (potrebbe essere nascosta dietro l'icona del puzzle — fissala con lo spillo).

## Come usarla

1. Vai su una pagina prodotto di un e-commerce (es. Amazon, Zalando, un negozio online qualsiasi).
2. Clicca sull'icona dell'estensione, poi su **"+ Aggiungi pagina corrente"**.
3. L'estensione prova a trovare il prezzo automaticamente. Se lo trova, ti chiede a che prezzo vuoi essere avvisato (opzionale).
4. Il prodotto entra nella lista monitorata. Ogni ora (in background) l'estensione ricontrolla i prezzi e ti manda una notifica se scendono.
5. Puoi forzare un controllo immediato con il pulsante ↻ in alto.

## Come funziona l'estrazione del prezzo

L'estensione cerca, in ordine:
1. Dati strutturati **JSON-LD** (`schema.org/Product`) — il metodo più affidabile, usato dalla maggior parte degli e-commerce seri.
2. Meta tag **Open Graph** (`product:price:amount`, `og:price:amount`).
3. Come fallback, elementi HTML con classi/id contenenti "price".

Non funzionerà su tutti i siti (alcuni caricano il prezzo via JavaScript in modi non standard, o hanno protezioni anti-bot), ma copre la maggioranza degli e-commerce.

## Prossimi passi consigliati (per renderla vendibile)

- **Limite freemium**: bloccare l'aggiunta oltre N prodotti nella versione gratuita (già facile da aggiungere in `popup.js`, contando `products.length`).
- **Backend + pagamento**: per una vera versione "pro" servirà un piccolo backend (es. Supabase/Firebase) che gestisce abbonamenti via Stripe, e la sync tra dispositivi.
- **Grafico storico prezzi**: hai già lo storico salvato in `product.history` — basta aggiungere un mini-grafico nel popup (es. con Chart.js).
- **Pubblicazione**: per pubblicarla sul Chrome Web Store serve un account sviluppatore Google (5$ una tantum) e superare la review (attenzione alle policy su permessi `<all_urls>` — spiega bene nel listing perché servono).
- **Gestione errori robusta**: alcuni siti bloccano il `fetch` da background per CORS/anti-bot; per quei casi si potrebbe usare un controllo "lazy" quando l'utente apre di nuovo la scheda, invece che in background.

## Struttura dei file

```
price-watch/
├── manifest.json      # configurazione dell'estensione (Manifest V3)
├── background.js       # service worker: controlli periodici + notifiche
├── popup.html/.css/.js # interfaccia che si apre cliccando l'icona
├── icons/               # icone dell'estensione
└── README.md
```
