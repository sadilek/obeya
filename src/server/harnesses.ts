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
// The same for Claude Code on each host, asked over the connection.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_MODELS, type AgentModel, type ClaudeUpdate, type Harness, type HarnessHost, type HarnessModel, type HarnessView, modelName, modelVersion, newestOfFamilies } from '../core/types';
import { codexExecutable, codexLogin, codexModels, codexVersion } from './codex';
import type { SshHost } from './hosts';
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

/** The channel Claude Code updates from (`autoUpdatesChannel` in its settings). */
export type ClaudeChannel = 'latest' | 'stable';

/** Claude Code on another machine (a host, `hostClaude`), as Obeya asks it over the connection. */
export interface ClaudeHost {
  name: string;
  /** Whether the host answered the last time it was asked; one that did not is looked at once it does. */
  reachable(): boolean;
  /** Its version and the channel it updates from; null: not installed there. Fails where the host does not answer. */
  look(): Promise<{ version: string; channel: ClaudeChannel } | null>;
  /** The models it lists there. */
  models(): Promise<ClaudeListed[]>;
  /** Brings it up to date there. */
  update(): Promise<void>;
}

/**
 * Claude Code on one machine, this one or a host: its version as last looked at, the models it
 * lists, the newest version of its channel, and an update of it.
 */
class ClaudeInstall {
  version?: string;
  channel?: ClaudeChannel;
  /** The models it lists, as last heard, and when it was asked. */
  private listed: { at: number; models: ClaudeListed[]; asking?: Promise<void> } | undefined;
  /** The newest Claude Code npm has for its channel, as last heard, and when it was asked. */
  private newest: { at: number; version?: string; asking?: true } | undefined;
  /** An update under way, or how the last one failed. */
  private updating: { running: boolean; error?: string } | undefined;

  constructor(
    private o: {
      /** The host it is on; none: this machine. */
      host?: string;
      models?: () => Promise<ClaudeListed[]>;
      newest?: (channel?: ClaudeChannel) => Promise<string | undefined>;
      update?: (log: (line: string) => void) => Promise<void>;
      /** Looks at it again (after an update), which `found` then tells. */
      look: () => Promise<void>;
      /** Whether it can be asked for its models now (installed, logged in). */
      ready: () => boolean;
      changed: () => void;
    },
  ) {}

  /** What a look found; another version may stand for other models, another channel for another newest. */
  found(version: string | undefined, channel?: ClaudeChannel) {
    if (this.listed && version !== this.version) this.listed.at = 0;
    if (this.newest && channel !== this.channel) this.newest.at = 0;
    this.version = version;
    this.channel = channel;
    // asked as it is first looked at, the menus have them at once
    this.models();
    this.offer();
  }

  /** Looks at it again, which `found` then tells. */
  look(): Promise<void> {
    return this.o.look();
  }

  /** Claude Code here, or on the host it is on, in the log. */
  private get named() {
    return this.o.host ? `Claude Code on ${this.o.host}` : 'Claude Code';
  }

  /**
   * The model id an agent of this Claude Code's is given for `model`: for an alias whose family it
   * lists a newer model of than the alias names (or that it lists no model under), that newer one;
   * else `model` as it is.
   */
  model(model: string): string {
    const listed = this.listed?.models ?? [];
    const alias = AGENT_MODELS.find((m) => m === model && m !== 'default');
    const newest = alias && aliasesOf(listed)[alias];
    return newest && newest !== listed.find((m) => m.value === alias)?.resolvedModel ? newest : model;
  }

  /**
   * Updates it in the background, then looks at it again and asks it for its models, so the next
   * agents run on the new version and the menus have its models once `offer` no longer says it is
   * running; `offer` also says how it failed.
   */
  update(): void {
    const update = this.o.update;
    if (!update || this.updating?.running) return;
    this.updating = { running: true };
    this.o.changed();
    console.log(`Obeya: updating ${this.named}`);
    void (async () => {
      let error: string | undefined;
      try {
        await update(() => {});
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        console.error(`Obeya: updating ${this.named} failed: ${error}`);
      }
      try {
        await this.look();
        if (this.version) console.log(`Obeya: ${this.named} is at ${this.version}`);
        // the models of the version it is at now, which the look had it asked for
        this.models();
        await this.listed?.asking;
      } catch {}
      this.updating = error ? { running: false, error } : undefined;
      this.o.changed();
    })();
  }

