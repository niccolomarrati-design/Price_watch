// sw.js — Service Worker di Price Watch
// Gestisce la ricezione delle notifiche push, anche quando l'app è chiusa,
// e l'apertura dell'app quando l'utente tocca la notifica.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Arriva un messaggio push dal server (tramite sendPushToUser nel Worker)
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Price Watch", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Price Watch";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/", productId: data.productId || null },
    tag: data.productId || undefined, // sostituisce eventuali notifiche precedenti dello stesso prodotto
    renotify: !!data.productId,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// L'utente tocca la notifica → apre (o porta in primo piano) l'app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
