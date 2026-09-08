# Price Watch — Capacitor

This folder is a Capacitor-ready shell around the current Price Watch PWA.

## Included

- `www/index.html` — current PWA frontend, including Liquid Glass, folders, drag/reorder, login and push UI.
- `www/sw.js` — current Web Push service worker for the web/PWA build.
- `backend/index.js` — current Cloudflare Workers + D1 backend.
- `capacitor.config.ts` — app id/name and web directory.
- `src/native-bridge.ts` — native preparation for push notifications and motion sensors.
- `native/ios/README.md` and `native/android/README.md` — platform-specific setup notes.

## Install

Use a Node.js environment with the Capacitor v8 toolchain, then:

```bash
npm install
npx cap add android
npx cap add ios
npx cap sync
```

The native platform folders are generated locally by Capacitor and should not be manually reconstructed from this zip.

## Open projects

```bash
npx cap open android
npx cap open ios
```

## Important architecture decision

The Cloudflare Worker in `backend/index.js` remains a server-side component. It is NOT bundled into the mobile application.

The mobile app contains the web frontend. Price checks, D1 data, VAPID secrets and scheduled checks continue to run on the backend.

## Push notifications

The web PWA continues using its existing Service Worker/web-push path. The Capacitor project also contains the native Push Notifications dependency and bridge so Android/iOS can move to native push registration rather than relying on browser Service Worker push inside the app shell.

The remaining native step is to connect the native registration token to the backend's device registration model and configure FCM/APNs credentials. That cannot be completed safely without the production push credentials for your app.

## Motion / Liquid Glass

The PWA's existing browser motion code remains available for web/PWA mode. The native bridge is ready to use Capacitor Motion when running as an installed Android/iOS app. iOS also requires the `NSMotionUsageDescription` entry documented in `native/ios/README.md`.

## Updating the app

Continue developing the PWA in `www/index.html`. After changes:

```bash
npx cap sync
```

Then rebuild the Android/iOS projects. Capacitor does not freeze the web source.
