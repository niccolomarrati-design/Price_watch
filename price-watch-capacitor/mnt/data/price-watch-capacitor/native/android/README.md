# Android native notes

The Capacitor Push Notifications plugin is prepared in package.json and src/native-bridge.ts.
For Android 13+ the app must request notification permission at runtime; the native bridge does that through Capacitor.

When building a release, generate an Android App Bundle (AAB) from Android Studio/Gradle for Google Play.
