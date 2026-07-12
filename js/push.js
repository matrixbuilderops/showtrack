// Web Push subscription on the client. Asks the server for its VAPID public key,
// subscribes via the browser's PushManager, and registers the subscription so
// the server can notify this device even when the app is closed.

import { local } from './db.js';

function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function api(pathName, body) {
  const base = local.get('sync:server', '').replace(/\/$/, '');
  const res = await fetch(base + pathName, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server ${res.status}`);
  return data;
}

export const push = {
  supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,

  async isSubscribed() {
    if (!push.supported()) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(reg && await reg.pushManager.getSubscription());
  },

  async enable() {
    if (!push.supported()) throw new Error('This browser/device does not support notifications');
    const token = local.get('sync:token', '');
    if (!token) throw new Error('Sign in to your server first');

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed');

    const { key } = await api('/api/vapid-public', { token });
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8(key),
    });
    await api('/api/push-subscribe', { token, subscription: sub.toJSON() });
    return true;
  },

  async disable() {
    const token = local.get('sync:token', '');
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      try { await api('/api/push-unsubscribe', { token, endpoint: sub.endpoint }); } catch {}
      await sub.unsubscribe();
    }
  },
};
