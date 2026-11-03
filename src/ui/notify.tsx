// Notifications on the phone (design: Push). On iOS a web page gets pushes only once it is on the
// home screen and opened from there: Safari's phone view says how until it runs that way. There a
// button asks for the permission (iOS asks only after a tap) and stays until it is granted or
// refused. Granted, the page subscribes with Obeya's key and hands the subscription to the server,
// at every load, so a new key or a subscription the push service renewed reaches it.

import { useEffect, useState } from 'react';
import { api, standalone } from './api';
import { failText, t } from './strings';

type State = 'none' | 'install' | 'ask' | 'on';

const ios = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

function stateNow(): State {
  // a phone's browser allows pushes only over HTTPS: on another VPN's address there are none
  if (!isSecureContext) return 'none';
  if (ios() && !standalone()) return 'install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'none';
  return Notification.permission === 'granted' ? 'on' : Notification.permission === 'default' ? 'ask' : 'none';
}

/** The service worker, which also keeps the page's shell for when the machine does not answer. */
export function registerWorker() {
  if (isSecureContext && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker', e));
}

const bytes = (b64u: string) => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const same = (a: ArrayBuffer | null, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

/** Subscribes with Obeya's key (anew where the one before was another's) and gives the server the subscription. */
async function subscribe() {
  await navigator.serviceWorker.register('/sw.js');
  // subscribing needs the worker active, not only registered
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api.push();
  const wanted = bytes(key);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !same(sub.options.applicationServerKey, wanted)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
  await api.subscribe(sub.toJSON());
}

/** The hint to put Obeya on the home screen, or the button that turns notifications on; nothing once they are. */
export function Notify() {
  const [state, setState] = useState(stateNow);
  const [failed, setFailed] = useState<string | null>(null);
  // turned on at an earlier visit: the server gets the subscription as it is now (when it answers)
  useEffect(() => {
    if (state === 'on') subscribe().catch((e) => console.warn('push subscription', e));
  }, []);
  const n = t.phone.notify;
  if (failed) return <p className="ph-notify">{n.failed(failed)}</p>;
  if (state === 'install') return <p className="ph-notify">{n.install}</p>;
  if (state !== 'ask') return null;
  return (
    <div className="ph-notify">
      <span>{n.why}</span>
      <button
        className="btn primary"
        onClick={async () => {
          // iOS asks only from a tap, and only once
          const p = await Notification.requestPermission();
          if (p === 'granted') await subscribe().then(() => setFailed(null), (e) => setFailed(failText(e, { offline: (e as Error).message })));
          setState(p === 'granted' ? 'on' : p === 'default' ? 'ask' : 'none');
        }}
      >
        {n.turnOn}
      </button>
    </div>
  );
}
