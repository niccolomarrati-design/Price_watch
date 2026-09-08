const addBtn = document.getElementById("addBtn");
const checkNowBtn = document.getElementById("checkNowBtn");
const statusEl = document.getElementById("status");
const listEl = document.getElementById("productList");
const emptyState = document.getElementById("emptyState");

const mainView = document.getElementById("mainView");
const upgradeView = document.getElementById("upgradeView");
const historyView = document.getElementById("historyView");
const checkoutView = document.getElementById("checkoutView");
const settingsView = document.getElementById("settingsView");
const historyList = document.getElementById("historyList");
const historyChart = document.getElementById("historyChart");
const historyTitle = document.getElementById("historyTitle");
const historyBackBtn = document.getElementById("historyBackBtn");
const planLabel = document.getElementById("planLabel");
const manageplanBtn = document.getElementById("manageplanBtn");
const backBtn = document.getElementById("backBtn");
const upgradeReason = document.getElementById("upgradeReason");
const settingsBtn = document.getElementById("settingsBtn");
const settingsBackBtn = document.getElementById("settingsBackBtn");

// Checkout demo
const checkoutBackBtn = document.getElementById("checkoutBackBtn");
const checkoutSummary = document.getElementById("checkoutSummary");
const checkoutForm = document.getElementById("checkoutForm");
const cardName = document.getElementById("cardName");
const cardNumber = document.getElementById("cardNumber");
const cardExpiry = document.getElementById("cardExpiry");
const cardCvv = document.getElementById("cardCvv");
const checkoutError = document.getElementById("checkoutError");
let pendingPlan = null;

// Impostazioni
const intervalSelect = document.getElementById("intervalSelect");
const notifToggle = document.getElementById("notifToggle");
const notifModeSelect = document.getElementById("notifModeSelect");
const quietHoursToggle = document.getElementById("quietHoursToggle");
const quietHoursRange = document.getElementById("quietHoursRange");
const quietStart = document.getElementById("quietStart");
const quietEnd = document.getElementById("quietEnd");
const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const importFile = document.getElementById("importFile");
const resetBtn = document.getElementById("resetBtn");
const adminKeyInput = document.getElementById("adminKeyInput");
const unlockAdminBtn = document.getElementById("unlockAdminBtn");
const adminKeyStatus = document.getElementById("adminKeyStatus");
const adminPanel = document.getElementById("adminPanel");
const adminPlanSelect = document.getElementById("adminPlanSelect");
const adminStatsBtn = document.getElementById("adminStatsBtn");
const adminStatsOutput = document.getElementById("adminStatsOutput");
const adminLogBtn = document.getElementById("adminLogBtn");
const adminClearLogBtn = document.getElementById("adminClearLogBtn");
const adminLogOutput = document.getElementById("adminLogOutput");
const adminCheckNowBtn = document.getElementById("adminCheckNowBtn");
const adminLockBtn = document.getElementById("adminLockBtn");

const ADMIN_KEY = "Niccolò_Quantistica";

// Limiti e vantaggi per piano. maxProducts: Infinity per il piano Max.
// historyDays: per quanti giorni si conserva lo storico prezzi di un prodotto.
const PLANS = {
  free: { label: "Free", price: 0, maxProducts: 30, historyDays: 7 },
  pro: { label: "Pro", price: 5, maxProducts: 70, historyDays: 90 },
  max: { label: "Max", price: 10, maxProducts: Infinity, historyDays: 1095 }, // 3 anni
  god: { label: "God 👑", price: null, maxProducts: Infinity, historyDays: Infinity }, // solo gestore
};

async function getPlan() {
  const { plan = "free" } = await chrome.storage.local.get("plan");
  return plan;
}

async function setPlan(plan) {
  await chrome.storage.local.set({ plan });
}

