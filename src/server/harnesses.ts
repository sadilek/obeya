// The harnesses Obeya runs agents on, as this machine has them: Claude Code and Codex, each
// installed or not, logged in or not. The setup assistant shows what it found (machine.ts) and tells
// this what it found; Obeya looks once as it starts. A group of agents the owner chose no harness for
// runs on Claude Code, unless only Codex is ready here. The Configuration lists each harness with the
// models it offers: Claude Code's aliases, and the models Codex lists for its login, of each family
// (`gpt-6.1-sol`, `gpt-5.6-sol`) only the newest, which stands for the family. Each with the version
// it runs on here: Codex's model ids carry it; which models Claude Code has, an idle Claude Code
// session says, asked in the background so the menus never wait for it, and an alias stands for the
// newest of its family among them, which an agent then runs on even where Claude Code's alias still
// names an older one. Whether a newer Claude Code is out, npm says; Obeya updates it at the owner's click.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_MODELS, type AgentModel, type Harness, type HarnessModel, type HarnessView, modelName, modelVersion, newestOfFamilies } from '../core/types';
import { codexExecutable, codexLogin, codexModels, codexVersion } from './codex';
import { claudeExecutable, cleanEnv, spawnHere } from './runtime';

/** What a look at a harness found. */
export interface HarnessFound {
  version?: string;
  loggedIn: boolean;
  /** How it is logged in, as it says ("ChatGPT"). */
  how?: string;
}

/** How long Codex's list of models is kept before it is asked again, and Claude Code looked at again. */
const MODELS_FOR_MS = 10 * 60_000;
/** How long npm's newest Claude Code is kept before it is asked again. */
const NEWEST_FOR_MS = 60 * 60_000;

/** A model Claude Code lists (`supportedModels`): an alias with the model it stands for, or a model by its id. */
export interface ClaudeListed {
  value: string;
  resolvedModel?: string;
}

export class Harnesses {
  /** By harness, once looked at. */
  private found: Partial<Record<Harness, HarnessFound | null>> = {};
  private models: { at: number; list: Promise<HarnessModel[]> } | undefined;
  /** The models Claude Code lists, as last heard, and when it was asked. */
  private listed: { at: number; models: ClaudeListed[]; asking?: Promise<void> } | undefined;
  /** The newest Claude Code npm has, as last heard, and when it was asked. */
  private newest: { at: number; version?: string; asking?: true } | undefined;
  /** When Claude Code was last looked at. */
  private lookedAt = Date.now();
  /** An update of Claude Code under way, or how the last one failed. */
  private updating: { running: boolean; error?: string } | undefined;
  private listeners = new Set<() => void>();

  constructor(
    private o: {
      /** Where Codex is asked for its models. */
      cwd: string;
      /** Looks at Claude Code (the setup assistant's own check); none: it stays as found by `set`. */
      claude?: () => Promise<HarnessFound | null>;
      codex?: () => Promise<HarnessFound | null>;
      codexModels?: (cwd: string) => Promise<HarnessModel[]>;
      /** Asks Claude Code which models it has; none: the aliases go without a version. */
      claudeModels?: (cwd: string) => Promise<ClaudeListed[]>;
      /** The newest Claude Code there is; none: no update is offered. */
      claudeNewest?: () => Promise<string | undefined>;
      /** Updates Claude Code, the last line of its output to `log`. */
      updateClaude?: (log: (line: string) => void) => Promise<void>;
    },
  ) {}

  /** Looks at the harnesses again. */
  async refresh(): Promise<void> {
    this.lookedAt = Date.now();
    const [claude, codex] = await Promise.all([this.o.claude?.(), (this.o.codex ?? findCodex)()]);
    this.set({ ...(claude !== undefined ? { claude } : {}), codex });
  }

