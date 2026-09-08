# Price Watch architecture

Browser/PWA:
`www/index.html` + `www/sw.js`

Native shell:
Capacitor -> Android / iOS

Backend:
Cloudflare Workers + D1 (`backend/index.js`)

Data flow:
mobile app -> HTTPS API -> Cloudflare Worker -> D1
price scheduler -> product check -> push delivery

The VAPID private key and JWT secret must remain server-side and must never be copied into the mobile project.
