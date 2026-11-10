import { describe, expect, test } from 'bun:test';
import { b64u, type Bytes, encrypt, fromB64u, newVapidJwk, send, subscriptionOf, vapidAuth, vapidOf, type Post, type Subscription } from './webpush';

const subtle = crypto.subtle;

/** A device's push keys, as a browser makes them when it subscribes. */
async function device() {
  const keys = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub: Subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: b64u(await subtle.exportKey('raw', keys.publicKey)), auth: b64u(auth) } };
  return { keys, auth, sub };
}

const hkdf = async (salt: Bytes, ikm: ArrayBuffer | Bytes, info: Bytes, bytes: number) =>
  new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8));

/** Decrypts a push message as the browser does (RFC 8291 from the receiving side). */
async function decrypt(body: Uint8Array, d: Awaited<ReturnType<typeof device>>): Promise<string> {
  const salt: Bytes = new Uint8Array(body.slice(0, 16));
  const idlen = body[20]!;
  const asPublic: Bytes = new Uint8Array(body.slice(21, 21 + idlen));
  const as = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: as }, d.keys.privateKey, 256);
  const uaPublic = fromB64u(d.sub.keys.p256dh);
  const info = new Uint8Array([...new TextEncoder().encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(d.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), new Uint8Array(body.slice(21 + idlen))));
  expect(plain.at(-1)).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe('Web Push encryption', () => {
  test('gives the body of RFC 8291’s example (section 5) for its keys and salt', async () => {
    const as = {
      d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
      pub: fromB64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
    };
    const jwk = { kty: 'EC', crv: 'P-256', d: as.d, x: b64u(as.pub.slice(1, 33)), y: b64u(as.pub.slice(33)) };
    const keys = {
      privateKey: await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
      publicKey: await subtle.importKey('raw', as.pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    };
    const sub = { endpoint: 'https://push.example/x', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
    const body = await encrypt(new TextEncoder().encode('When I grow up, I want to be a watermelon'), sub, { salt: fromB64u('DGv6ra1nlYgDCS1FRnbzlw'), keys });
    expect(b64u(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
        'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
        'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  test('a device decrypts what was sent to it, and a request carries a VAPID signature its push service can check', async () => {
    const d = await device();
    const vapid = await vapidOf(await newVapidJwk());
    let got: { url: string; headers: Record<string, string>; body: Uint8Array } | undefined;
    const post: Post = async (url, init) => {
      got = { url, headers: init.headers, body: init.body };
      return { status: 201, text: async () => '' };
    };
    const message = { title: 'Login', body: 'Demo bereit', url: '/?card=c1', tag: 'c1', at: 1_000 };
    expect(await send(d.sub, message, vapid, post)).toBe(201);
    expect(got!.url).toBe(d.sub.endpoint);
    expect(got!.headers['content-encoding']).toBe('aes128gcm');
    expect(JSON.parse(await decrypt(got!.body, d))).toEqual(message);

    // the JWT: for the push service's origin, signed with the key the page subscribed with
    const m = got!.headers.authorization!.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
    expect(m[4]).toBe(vapid.publicKey);
    const claims = JSON.parse(Buffer.from(m[2]!, 'base64url').toString());
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claims.sub).toStartWith('https://');
    const pub = await subtle.importKey('raw', fromB64u(m[4]!), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64u(m[3]!), new TextEncoder().encode(`${m[1]}.${m[2]}`))).toBe(true);
  });

  test('every message has a key and salt of its own', async () => {
    const d = await device();
    const one = await encrypt(new TextEncoder().encode('x'), d.sub);
    const two = await encrypt(new TextEncoder().encode('x'), d.sub);
    expect(b64u(one.slice(0, 86))).not.toBe(b64u(two.slice(0, 86)));
  });

  test('vapidAuth expires in 12 hours', async () => {
    const vapid = await vapidOf(await newVapidJwk());
    const t = (await vapidAuth('https://web.push.apple.com/abc', vapid, 1_000_000)).match(/t=[^.]+\.([^.]+)\./)![1]!;
    expect(JSON.parse(Buffer.from(t, 'base64url').toString())).toMatchObject({ aud: 'https://web.push.apple.com', exp: 1000 + 12 * 3600 });
  });

  test('a subscription goes to a browser maker’s push service on https, nowhere else', async () => {
    const { sub } = await device();
    expect(subscriptionOf(sub)).toEqual(sub);
    expect(subscriptionOf({ ...sub, endpoint: 'https://web.push.apple.com/QGx' })).toEqual({ ...sub, endpoint: 'https://web.push.apple.com/QGx' });
    expect(subscriptionOf({ ...sub, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x' })).not.toBeString();
    expect(subscriptionOf({ ...sub, endpoint: 'https://wns2-par02p.notify.windows.com/w/?token=x' })).not.toBeString();
    expect(subscriptionOf({ ...sub, endpoint: 'http://fcm.googleapis.com/x' })).toBeString();
    expect(subscriptionOf({ ...sub, endpoint: 'https://fcm.googleapis.com:8443/x' })).toBeString();
    expect(subscriptionOf({ ...sub, endpoint: 'https://fcm.googleapis.com.evil.example/x' })).toBeString();
    expect(subscriptionOf({ ...sub, endpoint: 'https://169.254.169.254/latest' })).toBeString();
    expect(subscriptionOf({ ...sub, endpoint: 'https://push.internal.example/x' })).toBeString();
    expect(subscriptionOf({ ...sub, endpoint: 'https://127.0.0.1:4417/api/stop' })).toBeString();
    expect(subscriptionOf({ ...sub, endpoint: 'https://192.168.1.5/x' })).toBeString();
    expect(subscriptionOf({ ...sub, keys: { ...sub.keys, auth: 'abc' } })).toBeString();
    expect(subscriptionOf(null)).toBeString();
  });
});
