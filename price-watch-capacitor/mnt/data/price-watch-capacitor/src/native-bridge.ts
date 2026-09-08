/**
 * Native preparation layer for Price Watch.
 *
 * The PWA continues to work unchanged in Safari/Chrome.
 * When running inside Capacitor, these helpers are available for the
 * native push-notification and motion integrations.
 */
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { Motion } from '@capacitor/motion';

export const isNativeApp = () => Capacitor.isNativePlatform();

export async function initNativePush(): Promise<void> {
  if (!isNativeApp()) return;

  const permission = await PushNotifications.checkPermissions();
  if (permission.receive !== 'granted') {
    const requested = await PushNotifications.requestPermissions();
    if (requested.receive !== 'granted') {
      throw new Error('Permesso notifiche non concesso.');
    }
  }

  await PushNotifications.register();
}

export function onNativePushToken(callback: (token: string) => void): () => void {
  if (!isNativeApp()) return () => {};
  let active = true;
  PushNotifications.addListener('registration', ({ value }) => {
    if (active) callback(value);
  });
  return () => {
    active = false;
  };
}

export function onNativePush(callback: (payload: unknown) => void): () => void {
  if (!isNativeApp()) return () => {};
  let active = true;
  PushNotifications.addListener('pushNotificationReceived', notification => {
    if (active) callback(notification);
  });
  return () => {
    active = false;
  };
}

export async function startNativeMotion(
  callback: (event: { acceleration?: unknown; rotationRate?: unknown; interval?: number }) => void,
): Promise<() => Promise<void>> {
  if (!isNativeApp()) return async () => {};

  const permission = await Motion.checkPermissions();
  if (permission.motion !== 'granted') {
    const requested = await Motion.requestPermissions();
    if (requested.motion !== 'granted') {
      throw new Error('Permesso sensore di movimento non concesso.');
    }
  }

  const listener = await Motion.addListener('accel', callback);
  return async () => {
    await listener.remove();
  };
}
