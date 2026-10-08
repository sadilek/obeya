// The key that records a command from anywhere on the machine, while another app is in front (the
// app's shell hears it: app/src/keys.rs). Written as the browser names keys (`KeyboardEvent.code`):
// one key held alone, or modifiers and a key ("Control+Shift+Space"). A key alone is one nobody
// types with (a modifier, an F key and the like), since the shell only listens and the key still
// reaches the app in front; a combination the shell takes for itself.

export const PUSH_MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta'] as const;
export type PushModifier = (typeof PUSH_MODIFIERS)[number];

const F_KEYS = Array.from({ length: 24 }, (_, i) => `F${i + 1}`);

/** Keys that may be held alone. */
export const PUSH_SINGLE_KEYS: readonly string[] = [
  ...PUSH_MODIFIERS.flatMap((m) => [`${m}Left`, `${m}Right`]),
  ...F_KEYS,
  'Pause',
  'ScrollLock',
  'Insert',
  'ContextMenu',
];

/** Keys that may follow modifiers in a combination. */
const COMBINATION_KEYS: readonly string[] = [
  ...F_KEYS,
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((d) => `Digit${d}`),
  'Space',
  'Backquote',
  'Pause',
  'ScrollLock',
  'Insert',
];

/** The default: right Option on a Mac, right Ctrl elsewhere (right Alt is AltGr on many European layouts). */
export const defaultPushKey = (platform: string) => (platform === 'darwin' ? 'AltRight' : 'ControlRight');

/** The key in its written form, or `null` when it cannot be the push-to-talk key. */
export function parsePushKey(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const parts = input.split('+').map((p) => p.trim());
  if (parts.length === 1) return PUSH_SINGLE_KEYS.includes(parts[0]!) ? parts[0]! : null;
  const key = parts.pop()!;
  if (!COMBINATION_KEYS.includes(key)) return null;
  const mods = PUSH_MODIFIERS.filter((m) => parts.includes(m));
  if (mods.length !== parts.length) return null;
  return [...mods, key].join('+');
}

/** What a key press in the settings makes of it: a key alone, a combination, or `null` (keep listening). */
export function pushKeyFromEvent(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  if (PUSH_MODIFIERS.some((m) => e.code === `${m}Left` || e.code === `${m}Right`)) return e.code;
  const mods = PUSH_MODIFIERS.filter((m) => ({ Control: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Meta: e.metaKey })[m]);
  return parsePushKey(mods.length ? [...mods, e.code].join('+') : e.code);
}

/**
 * What the shell reports about the key, every few seconds while it runs:
 * `on` it listens; `permission` macOS has not allowed Input Monitoring yet; `bind` the desktop
 * (Wayland) still has to bind the shortcut; `none` the desktop gives no keys of other apps (Wayland
 * without the Global Shortcuts portal); `unsupported` this key cannot be heard here; `error` it
 * failed (`detail`).
 */
export type PushKeyState = 'on' | 'permission' | 'bind' | 'none' | 'unsupported' | 'error';

export interface PushKeyShell {
  state: PushKeyState;
  /** The shell's platform (`macos`, `windows`, `linux`) and, on Linux, its session: `x11` or `wayland`. */
  platform: string;
  session?: string;
  /** What the desktop shows for the bound shortcut (Wayland), or what failed. */
  detail?: string;
}

export interface PushKeyView {
  /** The key that applies. */
  key: string;
  /** What the owner chose; `null` takes the default. */
  chosen: string | null;
  default: string;
  /** The app's shell that hears the key, while one runs; `null` in the browser alone. */
  shell: PushKeyShell | null;
}

/** Where the owner was last, as their page reports it: the shell's command goes there. */
export interface PageFocus {
  canvas: string;
  card?: string;
  project?: string;
  /** Who listens, as the page shows it under the microphone. */
  target?: string;
  /** The open card's title, for the line while the command is read. */
  title?: string;
}
