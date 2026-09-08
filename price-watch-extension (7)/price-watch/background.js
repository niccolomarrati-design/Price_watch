// background.js — gira in background e controlla periodicamente i prezzi salvati

const ALARM_NAME = "price-watch-check";
const DEFAULT_CHECK_PERIOD_MINUTES = 60;

// Deve corrispondere ai limiti definiti in popup.js
const HISTORY_DAYS_BY_PLAN = {
  free: 7,
  pro: 90,
  max: 1095, // 3 anni
  god: Infinity, // il piano riservato al gestore non ha mai scadenza
};

const MAX_LOG_ENTRIES = 200;

// Aggiunge una voce al log di esecuzione visibile nel pannello gestore.
// Tiene solo le ultime MAX_LOG_ENTRIES per non far crescere lo storage
// all'infinito.
async function appendLog(entry) {
  const { executionLog = [] } = await chrome.storage.local.get("executionLog");
  executionLog.push({ date: Date.now(), ...entry });
  const trimmed = executionLog.length > MAX_LOG_ENTRIES
    ? executionLog.slice(executionLog.length - MAX_LOG_ENTRIES)
    : executionLog;
  await chrome.storage.local.set({ executionLog: trimmed });
}

// Rimuove le voci di storico più vecchie del limite consentito dal piano attivo.
// Mantiene sempre almeno l'ultima voce, anche se "scaduta", così il prezzo
// attuale non va mai perso.
function pruneHistory(history, plan) {
  const days = HISTORY_DAYS_BY_PLAN[plan] ?? HISTORY_DAYS_BY_PLAN.free;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const kept = history.filter(entry => entry.date >= cutoff);
  return kept.length > 0 ? kept : history.slice(-1);
}

chrome.runtime.onInstalled.addListener(async () => {
  const { checkIntervalMinutes = DEFAULT_CHECK_PERIOD_MINUTES } = await chrome.storage.local.get("checkIntervalMinutes");
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: checkIntervalMinutes });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkAllProducts();
  }
});

// Estrae il prezzo da una stringa HTML grezza. L'ordine di priorità è
// importante: i meta tag standard (Open Graph / itemprop) riflettono quasi
// sempre il prezzo mostrato al cliente, mentre altri campi "price" nella
// pagina (script di analytics, dati interni del negozio) possono contenere
// il prezzo senza IVA o espresso in centesimi — usarli per primi causa
// letture sbagliate.
function extractPriceFromHTML(html, url, previousPrice = null) {
  // Amazon: il prezzo del buybox è dentro span.a-offscreen, all'interno
  // del blocco #corePrice_feature_div / #corePriceDisplay_desktop_feature_div.
  if (url && /amazon\./i.test(url)) {
    const coreBlockMatch = html.match(/id="corePriceDisplay_desktop_feature_div"[\s\S]{0,3000}?<\/div>/);
    const searchArea = coreBlockMatch ? coreBlockMatch[0] : html;
    const amazonMatch = searchArea.match(/class="a-offscreen">\s*([\d.,]+)\s*€/);
    if (amazonMatch) {
      const value = parseFloat(amazonMatch[1].replace(/\./g, "").replace(",", "."));
      if (!isNaN(value)) return value;
    }
  }

  // Legge il valore di un attributo di un tag <meta>, indipendentemente
  // dall'ordine in cui compaiono gli attributi nel tag.
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
      if (!isNaN(value)) return value;
    }
  }

  // JSON-LD (schema.org/Product), analizzato come JSON vero e proprio e
  // non con una regex generica sull'intera pagina, per evitare di prendere
  // per errore campi "price" che appartengono ad altri script (es. analytics).
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const offers = item.offers || (item["@graph"] && item["@graph"].find(g => g.offers)?.offers);
        if (offers) {
          const price = offers.price || (Array.isArray(offers) && offers[0]?.price);
          const value = parseFloat(String(price).replace(",", "."));
          if (!isNaN(value)) return value;
        }
      }
    } catch { /* JSON malformato, ignora */ }
  }

  // Fallback: cerca importi in formato "123,45 €" / "€123,45" nel testo
  // grezzo e sceglie quello più frequente (il prezzo vero tende a ripetersi
  // più di un accessorio o prodotto correlato citato una sola volta).
  const priceRegex = /(\d{1,3}(?:\.\d{3})*,\d{2})\s?€|€\s?(\d{1,3}(?:\.\d{3})*,\d{2})/g;
  const counts = new Map();
  for (const m of html.matchAll(priceRegex)) {
    const raw = m[1] || m[2];
    const value = parseFloat(raw.replace(/\./g, "").replace(",", "."));
    if (!isNaN(value)) counts.set(value, (counts.get(value) || 0) + 1);
  }
  if (counts.size > 0) {
    let best = null;
    for (const [price, count] of counts.entries()) {
      if (!best || count > best.count) best = { price, count };
    }
    return best.price;
  }

  return null;
}

// Alcuni siti espongono nel loro codice il prezzo in centesimi (es. 59900
// invece di 599.00) in punti diversi dalla pagina rispetto a dove prendiamo
// normalmente il prezzo. Se il valore letto è enormemente più alto del
// prezzo già salvato ed è un numero "tondo" compatibile con i centesimi,
// lo correggiamo dividendo per 100 invece di salvare un dato palesemente
// sbagliato.
function sanityCheckPrice(newPrice, previousPrice) {
  if (previousPrice && newPrice > previousPrice * 50 && Number.isInteger(newPrice) && newPrice % 1 === 0) {
    const corrected = newPrice / 100;
    if (Math.abs(corrected - previousPrice) / previousPrice < 0.5) return corrected;
  }
  return newPrice;
}