// Questa funzione viene iniettata ed eseguita nella pagina attiva.
// Deve essere autosufficiente (nessuna variabile esterna).
function extractPriceFromDOM() {
  function tryParseFloat(str) {
    if (!str) return null;
    const normalized = str.replace(/[^\d,.-]/g, "").replace(",", ".");
    const value = parseFloat(normalized);
    return isNaN(value) ? null : value;
  }

  // 0) Amazon ha una struttura molto specifica e NON usa dati strutturati
  // affidabili per il prezzo, quindi lo cerchiamo direttamente nel "buybox"
  // (il riquadro con il prezzo e il pulsante "Aggiungi al carrello"),
  // escludendo esplicitamente caroselli di prodotti correlati/accessori
  // e le rate di pagamento, che altrimenti verrebbero prese per errore.
  if (/amazon\./i.test(location.hostname)) {
    const buyboxSelectors = [
      "#corePriceDisplay_desktop_feature_div .a-price.priceToPay .a-offscreen",
      "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
      "#corePrice_feature_div .a-price .a-offscreen",
      "#apex_desktop .a-price .a-offscreen",
      "#price_inside_buybox",
      "#tp_price_block_total_price_ww .a-offscreen",
      "#newBuyBoxPrice",
    ];

    // Contenitori da escludere sempre: caroselli, "acquistati insieme",
    // prodotti sponsorizzati/correlati, rate/finanziamenti.
    const excludedContainers = [
      "#sims-consolidated-2_feature_div",
      "#similarities_feature_div",
      "#valuePick_feature_div",
      "#sponsoredProducts2_feature_div",
      "#promotions_feature_div",
      '[id*="carousel" i]',
      '[id*="sims" i]',
      '[class*="installment" i]',
      '[id*="creditCard" i]',
    ];

    const isExcluded = (el) => excludedContainers.some(sel => el.closest(sel));

    for (const sel of buyboxSelectors) {
      const el = document.querySelector(sel);
      if (el && !isExcluded(el)) {
        const parsed = tryParseFloat(el.getAttribute("content") || el.textContent);
        if (parsed !== null) return parsed;
      }
    }
  }

  // 1) Meta tag Open Graph / itemprop — di solito sincronizzati dalla
  // piattaforma e-commerce con il prezzo mostrato al cliente (IVA inclusa).
  // Li controlliamo PRIMA del JSON-LD perché su alcuni siti il JSON-LD
  // contiene per errore il prezzo senza IVA, usato per analytics interne.
  const metaSelectors = [
    'meta[property="product:price:amount"]',
    'meta[property="og:price:amount"]',
    'meta[itemprop="price"]',
  ];
  for (const sel of metaSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const parsed = tryParseFloat(el.getAttribute("content"));
      if (parsed !== null) return parsed;
    }
  }

  // 2) JSON-LD (schema.org Product/Offer) — affidabile sulla maggior parte
  // degli e-commerce diversi da Amazon, usato come secondo tentativo
  const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of ldScripts) {
    try {
      const data = JSON.parse(script.textContent);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const offers = item.offers || (item["@graph"] && item["@graph"].find(g => g.offers)?.offers);
        if (offers) {
          const price = offers.price || (Array.isArray(offers) && offers[0]?.price);
          const parsed = tryParseFloat(String(price));
          if (parsed !== null) return parsed;
        }
      }
    } catch (e) { /* ignora JSON malformato */ }
  }

  // 3) Fallback per altri siti: cerca elementi con classe/id "price",
  // escludendo caroselli/correlati, e sceglie il prezzo che compare più
  // volte (di solito il prezzo principale è ripetuto, quello di un
  // accessorio incidentale no).
  const excludedGeneric = ['[class*="carousel" i]', '[id*="carousel" i]', '[class*="related" i]', '[class*="recommend" i]', '[class*="sponsor" i]'];
  const candidates = document.querySelectorAll('[class*="price" i], [id*="price" i]');
  const counts = new Map();
  for (const el of candidates) {
    if (excludedGeneric.some(sel => el.closest(sel))) continue;
    const text = el.textContent;
    if (/[€$£]\s?\d/.test(text) || /\d\s?[€$£]/.test(text)) {
      const parsed = tryParseFloat(text);
      if (parsed !== null) counts.set(parsed, (counts.get(parsed) || 0) + 1);
    }
  }

  if (counts.size > 0) {
    // sceglie il prezzo con più occorrenze; a parità, il più alto
    // (i prezzi scontati/accessori incidentali tendono a essere più bassi)
    let best = null;
    for (const [price, count] of counts.entries()) {
      if (!best || count > best.count || (count === best.count && price > best.price)) {
        best = { price, count };
      }
    }
    return best.price;
  }

  return null;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#c33" : "#555";
}

