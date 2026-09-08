// src/index.js — Price Watch backend su Cloudflare Workers + D1
//
// Endpoint disponibili:
//   POST /auth/register   { email, password }        -> { token, plan }
//   POST /auth/login      { email, password }        -> { token, plan }
//   GET  /me                                          -> { email, plan }
//   GET  /products                                    -> [ { id, url, title, currentPrice, ... } ]
//   POST /products        { url, title, currentPrice, targetPrice? }
//   GET  /folders                                       -> lista cartelle dell'utente
//   POST /folders          { name }                     -> crea una cartella
//   PATCH /folders/:id     { name }                      -> rinomina
//   DELETE /folders/:id                                  -> elimina (i prodotti dentro tornano fuori)
//   PATCH /products/:id    { targetPrice?, title?, currentPrice?, folderId? } — aggiorna solo i campi inviati (folderId: null = fuori da ogni cartella)
//   DELETE /products/:id
//   GET  /products/:id/history                        -> [ { price, date } ]
//   POST /products/:id/check-now                       -> ricontrolla subito UN prodotto
//   POST /products/:id/resolve-variant { price }        -> sceglie quale variante di prezzo monitorare
//   POST /check-now                                    -> ricontrolla subito TUTTI i prodotti dell'utente
//   POST /push/subscribe  { subscription }             -> registra il dispositivo per le notifiche push
//   DELETE /push/subscribe { endpoint }                -> rimuove la sottoscrizione
//   POST /admin/override-plan { targetUserId?, plan }   [richiede X-Admin-Key]
//   GET  /admin/stats                                   [richiede X-Admin-Key]
//   GET  /admin/log?limit=200                           [richiede X-Admin-Key]
//   DELETE /admin/log                                   [richiede X-Admin-Key]
//
// Più uno scheduled handler (Cron Trigger, vedi wrangler.toml) che controlla
// i prodotti "scaduti" in base al piano del proprietario, e ripulisce lo
// storico più vecchio del limite del piano.

import { buildPushPayload } from "@block65/webcrypto-web-push";

const PLAN_LIMITS = {
  free: { maxProducts: 30, historyDays: 7, checkIntervalMs: 3 * 60 * 60 * 1000 },   // ogni 3 ore
  pro: { maxProducts: 70, historyDays: 90, checkIntervalMs: 60 * 60 * 1000 },        // ogni ora
  max: { maxProducts: Infinity, historyDays: 1095, checkIntervalMs: 20 * 60 * 1000 }, // ogni 20 min
  god: { maxProducts: Infinity, historyDays: 999999, checkIntervalMs: 15 * 60 * 1000 }, // ogni 15 min
};

// ---------- Utility: risposte JSON + CORS ----------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // per iniziare; si può restringere in seguito
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ---------- Utility: password hashing (PBKDF2, nessuna libreria esterna) ----------
function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function hashPassword(password, saltHex = null) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { hash: toHex(bits), salt: toHex(salt) };
}

async function verifyPassword(password, hashHex, saltHex) {
  const { hash } = await hashPassword(password, saltHex);
  return hash === hashHex;
}

// ---------- Utility: token firmato (HMAC-SHA256), niente librerie JWT esterne ----------
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function signToken(payload, secret) {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return `${base64url(data)}.${base64url(new Uint8Array(sig))}`;
}

async function verifyToken(token, secret) {
  if (!token) return null;
  const [dataB64, sigB64] = token.split(".");
  if (!dataB64 || !sigB64) return null;
  const data = base64urlToBytes(dataB64);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, base64urlToBytes(sigB64), data);
  if (!valid) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return null;
  const user = await env.DB.prepare(
    "SELECT id, email, plan, notify_mode, browser_run_enabled, check_interval_minutes FROM users WHERE id = ?"
  ).bind(payload.sub).first();
  return user || null;
}

// ---------- Estrazione prezzo (stessa logica dell'estensione, adattata) ----------
// Testo nel contesto immediato di un importo che indica "non è il prezzo
// del prodotto" — rate di finanziamento, soglie di spedizione gratuita,
// canoni di abbonamento, ecc. Comune a moltissimi e-commerce italiani
// (Mediaworld, Unieuro, Amazon...) e causa frequente di prezzi letti male.
const NON_PRICE_CONTEXT = /\brata\b|\brate\b|finanz|\btaeg\b|\btan\s|dovuto|\bcredito\b|\bcanone\b|abbonamento|al mese|spedizione gratuita sopra|sopra i \d|soglia|risparm|coupon/i;

function contextAround(html, index, radius = 45) {
  // Guardiamo solo il testo PRIMA del numero: in italiano le espressioni che
  // vogliamo escludere (rata da, sopra i, totale dovuto:...) precedono quasi
  // sempre l'importo a cui si riferiscono. Guardare anche dopo farebbe
  // scartare per errore un prezzo vero seguito da una frase sulle rate
  // riferita a un importo successivo (es. "Prezzo 49,90€ · rata da 4,99€").
  return html.slice(Math.max(0, index - radius), index);
}

// Riconosce un "prezzo al pezzo/unità" (es. "0,37 €/100 g", "1,20€/unità"),
// che per legge molti e-commerce (Amazon in primis) mostrano vicino al
// prezzo vero. A differenza di NON_PRICE_CONTEXT, qui guardiamo il testo
// SUBITO DOPO il numero: se inizia con "/" seguito da un'unità di misura,
// non è il prezzo del prodotto ma quello di riferimento per confronto.
const UNIT_PRICE_AFTER = /^\s?\/\s?(100\s?)?(g|kg|ml|cl|l|pz|pezzo|unit|capsul|lavagg|dose|foglio|confezione)/i;
function isUnitPrice(html, matchEndIndex) {
  return UNIT_PRICE_AFTER.test(html.slice(matchEndIndex, matchEndIndex + 20));
}