  /** What the view says of updating it: a newer version that is out, one under way, how it failed. */
  offer(): ClaudeUpdate | undefined {
    const ask = this.o.newest;
    const known = this.newest;
    if (ask && !known?.asking && (!known || Date.now() - known.at > NEWEST_FOR_MS)) {
      this.newest = { at: known?.at ?? 0, ...(known?.version ? { version: known.version } : {}), asking: true };
      ask(this.channel).then(
        (version) => (this.newest = { at: Date.now(), ...(version ? { version } : {}) }),
        (e) => {
          console.warn(`Obeya: npm did not say which Claude Code is the newest: ${e instanceof Error ? e.message : e}`);
          this.newest = { at: Date.now(), ...(known?.version ? { version: known.version } : {}) };
        },
      );
    }
    const now = this.version;
    if (this.updating?.running) return { version: known?.version ?? '', running: true };
    if (!known?.version || !now || Bun.semver.order(known.version, now) <= 0) return undefined;
    return { version: known.version, ...(this.updating?.error ? { error: this.updating.error } : {}) };
  }

  /**
   * The models it lists as last heard (nothing before it first answered), asked again in the
   * background once that is a while ago or it changed (another version).
   */
  models(): ClaudeListed[] {
    const ask = this.o.models;
    const known = this.listed;
    if (ask && this.o.ready() && !known?.asking && (!known || Date.now() - known.at > MODELS_FOR_MS)) {
      const asking = ask().then(
        (models) => void (this.listed = { at: Date.now(), models }),
        (e) => {
          console.warn(`Obeya: ${this.named} did not list its models: ${e instanceof Error ? e.message : e}`);
          this.listed = { at: Date.now(), models: known?.models ?? [] };
        },
      );
      this.listed = { at: known?.at ?? 0, models: known?.models ?? [], asking };
    }
    return known?.models ?? [];
  }
}