async function updatePlanBar() {
  const plan = await getPlan();
  const products = await getProducts();
  const limit = PLANS[plan].maxProducts;
  const limitLabel = limit === Infinity ? "∞" : limit;
  planLabel.textContent = `Piano ${PLANS[plan].label} · ${products.length}/${limitLabel} prodotti`;
}

async function showUpgradeView(reasonText = "") {
  const plan = await getPlan();

  upgradeReason.textContent = reasonText;
  upgradeReason.style.display = reasonText ? "block" : "none";

  document.querySelectorAll(".plan-card").forEach((card) => {
    const cardPlan = card.dataset.plan;
    const btn = card.querySelector(".plan-btn");
    const isCurrent = cardPlan === plan;

    card.classList.toggle("current-plan", isCurrent);
    btn.classList.toggle("current", isCurrent);
    btn.textContent = isCurrent ? "Piano attuale" : (cardPlan === "free" ? "Torna a Free" : `Passa a ${PLANS[cardPlan].label}`);
    btn.disabled = isCurrent;
  });

  hideAllViews();
  upgradeView.classList.remove("hidden");
}

function hideAllViews() {
  mainView.classList.add("hidden");
  historyView.classList.add("hidden");
  upgradeView.classList.add("hidden");
  checkoutView.classList.add("hidden");
  settingsView.classList.add("hidden");
}

function showMainView() {
  hideAllViews();
  mainView.classList.remove("hidden");
}

function showCheckoutView(targetPlan) {
  pendingPlan = targetPlan;
  checkoutSummary.textContent = `Piano ${PLANS[targetPlan].label} — ${PLANS[targetPlan].price} €/mese`;
  checkoutForm.reset();
  checkoutError.textContent = "";
  hideAllViews();
  checkoutView.classList.remove("hidden");
}

async function showSettingsView() {
  const {
    checkIntervalMinutes = 60, notificationsEnabled = true, isAdmin = false,
    notifyMode = "target", quietHoursEnabled = false, quietStart: qs = "22:00", quietEnd: qe = "08:00",
  } = await chrome.storage.local.get([
    "checkIntervalMinutes", "notificationsEnabled", "isAdmin",
    "notifyMode", "quietHoursEnabled", "quietStart", "quietEnd",
  ]);

  intervalSelect.value = String(checkIntervalMinutes);
  notifToggle.checked = notificationsEnabled;
  notifModeSelect.value = notifyMode;
  quietHoursToggle.checked = quietHoursEnabled;
  quietHoursRange.classList.toggle("hidden", !quietHoursEnabled);
  quietStart.value = qs;
  quietEnd.value = qe;

  adminKeyInput.value = "";
  adminKeyStatus.textContent = "";
  adminStatsOutput.classList.add("hidden");
  adminLogOutput.classList.add("hidden");
  adminClearLogBtn.classList.add("hidden");

  if (isAdmin) {
    adminPanel.classList.remove("hidden");
    adminPlanSelect.value = await getPlan();
  } else {
    adminPanel.classList.add("hidden");
  }

  hideAllViews();
  settingsView.classList.remove("hidden");
}