// Restituisce { price, candidates }. "price" è il prezzo migliore (stesso
// comportamento di sempre, per non rompere nulla). "candidates" contiene
// TUTTI i valori plausibili trovati: se ne sopravvivono 2 o più chiaramente
// diversi tra loro, la pagina probabilmente mostra più varianti dello stesso
// prodotto (es. "T598 PlayStation" vs "T598 Xbox") — in quel caso è più
// sicuro chiedere all'utente quale monitorare piuttosto che indovinare.
function extractPriceFromHTML(html, url) {
  if (url && /amazon\./i.test(url)) {
    // Priorità assoluta: la classe "priceToPay" identifica specificamente il
    // prezzo che il cliente pagherà davvero (non il prezzo di listino barrato,
    // non il badge "Risparmi X€", non le rate). Amazon la usa da anni in
    // modo stabile su tutti i mercati — stessa logica già usata con successo
    // nell'estensione Chrome originale.
    const priceToPayMatch = html.match(/priceToPay[\s\S]{0,400}?class="a-offscreen">\s*([\d.,]+)\s*€/);
    if (priceToPayMatch) {
      const value = parseFloat(priceToPayMatch[1].replace(/\./g, "").replace(",", "."));
      if (!isNaN(value)) return { price: value, candidates: [value] };
    }

    // Selettori del buybox Amazon in ordine di affidabilità (stesso approccio
    // usato con successo nell'estensione Chrome). Ci fermiamo al primo
    // blocco che esiste davvero nella pagina, evitando di cercare nell'intero
    // HTML dove potremmo incappare in rate, abbonamenti o accessori correlati.
    const buyboxBlocks = [
      /id="corePriceDisplay_desktop_feature_div"[\s\S]{0,3000}?<\/div>/,
      /id="apex_desktop"[\s\S]{0,3000}?<\/div>/,
      /id="corePrice_feature_div"[\s\S]{0,2000}?<\/div>/,
      /id="buybox"[\s\S]{0,3000}?<\/div>/,
    ];
    for (const blockPattern of buyboxBlocks) {
      const block = html.match(blockPattern);
      if (!block) continue;
      const area = block[0];
      // Dentro il blocco, salta eventuali importi di rate/abbonamento/risparmio
      // (es. "Amazon Pay a rate", "Risparmi 0,37€") e raccogli TUTTI i prezzi
      // puliti sopravvissuti, guardando il contesto sia prima che dopo (qui,
      // a differenza del fallback generico, il raggio di ricerca è più
      // stretto e il blocco è già ristretto al solo buybox, quindi il
      // rischio di scartare per errore un prezzo vero è molto più basso).
      const matches = [...area.matchAll(/class="a-offscreen">\s*([\d.,]+)\s*€/g)];
      const survivors = [];
      for (const m of matches) {
        const before = contextAround(area, m.index, 45);
        const after  = area.slice(m.index, Math.min(area.length, m.index + 60));
        if (NON_PRICE_CONTEXT.test(before) || NON_PRICE_CONTEXT.test(after)) continue;
        const value = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
        if (!isNaN(value)) survivors.push(value);
      }
      if (survivors.length > 0) {
        const distinct = [...new Set(survivors)];
        return { price: survivors[0], candidates: distinct };
      }
    }
  }

  function readMetaContent(attrName, attrValue) {
    const tagPattern = new RegExp(`<meta[^>]+${attrName}=["']${attrValue}["'][^>]*>`, "i");
    const tagMatch = html.match(tagPattern);
    if (!tagMatch) return null;
    const contentMatch = tagMatch[0].match(/content=["']([\d.,]+)["']/i);
    return contentMatch ? contentMatch[1] : null;
  }

  const metaCandidates = [
    readMetaContent("property", "product:price:amount"),
    readMetaContent("property", "og:price:amount"),
    readMetaContent("itemprop", "price"),
  ];
  for (const raw of metaCandidates) {
    if (raw) {
      const value = parseFloat(raw.replace(",", "."));
      if (!isNaN(value)) return { price: value, candidates: [value] };
    }
  }

  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const offers = item.offers || (item["@graph"] && item["@graph"].find(g => g.offers)?.offers);
        const offersList = Array.isArray(offers) ? offers : offers ? [offers] : [];
        for (const off of offersList) {
          const price = off?.price ?? off?.lowPrice ?? off?.priceSpecification?.price;
          if (price !== undefined) {
            const value = parseFloat(String(price).replace(",", "."));
            if (!isNaN(value)) return { price: value, candidates: [value] };
          }
        }
        // Alcuni siti mettono il prezzo direttamente sul Product, senza "offers"
        if (item.price !== undefined) {
          const value = parseFloat(String(item.price).replace(",", "."));
          if (!isNaN(value)) return { price: value, candidates: [value] };
        }
      }
    } catch { /* JSON malformato, ignora */ }
  }

  // Piattaforme Magento (molto diffuse in Italia/Europa: PcComponentes,
  // Direct Drive e simili spesso derivano da questo CMS) espongono il
  // prezzo "grezzo" (sempre con il punto come decimale) in questo attributo,
  // indipendentemente da come viene poi mostrato a schermo.
  const magentoMatch = html.match(/data-price-amount=["'](\d+(?:\.\d+)?)["']/i);
  if (magentoMatch) {
    const value = parseFloat(magentoMatch[1]);
    if (!isNaN(value)) return { price: value, candidates: [value] };
  }

  // Fallback generico: cerca importi vicino al simbolo €, accettando sia il
  // formato italiano (1.234,56€) sia quello internazionale (1,234.56€ /
  // €199.99), con o senza spazio normale/non-interrompibile in mezzo.
  // Scarta esplicitamente ciò che sembra una rata, un canone o una soglia
  // di spedizione, guardando il testo intorno a ogni importo trovato —
  // altrimenti su molti siti italiani (es. Mediaworld) questi numeri, più
  // ripetuti del prezzo vero, vincerebbero il conteggio per frequenza.
  const priceRegex = /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})(?!\d)\s?€|€\s?(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})(?!\d)/g;
  const counts = new Map();
  for (const m of html.matchAll(priceRegex)) {
    if (NON_PRICE_CONTEXT.test(contextAround(html, m.index))) continue;
    if (isUnitPrice(html, m.index + m[0].length)) continue;
    const raw = (m[1] || m[2]).replace(/\u00A0/g, " ");
    // L'ultimo separatore prima delle ultime 2 cifre è il decimale;
    // tutti gli altri (se presenti) sono separatori delle migliaia.
    const normalized = raw.replace(/[.,](?=\d{3}(?:[.,]|$))/g, "").replace(/[.,](\d{2})$/, ".$1");
    const value = parseFloat(normalized);
    if (!isNaN(value)) counts.set(value, (counts.get(value) || 0) + 1);
  }
  if (counts.size > 0) {
    // Tra i candidati sopravvissuti al filtro, se ce n'è più di uno spesso
    // sono "prezzo pieno" + "prezzo scontato" mostrati insieme: scegliamo il
    // più basso, che è il prezzo di vendita effettivo (mai un errore di
    // lettura più alto del reale, al massimo un prezzo ancora più conveniente
    // che comunque non farebbe scattare un falso allarme di aumento).
    let best = null;
    for (const [price, count] of counts.entries()) {
      if (!best || count > best.count || (count === best.count && price < best.price)) {
        best = { price, count };
      }
    }
    return { price: best.price, candidates: [...counts.keys()] };
  }

  // Ultimo tentativo: prezzi interi senza centesimi (es. "€1.299" o "1299 €"),
  // frequenti su alcuni siti italiani per articoli dal prezzo tondo.
  const wholeRegex = /€\s?(\d{1,3}(?:\.\d{3})+|\d{3,5})(?!\d)|(\d{1,3}(?:\.\d{3})+|\d{3,5})\s?€/g;
  const wholeCounts = new Map();
  for (const m of html.matchAll(wholeRegex)) {
    if (NON_PRICE_CONTEXT.test(contextAround(html, m.index))) continue;
    if (isUnitPrice(html, m.index + m[0].length)) continue;
    const raw = m[1] || m[2];
    const value = parseFloat(raw.replace(/\./g, ""));
    if (!isNaN(value) && value > 0) wholeCounts.set(value, (wholeCounts.get(value) || 0) + 1);
  }
  if (wholeCounts.size > 0) {
    let best = null;
    for (const [price, count] of wholeCounts.entries()) {
      if (!best || count > best.count) best = { price, count };
    }
    return { price: best.price, candidates: [...wholeCounts.keys()] };
  }

  return { price: null, candidates: [] };
}

