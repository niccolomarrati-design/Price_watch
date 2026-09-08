// src/index.js — Price Watch backend su Cloudflare Workers + D1
//
// Endpoint disponibili:
//   POST /auth/register   { email, password }        -> { token, plan }
//   POST /auth/login      { email, password }        -> { token, plan }
//   GET  /me                                          -> { email, plan }
//   GET  /products                                    -> [ { id, url, title, currentPrice, ... } ]
//   POST /products        { url, title, currentPrice, targetPrice? }
//   PATCH /products/:id   { targetPrice }
//   DELETE /products/:id
//   GET  /products/:id/history                        -> [ { price, date } ]
//   POST /products/:id/check-now                       -> ricontrolla subito UN prodotto
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
function extractPriceFromHTML(html, url) {
  if (url && /amazon\./i.test(url)) {
    const coreBlockMatch = html.match(/id="corePriceDisplay_desktop_feature_div"[\s\S]{0,3000}?<\/div>/);
    const searchArea = coreBlockMatch ? coreBlockMatch[0] : html;
    const amazonMatch = searchArea.match(/class="a-offscreen">\s*([\d.,]+)\s*€/);
    if (amazonMatch) {
      const value = parseFloat(amazonMatch[1].replace(/\./g, "").replace(",", "."));
      if (!isNaN(value)) return value;
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
      if (!isNaN(value)) return value;
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
            if (!isNaN(value)) return value;
          }
        }
        // Alcuni siti mettono il prezzo direttamente sul Product, senza "offers"
        if (item.price !== undefined) {
          const value = parseFloat(String(item.price).replace(",", "."));
          if (!isNaN(value)) return value;
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
    if (!isNaN(value)) return value;
  }

  // Fallback generico: cerca importi vicino al simbolo €, accettando sia il
  // formato italiano (1.234,56€) sia quello internazionale (1,234.56€ /
  // €199.99), con o senza spazio normale/non-interrompibile in mezzo.
  const priceRegex = /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s?€|€\s?(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/g;
  const counts = new Map();
  for (const m of html.matchAll(priceRegex)) {
    const raw = (m[1] || m[2]).replace(/\u00A0/g, " ");
    // L'ultimo separatore prima delle ultime 2 cifre è il decimale;
    // tutti gli altri (se presenti) sono separatori delle migliaia.
    const normalized = raw.replace(/[.,](?=\d{3}(?:[.,]|$))/g, "").replace(/[.,](\d{2})$/, ".$1");
    const value = parseFloat(normalized);
    if (!isNaN(value)) counts.set(value, (counts.get(value) || 0) + 1);
  }
  if (counts.size > 0) {
    let best = null;
    for (const [price, count] of counts.entries()) {
      if (!best || count > best.count) best = { price, count };
    }
    return best.price;
  }

  // Ultimo tentativo: prezzi interi senza centesimi (es. "€1.299" o "1299 €"),
  // frequenti su alcuni siti italiani per articoli dal prezzo tondo.
  const wholeRegex = /€\s?(\d{1,3}(?:\.\d{3})+|\d{3,5})(?!\d)|(\d{1,3}(?:\.\d{3})+|\d{3,5})\s?€/g;
  const wholeCounts = new Map();
  for (const m of html.matchAll(wholeRegex)) {
    const raw = m[1] || m[2];
    const value = parseFloat(raw.replace(/\./g, ""));
    if (!isNaN(value) && value > 0) wholeCounts.set(value, (wholeCounts.get(value) || 0) + 1);
  }
  if (wholeCounts.size > 0) {
    let best = null;
    for (const [price, count] of wholeCounts.entries()) {
      if (!best || count > best.count) best = { price, count };
    }
    return best.price;
  }

  return null;
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
async function fetchViaBrowserRun(env, url) {
  if (!env.MYBROWSER) return { price: null, title: null, reason: "not_configured" };
  let browser = null;
  try {
    const puppeteer = (await import("@cloudflare/puppeteer")).default;
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
    const html = await page.content();
    const title = await page.title();
    const price = extractPriceFromHTML(html, url);
    return { price, title: title || null };
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
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
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

    // 1) Tentativo con fetch semplice (veloce, gratis, illimitato)
    try {
      const res = await fetch(product.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; PriceWatchBot/1.0)" },
      });
      if (res.ok) {
        const html = await res.text();
        newPrice = extractPriceFromHTML(html, product.url);
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
      } else if (viaBrowser.reason === "quota_exceeded") {
        checkErrorMsg = "Ore gratuite Browser Run terminate per questo mese";
      } else {
        checkErrorMsg = httpErrorMsg || "Prezzo non trovato nella pagina (anche con Browser Run)";
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

    const oldPrice = product.current_price;
    await env.DB.prepare("UPDATE products SET current_price=?, last_checked_at=?, last_check_error=NULL WHERE id=?")
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
    const adminKey = request.headers.get("X-Admin-Key") || "";
    if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
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
    return json({ publicKey: env.VAPID_PUBLIC_KEY });
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
      let price = null, title = null, httpErrorMsg = null;
      if (res.ok) {
        const html = await res.text();
        price = extractPriceFromHTML(html, productUrl);
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
        } else {
          browserReason = viaBrowser.reason;
        }
      } else if (price === null && !user.browser_run_enabled) {
        browserReason = "browser_run_disabled";
      }

      if (price === null) {
        let errMsg = httpErrorMsg
          ? `${httpErrorMsg} (il sito blocca le richieste automatiche)`
          : "Prezzo non trovato (il sito potrebbe bloccare le richieste automatiche).";
        if (browserReason === "quota_exceeded") {
          errMsg = "Ore gratuite di Browser Run terminate per questo mese. Inserisci il prezzo a mano qui sotto.";
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
      await env.DB.prepare("UPDATE products SET target_price=? WHERE id=?")
        .bind(body.targetPrice ?? null, productId).run();
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
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    currentPrice: row.current_price,
    targetPrice: row.target_price,
    lastCheckedAt: row.last_checked_at,
    lastCheckError: row.last_check_error,
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