function buildHistoryChart(history) {
  const sorted = [...history].sort((a, b) => a.date - b.date);
  if (sorted.length < 2) {
    return `<p style="font-size:11px;color:#888;text-align:center;padding:6px;">Non ci sono ancora abbastanza rilevazioni per un grafico (ne serve più di una).</p>`;
  }

  const prices = sorted.map(h => h.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const width = 300, height = 90, pad = 10;

  const points = sorted.map((h, i) => {
    const x = pad + (i / (sorted.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (h.price - min) / range) * (height - pad * 2);
    return { x: x.toFixed(1), y: y.toFixed(1) };
  });

  const polyline = points.map(p => `${p.x},${p.y}`).join(" ");
  const circles = points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="#2563eb" />`).join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="90" style="display:block;">
      <polyline points="${polyline}" fill="none" stroke="#2563eb" stroke-width="2" />
      ${circles}
    </svg>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:#888;padding:2px 2px 0;">
      <span>Min ${min.toFixed(2)}€</span><span>Max ${max.toFixed(2)}€</span>
    </div>
  `;
}

function showHistoryView(product) {
  historyTitle.textContent = product.title;
  historyChart.innerHTML = buildHistoryChart(product.history);
  historyList.innerHTML = "";

  // Ordina dal più recente al più vecchio
  const sorted = [...product.history].sort((a, b) => b.date - a.date);

  sorted.forEach((entry, i) => {
    const previous = sorted[i + 1]; // il precedente in ordine cronologico
    const li = document.createElement("li");
    li.className = "history-entry";

    let changeLabel = "";
    if (previous) {
      const diff = entry.price - previous.price;
      if (diff !== 0) {
        const arrow = diff < 0 ? "↓" : "↑";
        const cssClass = diff < 0 ? "price-down" : "price-up";
        changeLabel = `<span class="history-change ${cssClass}">${arrow} ${Math.abs(diff).toFixed(2)}€</span>`;
      }
    }

    const dateLabel = new Date(entry.date).toLocaleDateString("it-IT", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });

    li.innerHTML = `
      <span class="history-date">${dateLabel}</span>
      <span class="history-price">${entry.price.toFixed(2)}€ ${changeLabel}</span>
    `;
    historyList.appendChild(li);
  });

  if (sorted.length === 0) {
    historyList.innerHTML = `<li class="empty">Nessuno storico disponibile ancora.</li>`;
  }

  mainView.classList.add("hidden");
  upgradeView.classList.add("hidden");
  checkoutView.classList.add("hidden");
  settingsView.classList.add("hidden");
  historyView.classList.remove("hidden");
}

historyBackBtn.addEventListener("click", showMainView);

document.querySelectorAll(".plan-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const targetPlan = btn.closest(".plan-card").dataset.plan;

    if (targetPlan === "free") {
      await setPlan("free");
      setStatus("Sei tornato al piano Free ✓");
      await updatePlanBar();
      showMainView();
      return;
    }

    showCheckoutView(targetPlan);
  });
});

manageplanBtn.addEventListener("click", () => showUpgradeView());
backBtn.addEventListener("click", showMainView);
settingsBtn.addEventListener("click", showSettingsView);
settingsBackBtn.addEventListener("click", showMainView);
checkoutBackBtn.addEventListener("click", () => showUpgradeView());

// --- Checkout demo: validazione solo di formato, nessun dato viene salvato o inviato ---
cardNumber.addEventListener("input", () => {
  const digits = cardNumber.value.replace(/\D/g, "").slice(0, 16);
  cardNumber.value = digits.replace(/(.{4})/g, "$1 ").trim();
});
cardExpiry.addEventListener("input", () => {
  let digits = cardExpiry.value.replace(/\D/g, "").slice(0, 4);
  if (digits.length > 2) digits = digits.slice(0, 2) + "/" + digits.slice(2);
  cardExpiry.value = digits;
});