// Decide se un insieme di candidati è "ambiguo" (probabile pagina con più
// varianti, es. modelli/colori/piattaforme diverse) invece di un singolo
// prezzo con qualche rumore di lettura. Richiede almeno 2 valori distinti
// che differiscono per più del 3% — soglia scelta per ignorare piccoli
// arrotondamenti ma cogliere vere differenze di prezzo tra varianti.
function detectAmbiguousVariants(candidates) {
  if (!candidates || candidates.length < 2) return null;
  const distinct = [...new Set(candidates)].sort((a, b) => b - a);
  if (distinct.length < 2) return null;
  const [highest, ...rest] = distinct;
  const meaningfullyDifferent = rest.some(v => Math.abs(highest - v) / highest > 0.03);
  if (!meaningfullyDifferent) return null;
  // Limitiamo a un numero ragionevole di opzioni da proporre (max 5)
  return distinct.slice(0, 5);
}

function sanityCheckPrice(newPrice, previousPrice) {
  if (previousPrice && newPrice > previousPrice * 50 && Number.isInteger(newPrice)) {
    const corrected = newPrice / 100;
    if (Math.abs(corrected - previousPrice) / previousPrice < 0.5) return corrected;
  }
  return newPrice;
}

// ---------- Fallback: Browser Run (browser headless) ----------
// Usato solo quando il fetch normale fallisce o non trova prezzo,
// tipicamente per siti con protezioni anti-bot (Amazon, Fnac, ecc.)
// Richiede il binding "MYBROWSER" configurato in wrangler.toml.
// Se il binding non è configurato, la funzione restituisce null
// senza generare errori bloccanti (fallback silenzioso).
//
// NOTA: alcuni siti (es. Fnac, PcComponentes) usano sistemi anti-bot molto
// sofisticati (Datadome, Akamai, ecc.) che riescono a riconoscere anche un
// browser headless "vero" come questo, non solo le richieste dirette senza
// browser. In quei casi nemmeno Browser Run riesce a passare: non è un bug,
// è un limite intrinseco di questi sistemi di protezione — per quei siti
// resta necessario l'inserimento manuale del prezzo.
async function fetchViaBrowserRun(env, url) {
  if (!env.MYBROWSER) return { price: null, title: null, reason: "not_configured" };
  let browser = null;
  try {
    const puppeteer = (await import("@cloudflare/puppeteer")).default;
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "it-IT,it;q=0.9,en;q=0.8" });

    const response = await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
    const statusCode = response ? response.status() : null;

    // Alcune pagine caricano il prezzo con un piccolo ritardo dopo che la
    // rete si è "calmata" (widget di prezzo asincroni) — una breve attesa
    // aggiuntiva costa pochissimo e aumenta le probabilità di successo.
    await new Promise(r => setTimeout(r, 800));

    const html = await page.content();
    const title = await page.title();
    const { price, candidates } = extractPriceFromHTML(html, url);

    if (price === null && statusCode && statusCode >= 400) {
      // Il sito ha bloccato anche il browser headless (pagina di errore o
      // di verifica anti-bot), non solo la richiesta semplice iniziale.
      return { price: null, title: null, candidates: [], reason: "blocked_by_site", error: `Il sito ha bloccato anche il browser (HTTP ${statusCode})` };
    }

    return { price, title: title || null, candidates: candidates || [] };
  } catch (err) {
    const msg = String(err && err.message || err);
    // Le ore gratuite mensili di Browser Run sono terminate, oppure il
    // limite di browser concorrenti è stato raggiunto: riconosciamo questi
    // casi per dare un messaggio chiaro invece di un errore generico.
    const isQuotaError = /quota|limit|429|too many|exceeded/i.test(msg);
    return { price: null, title: null, reason: isQuotaError ? "quota_exceeded" : "error", error: msg };
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

// ---------- Invio notifica push a tutti i dispositivi di un utente ----------
// Se l'invio a un endpoint fallisce con 404/410 (sottoscrizione scaduta o
// l'utente ha disinstallato/revocato i permessi), la rimuoviamo dal database
// così non ritentiamo inutilmente ai prossimi controlli.
async function sendPushToUser(env, userId, payload) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return; // push non configurato

  const subs = await env.DB.prepare(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?"
  ).bind(userId).all();

  for (const sub of subs.results || []) {
    try {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      const message = { data: JSON.stringify(payload) };
      const vapid = {
        subject: "mailto:admin@price-watch.app",
        publicKey: env.VAPID_PUBLIC_KEY.trim(),
        privateKey: env.VAPID_PRIVATE_KEY.trim(),
      };
      const init = await buildPushPayload(message, subscription, vapid);
      const res = await fetch(subscription.endpoint, init);
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
      }
    } catch (err) {
      // Un fallimento su un singolo dispositivo non deve bloccare gli altri
      console.error("Push fallita per sub", sub.id, String(err && err.message || err));
    }
  }
}

