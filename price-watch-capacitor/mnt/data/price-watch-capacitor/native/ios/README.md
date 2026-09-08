# iOS native notes

When the iOS platform is generated, add this privacy usage description to the app's Info.plist:

`NSMotionUsageDescription` = `Price Watch usa il sensore di movimento per muovere i riflessi Liquid Glass in base all'inclinazione del dispositivo.`

Push notifications must also be enabled for the iOS App target in Xcode (Push Notifications capability). The Capacitor Push Notifications plugin is prepared in package.json and src/native-bridge.ts.
