// Pushes to the owner's phone when something starts to wait for them (design: Push): a card whose
// `needsYou` turns true (a demo, a question, a proposal, a card its agent withdrew, a PR to merge, an idea's turn), a landing
// that failed, a worker that is stuck. Each paired device that turned notifications on holds one
// subscription; Obeya signs with a VAPID key of its own in its home and needs no account.
//
// Nothing goes out while the owner uses Obeya: a page at the machine that was in view and used in the
// last `DESK_MS`, or one on a paired device that is in view (a phone in their hand). The first push goes out at once; what starts waiting within `WINDOW_MS` after it
// goes out as one push at the end of that minute.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from '../core/locale';
import { MESSAGES, type Messages } from '../core/messages';
import { type Item, needsYou } from '../core/types';
import { BadRequest } from './board';
import type { Store } from './db';
import { UNUSED_MS } from './remote';
import { newVapidJwk, type Post, type PushMessage, send, subscriptionOf, type Subscription, type Vapid, vapidOf } from './webpush';

/** How long after the owner last used a page at the machine nothing is pushed. */
export const DESK_MS = 3 * 60_000;
/** How long a page on a paired device counts as in view after it last said so (every 30 s). */
export const DEVICE_MS = 45_000;
/** What starts waiting within this after a push goes out together at its end. */
export const WINDOW_MS = 60_000;
/** Obeya's VAPID key, in its home: subscriptions hold its public half, so it stays. */
const KEY_FILE = 'vapid.json';

/** What a card waits for, as a push says it. */
export type PushKind = Exclude<keyof Messages['push'], 'several'>;

/** A card that started to wait for the owner. */
export interface Waits {
  card: string;
  title: string;
  kind: PushKind;
  /** Its canvas's name, where Obeya has several. */
  canvas?: string;
  /** Whether it still waits: one the owner took care of within the minute is not pushed. */
  still: () => boolean;
}

/** What a card that needs the owner waits for; `before`: the card as it was before it did (a failed landing was landing). */
export function kindOf(i: Item, before?: Item): PushKind {
  if (before?.landing) return 'landing';
  if (i.state === 'proposal') return 'proposal';
  if (i.superseded) return 'superseded';
  if (i.state === 'inPr') return 'pr';
  if (i.idea) return 'idea';
  if (i.need === 'question') return i.question?.stuck ? 'stuck' : 'question';
  if (i.answered) return 'answered';
  return i.need === 'demo' ? 'demo' : 'review';
}

/**
 * The cards of `after` that need the owner and did not in `before` (the items by id), with what they
 * wait for; a card its agent withdrew or replaced just now, also when it waited for them already.
 */
export function startedWaiting(before: ReadonlyMap<string, Item>, after: readonly Item[]): { item: Item; kind: PushKind }[] {
  return after.flatMap((i) => {
    const was = before.get(i.id);
    if (i.superseded && was && !was.superseded && !i.snoozed) return [{ item: i, kind: 'superseded' as const }];
    return needsYou(i) && !(was && needsYou(was)) ? [{ item: i, kind: kindOf(i, was) }] : [];
  });
}

/** At most `n` characters: a push carries at most about 4 KB, and a phone shows a few lines anyway. */
const clipped = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** A title as plain text: a notification shows no markdown. */
export const plainTitle = (md: string) =>
  md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .trim();

export interface PushOptions {
  store: Store;
  /** Obeya's home, with the VAPID key; without one (a test) the key is made up in memory. */
  home?: string;
  language?: () => Language;
  now?: () => number;
  /** Sends a request to a push service: `fetch`, or a test's. */
  post?: Post;
  /** Runs `fn` after `ms`: `setTimeout`, or a test's. */
  later?: (fn: () => void, ms: number) => void;
}

export class Push {
  private readonly store: Store;
  private readonly home?: string;
  private readonly language: () => Language;
  private readonly now: () => number;
  private readonly post?: Post;
  private readonly later: (fn: () => void, ms: number) => void;
  private vapid?: Promise<Vapid>;
  /** When the owner last used a page at the machine. */
  private desk = -Infinity;
  /** The paired devices with a page in view, by id, and when it last said so. */
  private devices = new Map<string, number>();
  /** The minute after a push: what starts waiting meanwhile, by card. */
  private window: Map<string, Waits> | null = null;
  /** Deliveries, one after the other. */
  private sending: Promise<void> = Promise.resolve();