// ---------- Log di esecuzione (per le statistiche del pannello gestore) ----------
async function logExecution(env, { userId, productId, productTitle, result, message }) {
  try {
    await env.DB.prepare(
      "INSERT INTO execution_log (ts, user_id, product_id, product_title, result, message) VALUES (?,?,?,?,?,?)"
    ).bind(Date.now(), userId ?? null, productId ?? null, productTitle ?? null, result, message ?? null).run();
  } catch (e) {
    console.error("Errore scrittura execution_log:", e);
  }
}

// ---------- Controllo di un singolo prodotto ----------
async function checkOneProduct(env, product, browserRunEnabled = false, notifyMode = "any_drop") {
  const now = Date.now();
  try {
    let newPrice = null;
    let httpErrorMsg = null;
    let candidates = [];

    // 1) Tentativo con fetch semplice (veloce, gratis, illimitato)
    try {
      const res = await fetch(product.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; PriceWatchBot/1.0)" },
      });
      if (res.ok) {
        const html = await res.text();
        const extracted = extractPriceFromHTML(html, product.url);
        newPrice = extracted.price;
        candidates = extracted.candidates || [];
      } else {
        httpErrorMsg = `Errore HTTP ${res.status}`;
      }
    } catch (fetchErr) {
      httpErrorMsg = String(fetchErr && fetchErr.message || fetchErr);
    }
    if (newPrice !== null) newPrice = sanityCheckPrice(newPrice, product.current_price);

    // 2) Fallback: se il fetch semplice ha fallito (403/blocco anti-bot) O
    // non ha trovato il prezzo, prova con il browser headless — utile per
    // Fnac, PcComponentes, Amazon e altri siti protetti. Attivo solo se
    // l'utente lo ha acceso nelle impostazioni, per risparmiare le ore
    // gratuite mensili quando non serve.
    let checkErrorMsg = null;
    if (newPrice === null && browserRunEnabled) {
      const viaBrowser = await fetchViaBrowserRun(env, product.url);
      if (viaBrowser.price !== null) {
        newPrice = sanityCheckPrice(viaBrowser.price, product.current_price);
        candidates = viaBrowser.candidates || [];
      } else if (viaBrowser.reason === "quota_exceeded") {
        checkErrorMsg = "Ore gratuite Browser Run terminate per questo mese";
      } else if (viaBrowser.reason === "blocked_by_site") {
        checkErrorMsg = "Questo sito blocca anche il browser automatico — serve inserire il prezzo a mano";
      } else {
        checkErrorMsg = "Prezzo non trovato nella pagina, nemmeno con Browser Run";
      }
    } else if (newPrice === null && !browserRunEnabled) {
      checkErrorMsg = httpErrorMsg
        ? `${httpErrorMsg} — prova ad attivare Browser Run nelle Impostazioni`
        : "Prezzo non trovato (Browser Run è disattivato nelle impostazioni)";
    }

    if (newPrice === null) {
      const msg = checkErrorMsg || "Prezzo non trovato nella pagina";
      await env.DB.prepare("UPDATE products SET last_checked_at=?, last_check_error=? WHERE id=?")
        .bind(now, msg, product.id).run();
      await logExecution(env, { userId: product.user_id, productId: product.id, productTitle: product.title, result: "error", message: msg });
      return { ok: false, message: msg };
    }

    // Rileva se la pagina mostra più varianti di prezzo (es. modelli/colori
    // diversi). Se uno dei candidati combacia già con il prezzo attuale
    // salvato (tolleranza 3%), significa che la variante scelta dall'utente
    // è ancora lì e stabile: continuiamo normalmente senza disturbare.
    // Solo se NESSUN candidato combacia con quello attuale (o è la prima
    // rilevazione) chiediamo conferma all'utente invece di indovinare.
    const variants = detectAmbiguousVariants(candidates);
    if (variants) {
      const oldPriceForMatch = product.current_price;
      const matchesCurrent = oldPriceForMatch != null &&
        variants.some(v => Math.abs(v - oldPriceForMatch) / oldPriceForMatch <= 0.03);

      if (!matchesCurrent) {
        await env.DB.prepare("UPDATE products SET last_checked_at=?, pending_variants=? WHERE id=?")
          .bind(now, JSON.stringify(variants), product.id).run();
        await logExecution(env, {
          userId: product.user_id, productId: product.id, productTitle: product.title,
          result: "error", message: `Rilevate ${variants.length} varianti di prezzo diverse — in attesa di scelta dell'utente`,
        });
        await sendPushToUser(env, product.user_id, {
          title: `⚠️ ${product.title}`,
          body: "Questo prodotto ha più varianti di prezzo. Apri l'app per scegliere quale monitorare.",
          url: "/", // apre l'app (dove compare il banner), non il sito esterno
          productId: product.id,
        });
        return { ok: false, message: "Più varianti di prezzo rilevate, in attesa di scelta" };
      }
      // Un candidato combacia con quello già impostato → prosegue usando
      // quel valore (ignora eventuali altri candidati, non sono cambiati).
    }

    const oldPrice = product.current_price;
    await env.DB.prepare("UPDATE products SET current_price=?, last_checked_at=?, last_check_error=NULL, pending_variants=NULL WHERE id=?")
      .bind(newPrice, now, product.id).run();
    await env.DB.prepare("INSERT INTO price_history (id, product_id, price, date) VALUES (?,?,?,?)")
      .bind(crypto.randomUUID(), product.id, newPrice, now).run();

    const priceChanged = oldPrice !== null && oldPrice !== undefined && newPrice !== oldPrice;
    await logExecution(env, {
      userId: product.user_id, productId: product.id, productTitle: product.title,
      result: priceChanged ? "changed" : "ok",
      message: priceChanged ? `${Number(oldPrice).toFixed(2)}€ → ${newPrice.toFixed(2)}€` : `Prezzo confermato: ${newPrice.toFixed(2)}€`,
    });

    // Decide se inviare una notifica push, in base alla preferenza scelta
    // dall'utente e a come è cambiato il prezzo.
    if (priceChanged) {
      const dropped = newPrice < oldPrice;
      let shouldNotify = false;
      if (notifyMode === "any_change") {
        shouldNotify = true;
      } else if (notifyMode === "any_drop") {
        shouldNotify = dropped;
      } else if (notifyMode === "target") {
        shouldNotify = dropped && product.target_price != null && newPrice <= product.target_price;
      }

      if (shouldNotify) {
        const arrow = dropped ? "📉" : "📈";
        await sendPushToUser(env, product.user_id, {
          title: `${arrow} ${product.title}`,
          body: `${oldPrice.toFixed(2)}€ → ${newPrice.toFixed(2)}€`,
          url: product.url,
          productId: product.id,
        });
      }
    }

    return { ok: true, price: newPrice };
  } catch (err) {
    const msg = String(err && err.message || err);
    await env.DB.prepare("UPDATE products SET last_checked_at=?, last_check_error=? WHERE id=?")
      .bind(now, msg, product.id).run();
    await logExecution(env, { userId: product.user_id, productId: product.id, productTitle: product.title, result: "error", message: msg });
    return { ok: false, message: msg };
  }
}

