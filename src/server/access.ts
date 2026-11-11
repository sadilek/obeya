// Who may talk to the server: every request and WebSocket upgrade, from this machine too, names one
// of Obeya's own hosts and comes from no other site. A page elsewhere in the owner's browser may
// send requests to 127.0.0.1 (a `text/plain` POST needs no preflight) and a DNS name rebound to it
// reaches the server under that name; neither gets an answer. Then the gate has its say (remote.ts):
// on this machine the owner's key (owner.ts), from another device a paired one.

import { timingSafeEqual } from 'node:crypto';

/** The names this machine reaches Obeya by. */
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

const PLAIN = { 'content-type': 'text/plain; charset=utf-8' };

/** The name in a `Host` header, without its port: `127.0.0.1`, `[::1]`. */
export function hostname(host: string): string {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  return name.toLowerCase();
}

/**
 * Why `req` gets no answer, as the answer it gets instead; `null` when it may have one.
 *
 * - `Host` (and `X-Forwarded-Host`, where a proxy set it) names none of `hosts`: 421 (a foreign
 *   name, a DNS name rebound to this machine). Its port is not checked: a worker on another
 *   machine reaches Obeya through a forwarded port of its own.
 * - An `Origin` other than the address the request was sent to (as `tailscale serve` forwards it:
 *   `X-Forwarded-Proto` and `-Host`), or `Sec-Fetch-Site: cross-site`: 403. A request with neither
 *   (the app's shell, scripts, curl) passes. A page elsewhere cannot set the forwarded headers
 *   without a preflight, which Obeya does not answer.
 * - A link from another site opening one of Obeya's pages in the browser's window (a GET outside
 *   `/api/`, `Sec-Fetch-Mode: navigate` to a `document`) passes despite `cross-site`: it only shows
 *   the page, as typing the address would. Scanning the QR code on a phone often arrives this way
 *   (from the scanner app's page); in a frame of another site the page still gets nothing.
 * - `files`: a GET of one of the workers' files (an HTML artifact's page and what it loads). Its
 *   sandboxed frame has an origin of its own (`null`), so the browser marks what it loads as
 *   cross-site; what it loads is read only by that frame and changes nothing.
 */
export function refusal(req: Request, hosts: readonly string[], files = false): Response | null {
  const host = req.headers.get('host');
  const forwarded = req.headers.get('x-forwarded-host');
  if (!host || !hosts.includes(hostname(host)) || (forwarded && !hosts.includes(hostname(forwarded)))) {
    const port = host?.match(/:(\d+)$/)?.[1];
    return new Response(`Not one of Obeya's addresses. On its machine Obeya answers at http://127.0.0.1${port ? `:${port}` : ''}/\n`, { status: 421, headers: PLAIN });
  }
  if (files && (req.method === 'GET' || req.method === 'HEAD')) return null;
  const origin = req.headers.get('origin');
  const opened =
    (req.method === 'GET' || req.method === 'HEAD') &&
    req.headers.get('sec-fetch-mode') === 'navigate' &&
    req.headers.get('sec-fetch-dest') === 'document' &&
    !new URL(req.url).pathname.startsWith('/api/');
  if ((origin !== null && origin.toLowerCase() !== ownOrigin(req)) || (req.headers.get('sec-fetch-site') === 'cross-site' && !opened)) return new Response("Obeya answers its own page, not another site's.\n", { status: 403, headers: PLAIN });
  return null;
}

/** The address a request was sent to, as the browser sees it (`tailscale serve` forwards it: `X-Forwarded-Proto` and `-Host`); its host is one `refusal` has checked. */
export function ownOrigin(req: Request): string {
  const proto = req.headers.get('x-forwarded-proto');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
  return `${proto ? `${proto}:` : new URL(req.url).protocol}//${host.toLowerCase()}`;
}

/** Who may come in beyond what `refusal` checks: the owner, and other devices (remote.ts). */
export interface Gate {
  /** The names requests may come under. */
  hosts(): readonly string[];
  /** The answer a request to `route` gets instead of the route's own, or `null` to let it through. */
  admit(req: Request, server: Bun.Server<unknown>, route: string): Response | null;
}

type Routes<D, R extends string> = Bun.Serve.RoutesWithUpgrade<D, R>;
type Handler = (req: Request, server: Bun.Server<unknown>) => unknown;

/** The routes that serve the workers' files: an HTML artifact's, a looked-up answer's. */
const FILES = ['/cards/:id/demo/*', '/cards/:id/demos/:n/*', '/cards/:id/files/*', '/threads/:thread/files/*'];

/** The address of one of the workers' files with its key: the route's base (`FILES`, its `:name`s any one step) and the key. */
const KEYED_FILES = new RegExp(`^(/api/c/[^/]+(?:${FILES.map((f) => f.replace(/\/\*$/, '').replace(/:\w+/g, '[^/]+')).join('|')})/)~([0-9a-f]{32})/`);

/** Keys the addresses of the workers' files with; new at every start, so an address with an old key is sent on to the new one. */
const FILES_SECRET = crypto.getRandomValues(new Uint8Array(32));

/** The key in the address of the workers' files under `base` (`/api/c/x/cards/y/demo/`): `<base>~<key>/index.html`. */
export function filesKey(base: string): string {
  return new Bun.CryptoHasher('sha256', FILES_SECRET).update(base).digest('hex').slice(0, 32);
}

/**
 * Whether `req` asks for one of the workers' files at the address with its key (demo.ts sends a
 * request without it there). Its sandboxed frame's page has an origin of its own, and the browser
 * sends what it loads (its stylesheet, its images) as cross-site, without the owner's cookie: the
 * key, which only a request with the owner's key or a paired device's gets to see, lets it in.
 */
function keyedFiles(req: Request): boolean {
  const m = new URL(req.url).pathname.match(KEYED_FILES);
  return !!m && timingSafeEqual(Buffer.from(m[2]!), Buffer.from(filesKey(m[1]!)));
}

/**
 * `routes`, each answering only what `refusal` and then `gate` let through. An HTML page (Bun serves its bundle
 * itself, past any handler) moves to a path nobody knows, and its own path fetches it from there
 * once the request passed.
 */
export function guarded<D, R extends string>(routes: Routes<D, R>, gate: Gate): Routes<D, R> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries<unknown>(routes)) {
    const files = FILES.some((f) => path.endsWith(f));
    const checked = (handler: Handler): Handler => (req, server) =>
      refusal(req, gate.hosts(), files) ?? (files && (req.method === 'GET' || req.method === 'HEAD') && keyedFiles(req) ? null : gate.admit(req, server, path)) ?? handler(req, server);
    if (typeof value === 'function') out[path] = checked(value as Handler);
    else if (value && typeof value === 'object' && 'index' in value) {
      const hidden = `/_page/${crypto.randomUUID()}${path}`;
      out[hidden] = value;
      out[path] = checked((req, server) => {
        const etag = req.headers.get('if-none-match');
        return fetch(new URL(hidden, server.url), { headers: etag ? { 'if-none-match': etag } : {} });
      });
    } else if (value && typeof value === 'object' && Object.values(value).every((h) => typeof h === 'function')) {
      out[path] = Object.fromEntries(Object.entries(value as Record<string, Handler>).map(([method, h]) => [method, checked(h)]));
    } else throw new Error(`route ${path}: a kind of route the check does not know`);
  }
  return out as Routes<D, R>;
}
