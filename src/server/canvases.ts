// The set of canvases Obeya serves, started from the configuration and kept in step with it.

import { type CanvasConfig, type CanvasDeps, CanvasRuntime, HomeDown, type StartFailure } from './canvas';
import { ConfigError } from './canvas-config';
import { Listeners } from '../core/watched';

/**
 * Starts the canvases; one that does not start is left out, with why in Obeya's log and in
 * "Configuration" (which checks the configuration again, and shows `failed` of one whose home
 * repository did not start), and the others run.
 */
export async function startCanvases(configs: CanvasConfig[], deps: CanvasDeps, failed: (f: StartFailure) => void = () => {}): Promise<CanvasRuntime[]> {
  const started = await Promise.all(
    configs.map((c) =>
      CanvasRuntime.start(c, deps).catch((e: unknown) => {
        const why = e instanceof ConfigError || e instanceof HomeDown ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
        console.error(`Obeya: the canvas ${c.name ?? c.id ?? c.repos[0]?.path} does not start, left out: ${why}`);
        if (e instanceof HomeDown) failed({ canvas: e.canvas, detail: e.message });
        return null;
      }),
    ),
  );
  return started.filter((c) => c !== null);
}

/**
 * The canvases Obeya serves, as its configuration has them while it runs (design: Live
 * configuration): a canvas new in it starts at once, one that changed takes the change
 * (`CanvasRuntime.apply`), one no longer in it stops once its agents paused, its cards kept. Its
 * listeners hear whenever a canvas starts, stops, or changes its name or repositories.
 */
export class Canvases extends Listeners {
  private list: CanvasRuntime[] = [];
  /** By canvas's id: why one in the configuration does not run (its home repository did not start). */
  private down = new Map<string, string>();
  /** The configuration as last saved (`apply`), by canvas's id: a canvas that was starting meanwhile takes it once it runs. */
  private saved: Map<string, CanvasConfig> | null = null;
  /** Whether every canvas of the configuration as last saved resolved: one not among them has left it. */
  private savedWhole = true;
  /** The ids of canvases starting while Obeya runs. */
  private starting = new Set<string>();

  /** Starts the canvases of `configs` (`startCanvases`). */
  static async start(configs: CanvasConfig[], deps: CanvasDeps, started?: (c: CanvasRuntime) => void): Promise<Canvases> {
    const canvases = new Canvases(deps, started);
    canvases.list = await canvases.start(configs);
    return canvases;
  }

  private constructor(
    private deps: CanvasDeps,
    /** A canvas started while Obeya runs. */
    private started: (c: CanvasRuntime) => void = () => {},
  ) {
    super();
    this.deps = {
      ...deps,
      stopped: (c, why) => {
        this.list = this.list.filter((x) => x !== c);
        this.down.set(c.id, why);
        this.emit();
      },
      canvases: () => this.list,
    };
  }

  /** Starts canvases, keeping why one did not. */
  private async start(configs: CanvasConfig[]): Promise<CanvasRuntime[]> {
    const list = await startCanvases(configs, this.deps, (f) => this.down.set(f.canvas, f.detail));
    for (const c of list) this.down.delete(c.id);
    return list;
  }

  /** The canvases, and repositories of those that run, that do not run as the configuration has them. */
  failures(): StartFailure[] {
    return [...[...this.down].map(([canvas, detail]) => ({ canvas, detail })), ...this.list.flatMap((c) => c.failures())];
  }

  all(): CanvasRuntime[] {
    return this.list;
  }

  get(id: string): CanvasRuntime | undefined {
    return this.list.find((c) => c.id === id);
  }

  /**
   * The configuration saved: `ids` are its canvases' ids as its check resolved them (null where one
   * does not resolve; then no canvas leaves, since which one it is stays unknown).
   */
  apply(configs: CanvasConfig[], ids: (string | null)[]): Promise<void> {
    this.saved = new Map(configs.flatMap((config, i) => (ids[i] ? [[ids[i], config] as const] : [])));
    this.savedWhole = !ids.includes(null);
    // settles once the running canvases took the configuration and the new ones run
    const starting: Promise<void>[] = [];
    configs.forEach((config, i) => {
      const id = ids[i];
      if (!id) return;
      const running = this.get(id);
      if (running) return void starting.push(running.apply(config));
      if (this.starting.has(id)) return;
      this.starting.add(id);
      starting.push(this.startNew(id, config));
    });
    this.sort();
    if (!ids.includes(null)) {
      // a canvas that did not start and left the configuration is no longer wrong
      for (const id of [...this.down.keys()]) if (!ids.includes(id)) this.down.delete(id);
      for (const c of [...this.list])
        if (!ids.includes(c.id))
          c.retire(() => {
            this.list = this.list.filter((x) => x !== c);
            this.emit();
          });
    }
    this.emit();
    return Promise.all(starting).then(() => {});
  }

  /**
   * Starts a canvas new in the configuration while Obeya runs, the others running on meanwhile. Once
   * it runs, it takes the configuration saved since; one no longer in it stops again.
   */
  private async startNew(id: string, config: CanvasConfig) {
    let c: CanvasRuntime | undefined;
    let now: CanvasConfig | undefined;
    let tried = config;
    try {
      // one that did not start tries again with a configuration saved meanwhile
      for (;;) {
        [c] = await this.start([tried]);
        now = this.saved?.get(id);
        if (c || !now || now === tried || this.closed) break;
        tried = now;
      }
    } finally {
      this.starting.delete(id);
    }
    if (!c) return;
    if (this.closed || (!now && this.savedWhole)) {
      c.shutdown();
      return;
    }
    this.list.push(c);
    console.log(`Obeya: the canvas ${c.board.canvas.name} (/c/${c.id}) runs now`);
    if (now && now !== tried) void c.apply(now);
    this.sort();
    this.started(c);
    this.emit();
  }

  /** The configuration's order is the order canvases are listed in (the switcher, the phone); one leaving goes last. */
  private sort() {
    const ids = [...(this.saved?.keys() ?? this.list.map((c) => c.id))];
    const at = (c: CanvasRuntime) => (ids.includes(c.id) ? ids.indexOf(c.id) : ids.length);
    this.list.sort((a, b) => at(a) - at(b));
  }

  /** Stops every canvas, for Obeya to end; one still starting stops once it runs. */
  shutdown() {
    this.closed = true;
    for (const c of this.list) c.shutdown();
  }

  /** Set once Obeya ends (`shutdown`). */
  private closed = false;
}