// ---------- Scheduled: controlla i prodotti "scaduti" + pulizia storico ----------
async function checkDueProducts(env) {
  const now = Date.now();
  const rows = await env.DB.prepare(`
    SELECT p.*, u.plan as user_plan, u.browser_run_enabled as user_browser_enabled,
           u.notify_mode as user_notify_mode
    FROM products p
    JOIN users u ON u.id = p.user_id
    WHERE p.last_checked_at IS NULL OR (
      (? - p.last_checked_at) >= COALESCE(
        u.check_interval_minutes * 60000,
        CASE u.plan
          WHEN 'free' THEN ?
          WHEN 'pro'  THEN ?
          WHEN 'max'  THEN ?
          WHEN 'god'  THEN ?
        END
      )
    )
    LIMIT 200
  `).bind(
    now,
    PLAN_LIMITS.free.checkIntervalMs,
    PLAN_LIMITS.pro.checkIntervalMs,
    PLAN_LIMITS.max.checkIntervalMs,
    PLAN_LIMITS.god.checkIntervalMs
  ).all();

  for (const product of rows.results) {
    await checkOneProduct(env, product, !!product.user_browser_enabled, product.user_notify_mode || "any_drop");
  }

  // Pulizia storico in base al piano (equivalente di pruneHistory nell'estensione)
  for (const [plan, limits] of Object.entries(PLAN_LIMITS)) {
    const cutoff = now - limits.historyDays * 24 * 60 * 60 * 1000;
    await env.DB.prepare(`
      DELETE FROM price_history WHERE date < ? AND product_id IN (
        SELECT p.id FROM products p JOIN users u ON u.id = p.user_id WHERE u.plan = ?
      )
    `).bind(cutoff, plan).run();
  }
}

