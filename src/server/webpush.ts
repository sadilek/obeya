// Web Push without a library: the message is encrypted for the device (RFC 8291, `aes128gcm` of
// RFC 8188) and the request signed with Obeya's VAPID key (RFC 8292), all through WebCrypto. It
// travels through the browser maker's push service (Apple's, Google's, Mozilla's), which sees
// neither title nor text.

const subtle = crypto.subtle;
const enc = new TextEncoder();

export const b64u = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString('base64url');
/** Bytes on an `ArrayBuffer` of their own, as WebCrypto takes them. */
export type Bytes = Uint8Array<ArrayBuffer>;

export const fromB64u = (s: string): Bytes => new Uint8Array(Buffer.from(s, 'base64url'));

/** A browser's push subscription as it serialises it (`PushSubscription.toJSON()`). */
export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * The push services of the browsers that have Web Push: Apple's (Safari), Google's (Chrome and what
 * builds on it), Mozilla's (Firefox), Microsoft's (Edge). A subscription names one of them; Obeya
 * sends nowhere else, so a device cannot have it send requests into the network it is in.
 */
const PUSH_SERVICES = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

/** A subscription from a page, or why it is none. */
export function subscriptionOf(input: unknown): Subscription | string {
  const s = input as Partial<Subscription> | null;
  if (!s || typeof s.endpoint !== 'string' || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return 'a subscription has endpoint and keys.p256dh, keys.auth';
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return 'endpoint is no URL';
  }
  if (url.protocol !== 'https:' || url.port || !PUSH_SERVICES.some((p) => p.test(url.hostname))) return "endpoint must be a browser's push service (Apple, Google, Mozilla, Microsoft) on https";
  if (fromB64u(s.keys.p256dh).length !== 65 || fromB64u(s.keys.auth).length !== 16) return 'keys of the wrong length';
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

/** The VAPID key pair: the private key signs, the public one (65 bytes, uncompressed) the page subscribes with. */
export interface Vapid {
  privateKey: CryptoKey;
  publicKey: string;
}

export async function newVapidJwk(): Promise<JsonWebKey> {
  const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return subtle.exportKey('jwk', pair.privateKey);
}

export async function vapidOf(jwk: JsonWebKey): Promise<Vapid> {
  const privateKey = await subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(fromB64u(jwk.x!), 1);
  raw.set(fromB64u(jwk.y!), 33);
  return { privateKey, publicKey: b64u(raw) };
}

async function hkdf(salt: Bytes, ikm: Bytes | ArrayBuffer, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** The record size the header announces: one record holds the whole message. */
const RECORD = 4096;
/** The most a push may carry: every push service takes a body of 4096 bytes, its 86 bytes of header, the delimiter and the tag included. */
export const PAYLOAD_MAX = 4096 - 86 - 1 - 16;

/**
 * `payload` encrypted for the subscription's device (RFC 8291): one `aes128gcm` record behind its
 * header (salt, record size, the sender's public key). `fixed`: the salt and the sender's key pair,
 * otherwise new for every message (the RFC's example uses its own).
 */
export async function encrypt(payload: Uint8Array, sub: Subscription, fixed?: { salt: Bytes; keys: CryptoKeyPair }): Promise<Bytes> {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const auth = fromB64u(sub.keys.auth);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const keys = fixed?.keys ?? ((await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
  const ua = await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: ua }, keys.privateKey, 256);
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  if (payload.length > PAYLOAD_MAX) throw new Error('push message too long');
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // the last record ends with 2, without padding
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

/** Who to write to about Obeya's pushes, for the push services (RFC 8292 asks for a contact). */
const CONTACT = 'https://obeya.si';

/** The `Authorization` header for `endpoint`: a JWT for its push service, signed with the VAPID key, valid 12 hours. */
export async function vapidAuth(endpoint: string, vapid: Vapid, now = Date.now()): Promise<string> {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: CONTACT })));
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

/** What a push carries to the service worker. */
export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping it leads: a card in the phone view (`/c/<canvas>/card/<code>`), or „Für dich“ (`/`). */
  url: string;
  /** A later push with the same tag replaces this one in the list of notifications. */
  tag: string;
}

/** Sends a request: `fetch`, or a test's push service. */
export type Post = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: Uint8Array; redirect: 'manual' }) => Promise<{ status: number; text(): Promise<string> }>;

/** Sends `message` to the subscription's push service; its status (201: taken; 404, 410: the subscription is gone). */
export async function send(sub: Subscription, message: PushMessage, vapid: Vapid, post: Post = fetch as unknown as Post): Promise<number> {
  const body = await encrypt(enc.encode(JSON.stringify(message)), sub);
  const r = await post(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuth(sub.endpoint, vapid),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      // a day: a phone switched off for longer gets what still waits from „Für dich“
      ttl: '86400',
      urgency: 'high',
    },
    body,
    // a push service answers itself, and sends Obeya nowhere else
    redirect: 'manual',
  });
  if (r.status >= 400 && r.status !== 404 && r.status !== 410) console.warn(`Obeya: push to ${new URL(sub.endpoint).host} refused (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return r.status;
}