// Controlla se l'orario attuale rientra nella fascia "silenziosa" impostata
// dall'utente (es. 22:00–08:00, gestisce anche l'attraversamento mezzanotte).
function isWithinQuietHours(quietStart, quietEnd) {
  if (!quietStart || !quietEnd) return false;
  const now = new Date();
  const [startH, startM] = quietStart.split(":").map(Number);
  const [endH, endM] = quietEnd.split(":").map(Number);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // fascia che attraversa la mezzanotte, es. 22:00 -> 08:00
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

async function checkAllProducts() {
  const {
    products = [], plan = "free", notificationsEnabled = true,
    notifyMode = "target", quietHoursEnabled = false, quietStart = "22:00", quietEnd = "08:00",
  } = await chrome.storage.local.get([
    "products", "plan", "notificationsEnabled", "notifyMode", "quietHoursEnabled", "quietStart", "quietEnd",
  ]);
  if (products.length === 0) return;

  const inQuietHours = quietHoursEnabled && isWithinQuietHours(quietStart, quietEnd);
  let updated = false;

  for (const product of products) {
    try {
      const res = await fetch(product.url, { credentials: "omit" });
      product.lastCheckedAt = Date.now();

      if (!res.ok) {
        product.lastCheckError = `Il sito ha risposto con errore ${res.status}.`;
        updated = true;
        await appendLog({ title: product.title, result: "error", message: `Errore HTTP ${res.status}` });
        continue;
      }

      const html = await res.text();
      let newPrice = extractPriceFromHTML(html, product.url);
      if (newPrice !== null) {
        newPrice = sanityCheckPrice(newPrice, product.currentPrice);
      }

      if (newPrice === null) {
        // Non siamo riusciti a leggere il prezzo in questo controllo (il
        // sito potrebbe aver cambiato struttura o bloccato la richiesta
        // automatica). Non scriviamo un dato falso nello storico, ma
        // segnaliamo il problema così non resta un mistero silenzioso.
        product.lastCheckError = "Non sono riuscito a leggere il prezzo in questo controllo.";
        updated = true;
        await appendLog({ title: product.title, result: "error", message: "Prezzo non trovato nella pagina" });
        continue;
      }

      product.lastCheckError = null;
      const dropped = newPrice < product.currentPrice;
      const changed = newPrice !== product.currentPrice;
      const oldPrice = product.currentPrice;

      // Registriamo SEMPRE una rilevazione ad ogni controllo riuscito, non
      // solo quando il prezzo cambia: altrimenti lo storico resta fermo a
      // una sola voce (quella iniziale) finché il prezzo non si muove
      // davvero, e il grafico non ha mai abbastanza punti da disegnare.
      product.history.push({ price: newPrice, date: Date.now() });
      product.currentPrice = newPrice;
      updated = true;

      await appendLog({
        title: product.title,
        result: changed ? "changed" : "ok",
        message: changed ? `Prezzo aggiornato: ${oldPrice.toFixed(2)}€ → ${newPrice.toFixed(2)}€` : `Nessuna variazione (${newPrice.toFixed(2)}€)`,
      });

      // Decide se notificare in base alla preferenza scelta dall'utente:
      // solo sotto target, ogni calo, oppure ogni variazione (anche aumenti).
      const shouldNotifyForThisChange =
        changed &&
        (
          (notifyMode === "target" && dropped && newPrice <= (product.targetPrice ?? Infinity)) ||
          (notifyMode === "any_drop" && dropped) ||
          (notifyMode === "any_change")
        );

      if (notificationsEnabled && !inQuietHours && shouldNotifyForThisChange) {
        const isDrop = dropped;
        chrome.notifications.create(`price-change-${product.id}-${Date.now()}`, {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: isDrop ? "Prezzo sceso! 🎉" : "Il prezzo è cambiato",
          message: `${product.title}: ${newPrice.toFixed(2)}€${isDrop && product.targetPrice ? ` (target: ${product.targetPrice}€)` : ""}`,
          priority: isDrop ? 2 : 1,
        });
      }

      // Applica sempre la pulizia dello storico in base al piano attivo.
      const prunedHistory = pruneHistory(product.history, plan);
      if (prunedHistory.length !== product.history.length) {
        product.history = prunedHistory;
      }
    } catch (err) {
      product.lastCheckedAt = Date.now();
      product.lastCheckError = "Errore di rete durante il controllo (il sito potrebbe bloccare le richieste automatiche).";
      updated = true;
      await appendLog({ title: product.title, result: "error", message: String(err && err.message || err) });
      console.error("Price Watch: errore nel controllare", product.url, err);
    }
  }

  if (updated) {
    await chrome.storage.local.set({ products });
  }
}

// Permette di forzare un controllo immediato dal popup, e di aggiornare
// la frequenza di controllo automatico dalle impostazioni.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHECK_NOW") {
    checkAllProducts().then(() => sendResponse({ done: true }));
    return true; // risposta asincrona
  }
  if (message.type === "UPDATE_INTERVAL") {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: message.minutes });
    sendResponse({ done: true });
    return true;
  }
});