// ---------- Router ----------
async function router(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  // --- Auth ---
  if (method === "POST" && path === "/auth/register") {
    const body = await request.json().catch(() => ({}));
    const { email, password } = body;
    if (!email || !password || password.length < 6) {
      return json({ error: "Email e password (min. 6 caratteri) richiesti." }, 400);
    }
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (existing) return json({ error: "Email già registrata." }, 409);

    const { hash, salt } = await hashPassword(password);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO users (id,email,password_hash,salt,plan,created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, email, hash, salt, "free", Date.now()).run();
    const token = await signToken({ sub: id, exp: Date.now() + 90 * 24 * 60 * 60 * 1000 }, env.JWT_SECRET);
    return json({ token, plan: "free", userId: id }, 201);
  }

  if (method === "POST" && path === "/auth/login") {
    const body = await request.json().catch(() => ({}));
    const { email, password } = body;
    const user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    if (!user || !(await verifyPassword(password, user.password_hash, user.salt))) {
      return json({ error: "Email o password errati." }, 401);
    }
    const token = await signToken({ sub: user.id, exp: Date.now() + 90 * 24 * 60 * 60 * 1000 }, env.JWT_SECRET);
    return json({ token, plan: user.plan, userId: user.id });
  }

  // --- Da qui in poi serve autenticazione ---
  const user = await requireAuth(request, env);
  if (!user) return json({ error: "Non autenticato." }, 401);

  if (method === "GET" && path === "/me") {
    return json({
      userId: user.id,
      email: user.email,
      plan: user.plan,
      notifyMode: user.notify_mode,
      browserRunEnabled: !!user.browser_run_enabled,
      checkIntervalMinutes: user.check_interval_minutes, // null = usa default del piano
    });
  }

  // --- Rotte gestore: richiedono, oltre al login, l'header X-Admin-Key ---
  if (path.startsWith("/admin/")) {
    const adminKey = (request.headers.get("X-Admin-Key") || "").trim();
    if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY.trim()) {
      return json({ error: "Chiave gestore non valida." }, 403);
    }

    if (method === "POST" && path === "/admin/override-plan") {
      const body = await request.json().catch(() => ({}));
      const targetUserId = body.targetUserId || user.id;
      const plan = body.plan;
      if (!["free", "pro", "max", "god"].includes(plan)) {
        return json({ error: "Piano non valido." }, 400);
      }
      await env.DB.prepare("UPDATE users SET plan=? WHERE id=?").bind(plan, targetUserId).run();
      return json({ ok: true, plan });
    }

    if (method === "GET" && path === "/admin/stats") {
      const [{ n: usersCount }] = (await env.DB.prepare("SELECT COUNT(*) as n FROM users").all()).results;
      const [{ n: activeProducts }] = (await env.DB.prepare("SELECT COUNT(*) as n FROM products").all()).results;
      const [{ n: historyRows }] = (await env.DB.prepare("SELECT COUNT(*) as n FROM price_history").all()).results;
      const [{ n: errors }] = (await env.DB.prepare("SELECT COUNT(*) as n FROM execution_log WHERE result='error'").all()).results;
      return json({ users: usersCount, activeProducts, historyRows, errors });
    }

    if (method === "GET" && path === "/admin/log") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);
      const { results } = await env.DB.prepare(
        "SELECT ts, product_title, result, message FROM execution_log ORDER BY ts DESC LIMIT ?"
      ).bind(limit).all();
      return json(results);
    }

    if (method === "DELETE" && path === "/admin/log") {
      await env.DB.prepare("DELETE FROM execution_log").run();
      return json({ ok: true });
    }

    return json({ error: "Rotta gestore non trovata." }, 404);
  }

  // --- Aggiorna le impostazioni dell'utente ---
  if (method === "PATCH" && path === "/me") {
    const body = await request.json().catch(() => ({}));
    const fields = [];
    const values = [];

    if (body.notifyMode !== undefined) {
      if (!["target", "any_drop", "any_change"].includes(body.notifyMode)) {
        return json({ error: "notifyMode non valido." }, 400);
      }
      fields.push("notify_mode = ?");
      values.push(body.notifyMode);
    }
    if (body.browserRunEnabled !== undefined) {
      fields.push("browser_run_enabled = ?");
      values.push(body.browserRunEnabled ? 1 : 0);
    }
    if (body.checkIntervalMinutes !== undefined) {
      // null → torna al default del piano. Altrimenti valore in minuti,
      // con un minimo di 15 per evitare controlli troppo frequenti.
      const v = body.checkIntervalMinutes === null ? null : Math.max(15, parseInt(body.checkIntervalMinutes, 10));
      fields.push("check_interval_minutes = ?");
      values.push(v);
    }
    if (fields.length === 0) return json({ error: "Nessun campo da aggiornare." }, 400);

    values.push(user.id);
    await env.DB.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ ok: true });
  }

  // --- Notifiche push: chiave pubblica VAPID (serve al browser per iscriversi) ---
  if (method === "GET" && path === "/push/vapid-public-key") {
    if (!env.VAPID_PUBLIC_KEY) return json({ error: "Notifiche push non configurate sul server." }, 503);

    // Pulizia aggressiva: rimuove QUALSIASI carattere che non sia valido in
    // base64url (non solo gli spazi alle estremità come .trim(), ma anche
    // caratteri invisibili finiti per errore in mezzo alla chiave durante un
    // copia-incolla, es. spazi speciali o ritorni a capo).
    const cleanKey = env.VAPID_PUBLIC_KEY.replace(/[^A-Za-z0-9\-_]/g, "");

    // Una chiave pubblica P-256 non compressa, codificata in base64url senza
    // padding, deve essere lunga esattamente 87 caratteri (65 byte grezzi).
    // Se non lo è, il secret impostato sul server è sbagliato/corrotto:
    // meglio dirlo chiaramente ora che lasciare fallire il browser dopo.
    if (cleanKey.length !== 87) {
      return json({
        error: `La chiave VAPID sul server non è valida (lunghezza ${cleanKey.length}, attesa 87). Reimposta il secret VAPID_PUBLIC_KEY con "npx wrangler secret put VAPID_PUBLIC_KEY".`,
      }, 500);
    }

    return json({ publicKey: cleanKey });
  }

  // --- Notifiche push: registra un dispositivo ---
  if (method === "POST" && path === "/push/subscribe") {
    const body = await request.json().catch(() => ({}));
    const sub = body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return json({ error: "Sottoscrizione non valida." }, 400);
    }
    // Upsert manuale: rimuove eventuali duplicati dello stesso endpoint
    // (può capitare se il browser rigenera la sottoscrizione).
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
    await env.DB.prepare(
      "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?,?)"
    ).bind(crypto.randomUUID(), user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now()).run();
    return json({ ok: true });
  }

  // --- Notifiche push: rimuove un dispositivo (es. l'utente disattiva) ---
  if (method === "DELETE" && path === "/push/subscribe") {
    const body = await request.json().catch(() => ({}));
    if (!body.endpoint) return json({ error: "endpoint mancante." }, 400);
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
      .bind(body.endpoint, user.id).run();
    return json({ ok: true });
  }

  // --- Notifiche push: invia una notifica di prova ---
  if (method === "POST" && path === "/push/test") {
    await sendPushToUser(env, user.id, {
      title: "🔔 Price Watch",
      body: "Le notifiche funzionano correttamente!",
      url: "/",
    });
    return json({ ok: true });
  }

  // --- Preview: recupera prezzo + titolo da un URL senza salvarlo ---
  // Il fetch avviene server-side (nessuna restrizione CORS, e più
  // affidabile dei proxy pubblici usati lato client).
  if (method === "POST" && path === "/products/preview") {
    const body = await request.json().catch(() => ({}));
    const { url: productUrl } = body;
    if (!productUrl || !productUrl.startsWith("http")) {
      return json({ error: "URL non valido." }, 400);
    }
    try {
      const res = await fetch(productUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
      });
      let price = null, title = null, httpErrorMsg = null, candidates = [];
      if (res.ok) {
        const html = await res.text();
        const extracted = extractPriceFromHTML(html, productUrl);
        price = extracted.price;
        candidates = extracted.candidates || [];
        const titleMatch = html.match(/<title[^>]*>([^<]{1,150})<\/title>/i);
        title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, " ") : null;
      } else {
        httpErrorMsg = `Errore HTTP ${res.status}`;
      }

      // Fallback: se il fetch semplice non ha trovato il prezzo, prova
      // con il browser headless — SOLO se l'utente lo ha attivato nelle
      // impostazioni (per risparmiare le ore gratuite mensili quando
      // non è necessario, es. fuori dai periodi di saldi/Black Friday).
      let browserReason = null;
      if (price === null && user.browser_run_enabled) {
        const viaBrowser = await fetchViaBrowserRun(env, productUrl);
        if (viaBrowser.price !== null) {
          price = viaBrowser.price;
          title = viaBrowser.title || title;
          candidates = viaBrowser.candidates || [];
        } else {
          browserReason = viaBrowser.reason;
        }
      } else if (price === null && !user.browser_run_enabled) {
        browserReason = "browser_run_disabled";
      }

      // Pagina con più varianti di prezzo (es. modelli/piattaforme diverse):
      // invece di indovinare quale monitorare, proponiamo la scelta.
      const variants = detectAmbiguousVariants(candidates);
      if (variants) {
        return json({ price: null, title, variants });
      }

      if (price === null) {
        let errMsg = httpErrorMsg
          ? `${httpErrorMsg} (il sito blocca le richieste automatiche)`
          : "Prezzo non trovato (il sito potrebbe bloccare le richieste automatiche).";
        if (browserReason === "quota_exceeded") {
          errMsg = "Ore gratuite di Browser Run terminate per questo mese. Inserisci il prezzo a mano qui sotto.";
        } else if (browserReason === "blocked_by_site") {
          errMsg = "Questo sito blocca anche il browser automatico (protezione anti-bot avanzata). Inserisci il prezzo a mano qui sotto.";
        } else if (browserReason === "browser_run_disabled") {
          errMsg = (httpErrorMsg ? `${httpErrorMsg}. ` : "Prezzo non trovato. ") + "Puoi attivare Browser Run nelle Impostazioni per provare con siti più protetti, oppure inserisci il prezzo a mano qui sotto.";
        } else if (browserReason === "not_configured") {
          errMsg = "Prezzo non trovato. Inserisci il prezzo a mano qui sotto.";
        }
        return json({ error: errMsg, price: null, title });
      }
      return json({ price, title });
    } catch (err) {
      return json({ error: "Errore di rete: " + String(err && err.message || err), price: null, title: null });
    }
  }

  // ---------- Cartelle: creare, elencare, rinominare, eliminare ----------
  if (method === "GET" && path === "/folders") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM folders WHERE user_id=? ORDER BY created_at DESC"
    ).bind(user.id).all();
    return json(results.map(formatFolder));
  }

  if (method === "POST" && path === "/folders") {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "Il nome della cartella non può essere vuoto." }, 400);

    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO folders (id,user_id,name,created_at) VALUES (?,?,?,?)")
      .bind(id, user.id, name, now).run();
    const folder = await env.DB.prepare("SELECT * FROM folders WHERE id=?").bind(id).first();
    return json(formatFolder(folder), 201);
  }

  const folderIdMatch = path.match(/^\/folders\/([^/]+)$/);
  if (folderIdMatch) {
    const folderId = folderIdMatch[1];
    const owned = await env.DB.prepare("SELECT * FROM folders WHERE id=? AND user_id=?").bind(folderId, user.id).first();
    if (!owned) return json({ error: "Cartella non trovata." }, 404);

    if (method === "PATCH") {
      const body = await request.json().catch(() => ({}));
      const newName = String(body.name || "").trim();
      if (!newName) return json({ error: "Il nome della cartella non può essere vuoto." }, 400);
      await env.DB.prepare("UPDATE folders SET name=? WHERE id=?").bind(newName, folderId).run();
      const updated = await env.DB.prepare("SELECT * FROM folders WHERE id=?").bind(folderId).first();
      return json(formatFolder(updated));
    }
    if (method === "DELETE") {
      // I prodotti dentro non vengono cancellati: tornano semplicemente
      // fuori da ogni cartella (comportamento esplicito, non ci affidiamo
      // al solo ON DELETE SET NULL dello schema per sicurezza).
      await env.DB.prepare("UPDATE products SET folder_id=NULL WHERE folder_id=?").bind(folderId).run();
      await env.DB.prepare("DELETE FROM folders WHERE id=?").bind(folderId).run();
      return json({ deleted: true });
    }
  }

  if (method === "GET" && path === "/products") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM products WHERE user_id=? ORDER BY created_at DESC"
    ).bind(user.id).all();
    return json(results.map(formatProduct));
  }

  if (method === "POST" && path === "/products") {
    const body = await request.json().catch(() => ({}));
    const { url: productUrl, title, currentPrice, targetPrice } = body;
    if (!productUrl || !title || typeof currentPrice !== "number") {
      return json({ error: "url, title e currentPrice sono richiesti." }, 400);
    }
    const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM products WHERE user_id=?").bind(user.id).first();
    const limit = PLAN_LIMITS[user.plan]?.maxProducts ?? PLAN_LIMITS.free.maxProducts;
    if (count >= limit) {
      return json({ error: `Limite di ${limit} prodotti raggiunto per il piano ${user.plan}.` }, 403);
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO products (id,user_id,url,title,current_price,target_price,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(id, user.id, productUrl, title, currentPrice, targetPrice ?? null, now).run();
    await env.DB.prepare("INSERT INTO price_history (id, product_id, price, date) VALUES (?,?,?,?)")
      .bind(crypto.randomUUID(), id, currentPrice, now).run();

    const product = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(id).first();
    return json(formatProduct(product), 201);
  }

  const productIdMatch = path.match(/^\/products\/([^/]+)$/);
  if (productIdMatch) {
    const productId = productIdMatch[1];
    const owned = await env.DB.prepare("SELECT * FROM products WHERE id=? AND user_id=?").bind(productId, user.id).first();
    if (!owned) return json({ error: "Prodotto non trovato." }, 404);

    if (method === "PATCH") {
      const body = await request.json().catch(() => ({}));
      const fields = [];
      const values = [];

      if ("targetPrice" in body) {
        fields.push("target_price = ?");
        values.push(body.targetPrice === null || body.targetPrice === "" ? null : body.targetPrice);
      }
      if ("title" in body) {
        const newTitle = String(body.title || "").trim();
        if (!newTitle) return json({ error: "Il nome non può essere vuoto." }, 400);
        fields.push("title = ?");
        values.push(newTitle);
      }
      if ("currentPrice" in body) {
        const newPrice = parseFloat(body.currentPrice);
        if (isNaN(newPrice) || newPrice <= 0) return json({ error: "Prezzo non valido." }, 400);
        fields.push("current_price = ?");
        fields.push("last_check_error = NULL");
        values.push(newPrice);
      }
      if ("folderId" in body) {
        if (body.folderId !== null) {
          const folderOwned = await env.DB.prepare("SELECT id FROM folders WHERE id=? AND user_id=?").bind(body.folderId, user.id).first();
          if (!folderOwned) return json({ error: "Cartella non trovata." }, 404);
        }
        fields.push("folder_id = ?");
        values.push(body.folderId);
      }
      if (fields.length === 0) return json({ error: "Nessun campo da aggiornare." }, 400);

      values.push(productId);
      await env.DB.prepare(`UPDATE products SET ${fields.join(", ")} WHERE id=?`).bind(...values).run();

      // Se il prezzo è stato corretto manualmente, registriamo comunque una
      // rilevazione nello storico: altrimenti il grafico mostrerebbe un
      // prezzo "salito dal nulla" senza spiegazione al prossimo controllo.
      if ("currentPrice" in body) {
        await env.DB.prepare("INSERT INTO price_history (id, product_id, price, date) VALUES (?,?,?,?)")
          .bind(crypto.randomUUID(), productId, parseFloat(body.currentPrice), Date.now()).run();
        await logExecution(env, { userId: user.id, productId, productTitle: owned.title, result: "changed", message: `Prezzo corretto manualmente: ${parseFloat(body.currentPrice).toFixed(2)}€` });
      }

      const updated = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(productId).first();
      return json(formatProduct(updated));
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM products WHERE id=?").bind(productId).run();
      return json({ deleted: true });
    }
  }

  const historyMatch = path.match(/^\/products\/([^/]+)\/history$/);
  if (historyMatch && method === "GET") {
    const productId = historyMatch[1];
    const owned = await env.DB.prepare("SELECT id FROM products WHERE id=? AND user_id=?").bind(productId, user.id).first();
    if (!owned) return json({ error: "Prodotto non trovato." }, 404);
    const { results } = await env.DB.prepare(
      "SELECT price, date FROM price_history WHERE product_id=? ORDER BY date ASC"
    ).bind(productId).all();
    return json(results);
  }

  // Ricontrolla subito il prezzo di UN SOLO prodotto (pulsante "Aggiorna"
  // sotto ogni singolo prodotto, a differenza di /check-now che li fa tutti).
  const singleCheckMatch = path.match(/^\/products\/([^/]+)\/check-now$/);
  if (singleCheckMatch && method === "POST") {
    const productId = singleCheckMatch[1];
    const product = await env.DB.prepare("SELECT * FROM products WHERE id=? AND user_id=?").bind(productId, user.id).first();
    if (!product) return json({ error: "Prodotto non trovato." }, 404);

    const outcome = await checkOneProduct(env, product, !!user.browser_run_enabled, user.notify_mode || "any_drop");
    const updated = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(productId).first();
    return json({ ...outcome, product: formatProduct(updated) });
  }

  // L'utente sceglie quale prezzo monitorare tra le varianti rilevate
  // (es. "T598 PlayStation" 429,99€ vs "T598 Xbox" 377,97€).
  const resolveVariantMatch = path.match(/^\/products\/([^/]+)\/resolve-variant$/);
  if (resolveVariantMatch && method === "POST") {
    const productId = resolveVariantMatch[1];
    const product = await env.DB.prepare("SELECT * FROM products WHERE id=? AND user_id=?").bind(productId, user.id).first();
    if (!product) return json({ error: "Prodotto non trovato." }, 404);

    const body = await request.json().catch(() => ({}));
    const chosenPrice = parseFloat(body.price);
    if (isNaN(chosenPrice) || chosenPrice <= 0) return json({ error: "Prezzo non valido." }, 400);

    const now = Date.now();
    await env.DB.prepare("UPDATE products SET current_price=?, last_checked_at=?, last_check_error=NULL, pending_variants=NULL WHERE id=?")
      .bind(chosenPrice, now, productId).run();
    await env.DB.prepare("INSERT INTO price_history (id, product_id, price, date) VALUES (?,?,?,?)")
      .bind(crypto.randomUUID(), productId, chosenPrice, now).run();
    await logExecution(env, {
      userId: user.id, productId, productTitle: product.title,
      result: "changed", message: `Variante scelta dall'utente: ${chosenPrice.toFixed(2)}€`,
    });

    const updated = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(productId).first();
    return json(formatProduct(updated));
  }

  if (method === "POST" && path === "/check-now") {
    const { results } = await env.DB.prepare("SELECT * FROM products WHERE user_id=? LIMIT 100").bind(user.id).all();
    const outcomes = [];
    for (const product of results) {
      outcomes.push({
        id: product.id,
        ...(await checkOneProduct(env, product, !!user.browser_run_enabled, user.notify_mode || "any_drop")),
      });
    }
    return json({ checked: outcomes.length, outcomes });
  }

  return json({ error: "Non trovato." }, 404);
}

function formatProduct(row) {
  let pendingVariants = null;
  if (row.pending_variants) {
    try { pendingVariants = JSON.parse(row.pending_variants); } catch {}
  }
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    currentPrice: row.current_price,
    targetPrice: row.target_price,
    lastCheckedAt: row.last_checked_at,
    lastCheckError: row.last_check_error,
    pendingVariants,
    folderId: row.folder_id ?? null,
    createdAt: row.created_at,
  };
}

function formatFolder(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  };
}

export default {
  async fetch(request, env) {
    try {
      return await router(request, env);
    } catch (err) {
      return json({ error: "Errore interno.", detail: String(err && err.message || err) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkDueProducts(env));
  },
};