export class Harnesses {
  /** By harness, once looked at. */
  private found: Partial<Record<Harness, HarnessFound | null>> = {};
  private models: { at: number; list: Promise<HarnessModel[]> } | undefined;
  /** When Claude Code was last looked at. */
  private lookedAt = Date.now();
  /** Claude Code on this machine. */
  private here: ClaudeInstall;
  /** Claude Code on the hosts, by name: when it was last looked at there, whether it is installed there. */
  private there = new Map<string, { host: ClaudeHost; claude: ClaudeInstall; at: number; looking?: boolean; installed?: boolean }>();
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
      /** The newest Claude Code there is, of the channel given (none: the one this machine's Claude Code updates from); none: no update is offered. */
      claudeNewest?: (channel?: ClaudeChannel) => Promise<string | undefined>;
      /** Updates Claude Code, the last line of its output to `log`. */
      updateClaude?: (log: (line: string) => void) => Promise<void>;
      /** The hosts of the configuration, whose Claude Code is looked at too. */
      hosts?: () => ClaudeHost[];
    },
  ) {
    const changed = () => this.changed();
    this.here = new ClaudeInstall({
      ...(o.claudeModels ? { models: () => o.claudeModels!(o.cwd) } : {}),
      ...(o.claudeNewest ? { newest: o.claudeNewest } : {}),
      ...(o.updateClaude ? { update: o.updateClaude } : {}),
      look: async () => {
        const claude = await this.o.claude?.();
        this.lookedAt = Date.now();
        if (claude !== undefined) this.set({ claude });
      },
      ready: () => this.ready('claude'),
      changed,
    });
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /** Looks at the harnesses again. */
  async refresh(): Promise<void> {
    this.lookedAt = Date.now();
    const [claude, codex] = await Promise.all([this.o.claude?.(), (this.o.codex ?? findCodex)()]);
    this.set({ ...(claude !== undefined ? { claude } : {}), codex });
  }

  /** What a look found (null: not installed). */
  set(found: Partial<Record<Harness, HarnessFound | null>>) {
    const before = JSON.stringify(this.found);
    this.found = { ...this.found, ...found };
    if (JSON.stringify(this.found) === before) return;
    if (!this.ready('codex')) this.models = undefined;
    this.here.found(this.found.claude?.version);
    this.changed();
  }

  /**
   * Looks at Claude Code on the hosts of the configuration, in the background: at first, again
   * after ten minutes, and on a host that did not answer once it does.
   */
  lookAtHosts(): void {
    const hosts = this.o.hosts?.() ?? [];
    for (const name of this.there.keys()) if (!hosts.some((h) => h.name === name)) this.there.delete(name);
    for (const host of hosts) {
      let on = this.there.get(host.name);
      if (!on || on.host !== host) {
        const look = async () => {
          const found = await host.look();
          const at = this.there.get(host.name);
          if (at?.host !== host) return;
          at.installed = !!found;
          at.claude.found(found?.version, found?.channel);
        };
        const claude = new ClaudeInstall({
          host: host.name,
          models: () => host.models(),
          ...(this.o.claudeNewest ? { newest: this.o.claudeNewest } : {}),
          update: () => host.update(),
          look,
          ready: () => !!this.there.get(host.name)?.installed,
          changed: () => this.changed(),
        });
        on = { host, claude, at: 0 };
        this.there.set(host.name, on);
      }
      if (on.looking || !host.reachable() || Date.now() - on.at <= MODELS_FOR_MS) continue;
      const it = on;
      it.looking = true;
      it.at = Date.now();
      void (async () => {
        try {
          const version = it.claude.version;
          await it.claude.look();
          if (it.claude.version !== version) this.changed();
        } catch {
          // asked again once it answers
          it.at = 0;
        }
        it.looking = false;
      })();
    }
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
    this.lookAtHosts();
    // the harness's default is no entry of its own: it is one of the models, which the owner picks by name
    const resolved = aliasesOf(this.here.models());
    const update = this.here.offer();
    const hosts: HarnessHost[] = [];
    for (const [name, on] of this.there) {
      const version = on.claude.version;
      if (!version) continue;
      const offer = on.claude.offer();
      hosts.push({ name, version, ...(offer ? { update: offer } : {}) });
    }
    const claude: HarnessView = {
      id: 'claude',
      ready: this.ready('claude'),
      ...this.version('claude'),
      models: AGENT_MODELS.filter((id) => id !== 'default').map((id) => ({ id, ...(resolved[id] ? { resolved: resolved[id] } : {}) })),
      ...(update ? { update } : {}),
      ...(hosts.length ? { hosts } : {}),
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
   * The model id an agent of Claude Code's is given for `model`, on this machine or the host named:
   * for an alias whose family that Claude Code lists a newer model of than the alias names (or that
   * it lists no model under), that newer one; else `model` as it is.
   */
  claudeModel(model: string, host?: string): string {
    const claude = host === undefined ? this.here : this.there.get(host)?.claude;
    return claude ? claude.model(model) : model;
  }

  /**
   * Updates Claude Code, on this machine or the host named, in the background (`claude update`),
   * then looks at it again and asks it for its models, so the next agents run on the new version
   * and the menus have its models once the view no longer says it is running; the view also says
   * how it failed.
   */
  updateClaude(host?: string): void {
    (host === undefined ? this.here : this.there.get(host)?.claude)?.update();
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
 * settings, hooks and MCP servers, and without a prompt) that lists them; `there`: the session on
 * a host, started over its connection.
 */
export async function claudeModels(cwd: string, there?: SshHost): Promise<ClaudeListed[]> {
  const abort = new AbortController();
  // the session waits for a prompt that never comes, until it is closed
  const idle = (async function* () {
    await new Promise((resolve) => abort.signal.addEventListener('abort', resolve, { once: true }));
  })();
  const claude = there ? 'claude' : claudeExecutable();
  const q = query({
    prompt: idle as AsyncIterable<never>,
    options: {
      cwd,
      abortController: abort,
      settingSources: [],
      // on another machine only what the session itself needs: that machine has its own PATH and home
      env: there ? {} : cleanEnv(),
      ...(claude ? { pathToClaudeCodeExecutable: claude } : {}),
      spawnClaudeCodeProcess: there ? there.session({}) : spawnHere(() => {}),
    },
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
 * The newest Claude Code of `channel`, else of the channel the owner's Claude Code here updates
 * from (`autoUpdatesChannel` in its settings: `latest`, the default, or `stable`), as npm has it.
 */
export async function claudeNewest(channel?: ClaudeChannel, env: Record<string, string | undefined> = process.env, home = homedir()): Promise<string | undefined> {
  if (!channel) {
    channel = 'latest';
    try {
      const settings = await Bun.file(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json')).json();
      if (settings?.autoUpdatesChannel === 'stable') channel = 'stable';
    } catch {}
  }
  const res = await fetch('https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags', { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`npm answered ${res.status}`);
  const tag = ((await res.json()) as Record<string, unknown>)[channel];
  return typeof tag === 'string' ? tag : undefined;
}

const onHosts = new WeakMap<SshHost, ClaudeHost>();

/** Claude Code on a host, asked over its connection: one for each host, which `Harnesses` knows it by. */
export function hostClaude(host: SshHost): ClaudeHost {
  let claude = onHosts.get(host);
  if (!claude) {
    claude = {
      name: host.name,
      reachable: () => !host.unreachable,
      look: () => host.claude(),
      models: () => claudeModels('/', host),
      update: () => host.updateClaude(),
    };
    onHosts.set(host, claude);
  }
  return claude;
}
