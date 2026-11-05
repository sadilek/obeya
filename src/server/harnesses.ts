// The harnesses Obeya runs agents on, as this machine has them: Claude Code and Codex, each
// installed or not, logged in or not. The setup assistant shows what it found (machine.ts) and tells
// this what it found; Obeya looks once as it starts. A group of agents the owner chose no harness for
// runs on Claude Code, unless only Codex is ready here. The Konfiguration lists each harness with the
// models it offers: Claude Code's aliases, and the models Codex lists for its login, of each family
// (`gpt-6.1-sol`, `gpt-5.6-sol`) only the newest.

import { AGENT_MODELS, type Harness, type HarnessModel, type HarnessView } from '../core/types';
import { codexExecutable, codexLogin, codexModels, codexVersion } from './codex';

/** What a look at a harness found. */
export interface HarnessFound {
  version?: string;
  loggedIn: boolean;
  /** How it is logged in, as it says („ChatGPT“). */
  how?: string;
}

/** How long Codex's list of models is kept before it is asked again. */
const MODELS_FOR_MS = 10 * 60_000;

export class Harnesses {
  /** By harness, once looked at. */
  private found: Partial<Record<Harness, HarnessFound | null>> = {};
  private models: { at: number; list: Promise<HarnessModel[]> } | undefined;
  private listeners = new Set<() => void>();

  constructor(
    private o: {
      /** Where Codex is asked for its models. */
      cwd: string;
      /** Looks at Claude Code (the setup assistant's own check); none: it stays as found by `set`. */
      claude?: () => Promise<HarnessFound | null>;
      codex?: () => Promise<HarnessFound | null>;
      codexModels?: (cwd: string) => Promise<HarnessModel[]>;
    },
  ) {}

  /** Looks at the harnesses again. */
  async refresh(): Promise<void> {
    const [claude, codex] = await Promise.all([this.o.claude?.(), (this.o.codex ?? findCodex)()]);
    this.set({ ...(claude !== undefined ? { claude } : {}), codex });
  }

  /** What a look found (null: not installed). */
  set(found: Partial<Record<Harness, HarnessFound | null>>) {
    const before = JSON.stringify(this.found);
    this.found = { ...this.found, ...found };
    if (JSON.stringify(this.found) === before) return;
    if (!this.ready('codex')) this.models = undefined;
    for (const fn of this.listeners) fn();
  }

  /** Installed and logged in. Claude Code counts as ready until a look says otherwise, Codex once one says so. */
  ready(h: Harness): boolean {
    const f = this.found[h];
    return f === undefined ? h === 'claude' : !!f?.loggedIn;
  }

  /** The harness of a group the owner chose none for: Claude Code, unless only Codex is ready. */
  preferred(): Harness {
    return !this.ready('claude') && this.ready('codex') ? 'codex' : 'claude';
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Each harness with what it offers, for the Konfiguration. */
  async view(): Promise<HarnessView[]> {
    // the harness's default is no entry of its own: it is one of the models, which the owner picks by name
    const claude: HarnessView = { id: 'claude', ready: this.ready('claude'), ...this.version('claude'), models: AGENT_MODELS.filter((id) => id !== 'default').map((id) => ({ id })) };
    const listed = this.ready('codex') ? await this.codexModels() : [];
    const codex: HarnessView = { id: 'codex', ready: this.ready('codex'), ...this.version('codex'), models: newestOfFamilies(listed) };
    return [claude, codex];
  }

  private version(h: Harness) {
    const v = this.found[h]?.version;
    return v ? { version: v } : {};
  }

  private async codexModels(): Promise<HarnessModel[]> {
    if (!this.models || Date.now() - this.models.at > MODELS_FOR_MS) {
      const list = (this.o.codexModels ?? codexModels)(this.o.cwd).catch((e) => {
        console.warn(`Obeya: Codex did not list its models: ${e instanceof Error ? e.message : e}`);
        this.models = undefined;
        return [];
      });
      this.models = { at: Date.now(), list };
    }
    return this.models.list;
  }
}

/** Codex on this machine: its version and whether it is logged in; null where it is not installed. */
export async function findCodex(env: Record<string, string | undefined> = process.env): Promise<HarnessFound | null> {
  const bin = codexExecutable(env);
  const version = bin ? await codexVersion(bin, env) : null;
  if (!bin || !version) return null;
  const login = await codexLogin(bin, env);
  return { version, loggedIn: login.loggedIn, ...(login.how ? { how: login.how } : {}) };
}

/** A model id's family and version: `gpt-6.1-sol` is `gpt-#-sol` 6.1; none for an id without a number. */
function family(id: string): { family: string; version: number[] } | null {
  const m = /^(\D*?)(\d+(?:\.\d+)*)(.*)$/.exec(id);
  return m ? { family: `${m[1]}#${m[3]}`, version: m[2]!.split('.').map(Number) } : null;
}

const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

/**
 * Codex's models without the older versions of a family (`gpt-5.6-sol` beside `gpt-6.1-sol`), in
 * Codex's order; the one it marks as its default stays, which a setting of `default` runs on.
 */
export function newestOfFamilies(models: HarnessModel[]): HarnessModel[] {
  const newest = new Map<string, { id: string; version: number[] }>();
  for (const m of models) {
    const f = family(m.id);
    const known = f && newest.get(f.family);
    if (f && (!known || newer(f.version, known.version))) newest.set(f.family, { id: m.id, version: f.version });
  }
  return models.filter((m) => {
    const f = family(m.id);
    return m.isDefault || !f || newest.get(f.family)?.id === m.id;
  });
}