function luhnCheck(numStr) {
  let sum = 0, alt = false;
  for (let i = numStr.length - 1; i >= 0; i--) {
    let n = parseInt(numStr[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

checkoutForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  checkoutError.textContent = "";

  const digits = cardNumber.value.replace(/\D/g, "");
  const expiryMatch = cardExpiry.value.match(/^(\d{2})\/(\d{2})$/);

  if (!cardName.value.trim()) {
    checkoutError.textContent = "Inserisci il nome del titolare.";
    return;
  }
  if (digits.length < 13 || digits.length > 16 || !luhnCheck(digits)) {
    checkoutError.textContent = "Numero carta non valido (usa un numero di test tipo 4242 4242 4242 4242).";
    return;
  }
  if (!expiryMatch || Number(expiryMatch[1]) < 1 || Number(expiryMatch[1]) > 12) {
    checkoutError.textContent = "Data di scadenza non valida (formato MM/AA).";
    return;
  }
  if (!/^\d{3,4}$/.test(cardCvv.value)) {
    checkoutError.textContent = "CVV non valido.";
    return;
  }

  // Nessun dato della carta viene salvato né inviato: puliamo subito il form.
  checkoutForm.reset();

  await setPlan(pendingPlan);
  await updatePlanBar();
  setStatus(`Pagamento demo confermato — piano ${PLANS[pendingPlan].label} attivo ✓`);
  showMainView();
});

// --- Impostazioni ---
intervalSelect.addEventListener("change", async () => {
  const minutes = Number(intervalSelect.value);
  await chrome.storage.local.set({ checkIntervalMinutes: minutes });
  await chrome.runtime.sendMessage({ type: "UPDATE_INTERVAL", minutes });
  setStatus(`Frequenza controllo aggiornata: ogni ${minutes} minuti ✓`);
});

notifToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ notificationsEnabled: notifToggle.checked });
});

notifModeSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ notifyMode: notifModeSelect.value });
  setStatus("Preferenza notifiche aggiornata ✓");
});

quietHoursToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ quietHoursEnabled: quietHoursToggle.checked });
  quietHoursRange.classList.toggle("hidden", !quietHoursToggle.checked);
});

quietStart.addEventListener("change", async () => {
  await chrome.storage.local.set({ quietStart: quietStart.value });
});
quietEnd.addEventListener("change", async () => {
  await chrome.storage.local.set({ quietEnd: quietEnd.value });
});