  /** What a look found (null: not installed). */
  set(found: Partial<Record<Harness, HarnessFound | null>>) {
    const before = JSON.stringify(this.found);
    const claude = this.found.claude?.version;
    this.found = { ...this.found, ...found };
    if (JSON.stringify(this.found) === before) return;
    if (!this.ready('codex')) this.models = undefined;
    // another version of Claude Code may stand for other models; asked as Obeya starts, the menus have them at once
    if (this.listed && this.found.claude?.version !== claude) this.listed.at = 0;
    this.claudeListed();
    // whether a newer one is out, which the first menu then has
    this.claudeUpdate();
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

  /** Each harness with what it offers, for the Configuration. */
  async view(): Promise<HarnessView[]> {
    // Claude Code updated on the command line meanwhile: the next view has it
    if (this.o.claude && Date.now() - this.lookedAt > MODELS_FOR_MS) {
      this.lookedAt = Date.now();
      this.o.claude().then((claude) => this.set({ claude }), () => {});
    }
    // the harness's default is no entry of its own: it is one of the models, which the owner picks by name
    const resolved = aliasesOf(this.claudeListed());
    const update = this.claudeUpdate();
    const claude: HarnessView = {
      id: 'claude',
      ready: this.ready('claude'),
      ...this.version('claude'),
      models: AGENT_MODELS.filter((id) => id !== 'default').map((id) => ({ id, ...(resolved[id] ? { resolved: resolved[id] } : {}) })),
      ...(update ? { update } : {}),
    };
    const listed = this.ready('codex') ? await this.codexModels() : [];
    const codex: HarnessView = { id: 'codex', ready: this.ready('codex'), ...this.version('codex'), models: newestOfFamilies(listed) };
    return [claude, codex];
  }

  private version(h: Harness) {
    const v = this.found[h]?.version;
    return v ? { version: v } : {};
  }

  /**
   * The model id an agent of Claude Code's on this machine is given for `model`: for an alias whose
   * family Claude Code lists a newer model of than the alias names (or that it lists no model under),
   * that newer one; else `model` as it is.
   */
  claudeModel(model: string): string {
    const listed = this.listed?.models ?? [];
    const alias = AGENT_MODELS.find((m) => m === model && m !== 'default');
    const newest = alias && aliasesOf(listed)[alias];
    return newest && newest !== listed.find((m) => m.value === alias)?.resolvedModel ? newest : model;
  }

  /**
   * Updates Claude Code in the background (`claude update`), then looks at it again and asks it for
   * its models, so the next agents run on the new version and the menus have its models once the
   * view no longer says it is running; the view also says how it failed.
   */
  updateClaude(): void {
    const update = this.o.updateClaude;
    if (!update || this.updating?.running) return;
    this.updating = { running: true };
    for (const fn of this.listeners) fn();
    console.log('Obeya: updating Claude Code');
    void (async () => {
      let error: string | undefined;
      try {
        await update(() => {});
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        console.error(`Obeya: updating Claude Code failed: ${error}`);
      }
      try {
        const claude = await this.o.claude?.();
        this.lookedAt = Date.now();
        if (claude !== undefined) this.set({ claude });
        if (claude?.version) console.log(`Obeya: Claude Code is at ${claude.version}`);
        // the models of the version it is at now, which the look had Claude Code asked for
        this.claudeListed();
        await this.listed?.asking;
      } catch {}
      this.updating = error ? { running: false, error } : undefined;
      for (const fn of this.listeners) fn();
    })();
  }

  /** What the view says of updating Claude Code: a newer version that is out, one under way, how it failed. */
  private claudeUpdate(): HarnessView['update'] {
    const ask = this.o.claudeNewest;
    const known = this.newest;
    if (ask && !known?.asking && (!known || Date.now() - known.at > NEWEST_FOR_MS)) {
      this.newest = { at: known?.at ?? 0, ...(known?.version ? { version: known.version } : {}), asking: true };
      ask().then(
        (version) => (this.newest = { at: Date.now(), ...(version ? { version } : {}) }),
        (e) => {
          console.warn(`Obeya: npm did not say which Claude Code is the newest: ${e instanceof Error ? e.message : e}`);
          this.newest = { at: Date.now(), ...(known?.version ? { version: known.version } : {}) };
        },
      );
    }
    const now = this.found.claude?.version;
    if (this.updating?.running) return { version: known?.version ?? '', running: true };
    if (!known?.version || !now || Bun.semver.order(known.version, now) <= 0) return undefined;
    return { version: known.version, ...(this.updating?.error ? { error: this.updating.error } : {}) };
  }

  /**
   * The models Claude Code lists as last heard (nothing before it first answered), asked again in
   * the background once that is a while ago or Claude Code changed (another version).
   */
  private claudeListed(): ClaudeListed[] {
    const ask = this.o.claudeModels;
    const known = this.listed;
    if (ask && this.ready('claude') && !known?.asking && (!known || Date.now() - known.at > MODELS_FOR_MS)) {
      const asking = ask(this.o.cwd).then(
        (models) => void (this.listed = { at: Date.now(), models }),
        (e) => {
          console.warn(`Obeya: Claude Code did not list its models: ${e instanceof Error ? e.message : e}`);
          this.listed = { at: Date.now(), models: known?.models ?? [] };
        },
      );
      this.listed = { at: known?.at ?? 0, models: known?.models ?? [], asking };
    }
    return known?.models ?? [];
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

/**
 * The models Claude Code has, from an idle Claude Code session in `cwd` (without the owner's
 * settings, hooks and MCP servers, and without a prompt) that lists them.
 */
export async function claudeModels(cwd: string): Promise<ClaudeListed[]> {
  const abort = new AbortController();
  // the session waits for a prompt that never comes, until it is closed
  const idle = (async function* () {
    await new Promise((resolve) => abort.signal.addEventListener('abort', resolve, { once: true }));
  })();
  const claude = claudeExecutable();
  const q = query({
    prompt: idle as AsyncIterable<never>,
    options: { cwd, abortController: abort, settingSources: [], env: cleanEnv(), ...(claude ? { pathToClaudeCodeExecutable: claude } : {}), spawnClaudeCodeProcess: spawnHere(() => {}) },
  });
  void (async () => {
    try {
      for await (const _ of q);
    } catch {}
  })();
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    return (await q.supportedModels()).map((m) => ({ value: m.value, ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}) }));
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/**
 * The model each alias stands for, from the models Claude Code lists: the newest of the alias's
 * family it lists, by its id or under the alias (it may list a new Fable by its id while `fable`
 * still names the one before).
 */
export function aliasesOf(listed: ClaudeListed[]): Partial<Record<AgentModel, string>> {
  const out: Partial<Record<AgentModel, string>> = {};
  const number = (id: string) => (modelVersion(id) ?? '0').split('.').map(Number);
  const newer = (a: number[], b: number[]) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0);
  for (const alias of AGENT_MODELS) {
    if (alias === 'default') continue;
    const family = listed.map((m) => m.resolvedModel ?? m.value).filter((id) => modelName(id).toLowerCase().startsWith(`${alias} `));
    const newest = family.sort((a, b) => newer(number(b), number(a)))[0];
    if (newest) out[alias] = newest;
  }
  return out;
}

/**
 * The newest Claude Code of the channel the owner's Claude Code updates from (`autoUpdatesChannel`
 * in its settings: `latest`, the default, or `stable`), as npm has it.
 */
export async function claudeNewest(env: Record<string, string | undefined> = process.env, home = homedir()): Promise<string | undefined> {
  let channel = 'latest';
  try {
    const settings = await Bun.file(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json')).json();
    if (settings?.autoUpdatesChannel === 'stable') channel = 'stable';
  } catch {}
  const res = await fetch('https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags', { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`npm answered ${res.status}`);
  const tag = ((await res.json()) as Record<string, unknown>)[channel];
  return typeof tag === 'string' ? tag : undefined;
}