  constructor(o: PushOptions) {
    this.store = o.store;
    this.home = o.home;
    this.language = o.language ?? (() => 'de');
    this.now = o.now ?? Date.now;
    this.post = o.post;
    this.later = o.later ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  /** The public VAPID key a page subscribes with. */
  async key(): Promise<string> {
    return (await this.keys()).publicKey;
  }

  private keys(): Promise<Vapid> {
    return (this.vapid ??= (async () => {
      const file = this.home && join(this.home, KEY_FILE);
      if (file && existsSync(file)) return vapidOf(JSON.parse(readFileSync(file, 'utf8')) as JsonWebKey);
      const jwk = await newVapidJwk();
      if (file) {
        writeFileSync(file, `${JSON.stringify(jwk)}\n`, { mode: 0o600 });
        chmodSync(file, 0o600);
      }
      return vapidOf(jwk);
    })());
  }

  /** The device turned notifications on: its subscription replaces the one it had. */
  subscribe(device: string, input: unknown) {
    const sub = subscriptionOf(input);
    if (typeof sub === 'string') throw new BadRequest('invalid', sub);
    this.store.setPush(device, JSON.stringify(sub));
  }

  unsubscribe(device: string) {
    this.store.setPush(device, null);
  }

  /** The devices that get pushes: not one unused for so long that it is no longer paired (remote.ts), even before it comes back and is removed. */
  private subscriptions() {
    const now = this.now();
    return this.store.pushes().filter((p) => now - Date.parse(p.lastSeen) <= UNUSED_MS);
  }

  /** Whether `device` gets pushes. */
  subscribed(device: string): boolean {
    return this.subscriptions().some((p) => p.id === device);
  }

  /** The owner used a page at the machine: nothing is pushed for `DESK_MS`. */
  here() {
    this.desk = this.now();
  }

  /** Whether the owner is at the machine. */
  atDesk(): boolean {
    return this.now() - this.desk < DESK_MS;
  }

  /** A page on paired device `device` is in view: nothing is pushed until it goes out of view (`away`), or says nothing for `DEVICE_MS`. */
  onDevice(device: string) {
    this.devices.set(device, this.now());
  }

  /** The device's page went out of view (the phone locked, another app) or closed: pushes go out again at once. */
  away(device: string) {
    this.devices.delete(device);
  }

  /** Whether the owner has a page in view on a paired device. */
  onADevice(): boolean {
    return [...this.devices.values()].some((at) => this.now() - at < DEVICE_MS);
  }

  /** Whether the owner uses Obeya, at the machine or on a device; the server's log says why a phone got nothing. */
  private inUse(cards: Waits[]): boolean {
    const where = this.atDesk() ? 'at the machine' : this.onADevice() && 'on a device';
    if (where) console.log(`Obeya: not pushed, the owner is ${where}: ${cards.map((w) => `„${plainTitle(w.title)}“`).join(', ')}`);
    return !!where;
  }

  /** Cards that started to wait for the owner. */
  waits(cards: Waits[]) {
    if (!cards.length || !this.subscriptions().length) return;
    if (this.inUse(cards)) return;
    if (this.window) {
      for (const w of cards) this.window.set(w.card, w);
      return;
    }
    const [first, ...rest] = cards;
    this.window = new Map(rest.map((w) => [w.card, w]));
    this.deliver(this.message([first!]));
    this.later(() => this.windowEnds(), WINDOW_MS);
  }

  /** The minute after a push is over: what started waiting meanwhile, and still waits, goes out as one push. */
  private windowEnds() {
    const cards = [...(this.window?.values() ?? [])].filter((w) => w.still());
    this.window = null;
    if (!cards.length || this.inUse(cards)) return;
    this.window = new Map();
    this.deliver(this.message(cards));
    this.later(() => this.windowEnds(), WINDOW_MS);
  }

  private message(cards: Waits[]): PushMessage {
    const m = MESSAGES[this.language()].push;
    if (cards.length === 1) {
      const w = cards[0]!;
      return { title: clipped(plainTitle(w.title), 160), body: clipped([m[w.kind], w.canvas].filter(Boolean).join(' · '), 200), url: this.cardUrl(w.card), tag: w.card };
    }
    return { title: m.several(cards.length), body: clipped(cards.map((w) => plainTitle(w.title)).join(' · '), 600), url: '/', tag: 'several' };
  }

  /** Where tapping the push for a card leads: the card on its canvas, by its short code. */
  private cardUrl(id: string): string {
    const row = this.store.card(id);
    return row ? `/c/${encodeURIComponent(row.canvas_id)}/card/${row.short}` : `/?card=${encodeURIComponent(id)}`;
  }

  /** Sends `message` to every device that gets pushes; a subscription its push service no longer knows goes. */
  private deliver(message: PushMessage) {
    this.sending = this.sending.then(async () => {
      const vapid = await this.keys();
      await Promise.all(
        this.subscriptions().map(async ({ id, name, push }) => {
          try {
            const status = await send(JSON.parse(push) as Subscription, message, vapid, this.post);
            console.log(`Obeya: pushed „${message.title}“ to ${name}: ${status === 201 ? 'taken' : status}`);
            if (status === 404 || status === 410) this.store.setPush(id, null);
          } catch (e) {
            console.warn(`Obeya: push to ${name} failed: ${(e as Error).message}`);
          }
        }),
      );
    });
  }

  /** Once what is on its way has been sent (for tests). */
  settled(): Promise<void> {
    return this.sending;
  }
}