exportBtn.addEventListener("click", async () => {
  const allData = await chrome.storage.local.get(null);
  const blob = new Blob([JSON.stringify(allData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `price-watch-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

importBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await chrome.storage.local.set(data);
    setStatus("Backup importato ✓");
    await updatePlanBar();
    render(await getProducts());
  } catch (err) {
    setStatus("File non valido, import fallito.", true);
  } finally {
    importFile.value = "";
  }
});

resetBtn.addEventListener("click", async () => {
  if (!confirm("Cancellare davvero tutti i prodotti, lo storico e le impostazioni? Non si può annullare.")) return;
  await chrome.storage.local.clear();
  setStatus("Tutti i dati sono stati cancellati.");
  await updatePlanBar();
  render([]);
  showMainView();
});

// --- Chiave gestore / pannello gestore ---
unlockAdminBtn.addEventListener("click", async () => {
  if (adminKeyInput.value === ADMIN_KEY) {
    await setPlan("god");
    await chrome.storage.local.set({ isAdmin: true });
    adminKeyStatus.textContent = "✓ Chiave valida — pannello gestore sbloccato e piano God 👑 attivato su questo dispositivo (limiti disattivati).";
    adminKeyStatus.style.color = "#16a34a";
    adminPanel.classList.remove("hidden");
    adminPlanSelect.value = "god";
    await updatePlanBar();
  } else {
    adminKeyStatus.textContent = "Chiave non valida.";
    adminKeyStatus.style.color = "#c33";
  }
});

adminPlanSelect.addEventListener("change", async () => {
  await setPlan(adminPlanSelect.value);
  await updatePlanBar();
  setStatus(`[Gestore] Piano impostato manualmente su ${PLANS[adminPlanSelect.value].label}`);
});

adminStatsBtn.addEventListener("click", async () => {
  const allData = await chrome.storage.local.get(null);
  const bytesInUse = await new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(null, resolve);
  });
  const stats = {
    versione_estensione: chrome.runtime.getManifest().version,
    piano_attivo: allData.plan || "free",
    prodotti_monitorati: (allData.products || []).length,
    byte_storage_usati: bytesInUse,
    frequenza_controllo_minuti: allData.checkIntervalMinutes || 60,
    notifiche_attive: allData.notificationsEnabled !== false,
    voci_di_log_salvate: (allData.executionLog || []).length,
    dati_completi: allData,
  };
  adminStatsOutput.textContent = JSON.stringify(stats, null, 2);
  adminStatsOutput.classList.toggle("hidden");
});

const LOG_LABELS = { ok: "✓ OK", changed: "↕ Cambiato", error: "✗ Errore" };

async function renderExecutionLog() {
  const { executionLog = [] } = await chrome.storage.local.get("executionLog");
  if (executionLog.length === 0) {
    adminLogOutput.innerHTML = `<div class="log-entry">Nessun controllo registrato ancora. Premi ↻ "Forza controllo prezzi ora" o aspetta il prossimo controllo automatico.</div>`;
    return;
  }
  // Più recenti in alto
  const sorted = [...executionLog].sort((a, b) => b.date - a.date);
  adminLogOutput.innerHTML = sorted.map(entry => {
    const time = new Date(entry.date).toLocaleString("it-IT", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    return `<div class="log-entry log-${entry.result}">
      <span class="log-time">${time}</span>
      <span class="log-badge">${LOG_LABELS[entry.result] || entry.result}</span>
      <strong>${entry.title || "?"}</strong> — ${entry.message || ""}
    </div>`;
  }).join("");
}

adminLogBtn.addEventListener("click", async () => {
  const willShow = adminLogOutput.classList.contains("hidden");
  if (willShow) await renderExecutionLog();
  adminLogOutput.classList.toggle("hidden");
  adminClearLogBtn.classList.toggle("hidden", !willShow);
});

adminClearLogBtn.addEventListener("click", async () => {
  if (!confirm("Svuotare il log di esecuzione? Non si può annullare.")) return;
  await chrome.storage.local.set({ executionLog: [] });
  await renderExecutionLog();
  setStatus("[Gestore] Log svuotato.");
});

adminCheckNowBtn.addEventListener("click", async () => {
  setStatus("[Gestore] Controllo prezzi forzato in corso…");
  await chrome.runtime.sendMessage({ type: "CHECK_NOW" });
  render(await getProducts());
  if (!adminLogOutput.classList.contains("hidden")) await renderExecutionLog();
  setStatus("[Gestore] Controllo completato ✓");
});

adminLockBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ isAdmin: false });
  adminPanel.classList.add("hidden");
  adminKeyInput.value = "";
  adminKeyStatus.textContent = "Pannello gestore bloccato.";
  adminKeyStatus.style.color = "#555";
});

async function getProducts() {
  const { products = [] } = await chrome.storage.local.get("products");
  return products;
}

async function saveProducts(products) {
  await chrome.storage.local.set({ products });
}

function formatRelativeTime(timestamp) {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "adesso";
  if (diffMin < 60) return `${diffMin} min fa`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} h fa`;
  const diffD = Math.round(diffH / 24);
  return `${diffD} g fa`;
}

function render(products) {
  listEl.innerHTML = "";
  emptyState.style.display = products.length === 0 ? "block" : "none";

  for (const p of products) {
    const li = document.createElement("li");
    li.className = "product";

    const initialPrice = p.history[0]?.price ?? p.currentPrice;
    const diff = p.currentPrice - initialPrice;
    const diffLabel = diff === 0 ? "" : ` (${diff > 0 ? "+" : ""}${diff.toFixed(2)}€ da quando lo segui)`;

    let checkStatusLabel = "";
    if (p.lastCheckError) {
      checkStatusLabel = `<div class="check-status error">⚠️ ${p.lastCheckError}</div>`;
    } else if (p.lastCheckedAt) {
      checkStatusLabel = `<div class="check-status">Ultimo controllo: ${formatRelativeTime(p.lastCheckedAt)} · ${p.history.length} rilevazion${p.history.length === 1 ? "e" : "i"}</div>`;
    } else {
      checkStatusLabel = `<div class="check-status">Non ancora controllato automaticamente — usa ↻ o aspetta il prossimo controllo.</div>`;
    }

    li.innerHTML = `
      <a class="product-title" href="${p.url}" target="_blank" title="${p.title}">${p.title}</a>
      <div class="price-row">
        <span class="current-price">${p.currentPrice.toFixed(2)}€${diffLabel}</span>
        <div class="row-actions">
          <button class="history-btn" data-id="${p.id}">📊 Storico</button>
          <button class="remove-btn" data-id="${p.id}">rimuovi</button>
        </div>
      </div>
      <div class="target-price">Target: ${p.targetPrice ? p.targetPrice.toFixed(2) + "€" : "non impostato"}</div>
      ${checkStatusLabel}
    `;

    li.querySelector(".history-btn").addEventListener("click", () => showHistoryView(p));

    li.querySelector(".remove-btn").addEventListener("click", async () => {
      const updated = (await getProducts()).filter(item => item.id !== p.id);
      await saveProducts(updated);
      render(updated);
      await updatePlanBar();
    });

    listEl.appendChild(li);
  }
}

addBtn.addEventListener("click", async () => {
  const plan = await getPlan();
  const products = await getProducts();

  if (products.length >= PLANS[plan].maxProducts) {
    showUpgradeView(
      `Hai raggiunto il limite di ${PLANS[plan].maxProducts} prodotti del piano ${PLANS[plan].label}. Passa a un piano superiore per monitorarne altri.`
    );
    return;
  }

  addBtn.disabled = true;
  setStatus("Estrazione prezzo in corso…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("http")) {
      setStatus("Apri una pagina web valida prima di aggiungerla.", true);
      return;
    }

    const [{ result: price }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPriceFromDOM,
    });

    if (price === null || price === undefined) {
      setStatus("Non sono riuscito a trovare un prezzo in questa pagina.", true);
      return;
    }

    const targetInput = prompt(
      `Prezzo trovato: ${price.toFixed(2)}€\n\nA che prezzo vuoi essere avvisato? (lascia vuoto per essere avvisato di ogni calo)`
    );
    const targetPrice = targetInput ? parseFloat(targetInput.replace(",", ".")) : null;

    const products = await getProducts();
    products.push({
      id: crypto.randomUUID(),
      url: tab.url,
      title: tab.title || tab.url,
      currentPrice: price,
      targetPrice: isNaN(targetPrice) ? null : targetPrice,
      history: [{ price, date: Date.now() }],
    });

    await saveProducts(products);
    render(products);
    await updatePlanBar();
    setStatus("Prodotto aggiunto ✓");
  } catch (err) {
    console.error(err);
    setStatus("Errore durante l'aggiunta. Riprova.", true);
  } finally {
    addBtn.disabled = false;
  }
});

checkNowBtn.addEventListener("click", async () => {
  setStatus("Controllo prezzi in corso…");
  await chrome.runtime.sendMessage({ type: "CHECK_NOW" });
  const products = await getProducts();
  render(products);
  setStatus("Controllo completato ✓");
});

// Init
getProducts().then(render);
updatePlanBar();
