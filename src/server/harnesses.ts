// The harnesses Obeya runs agents on, as this machine has them: Claude Code and Codex, each
// installed or not, logged in or not. The setup assistant shows what it found (machine.ts) and tells
// this what it found; Obeya looks once as it starts. A group of agents the owner chose no harness for
// runs on Claude Code, unless only Codex is ready here. The Configuration lists each harness with the
// models it offers: Claude Code's aliases, and the models Codex lists for its login, of each family
// (`gpt-6.1-sol`, `gpt-5.6-sol`) only the newest, which stands for the family. Each with the version
// it runs on here: Codex's model ids carry it; which models Claude Code has, an idle Claude Code
// session says, asked in the background so the menus never wait for it, and an alias stands for the
// newest of its family among them, which an agent then runs on even where Claude Code's alias still
// names an older one. Whether a newer Claude Code or Codex is out, npm says; Obeya updates it at the
// owner's click. The same for Claude Code and Codex on each host, asked over the connection.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_MODELS, type AgentModel, HARNESSES, type Harness, type HarnessHost, type HarnessUpdate, type HarnessModel, type HarnessView, modelName, modelVersion, newestOfFamilies } from '../core/agents';
import { Kept } from '../core/kept';
import { Listeners } from '../core/watched';
import { codexExecutable, codexLogin, codexModels, codexVersion } from './codex';
import type { SshHost } from './hosts';
import { idleClaude } from './claude';
import { messageOf } from '../core/text';

/** What a look at a harness found. */
export interface HarnessFound {
  version?: string;
  loggedIn: boolean;
  /** How it is logged in, as it says ("ChatGPT"). */
  how?: string;
}

/** How long Codex's list of models is kept before it is asked again, and a harness looked at again. */
const MODELS_FOR_MS = 10 * 60_000;
/** How long npm's newest version of a harness is kept before it is asked again. */
const NEWEST_FOR_MS = 60 * 60_000;

/** A model Claude Code lists (`supportedModels`): an alias with the model it stands for, or a model by its id. */
export interface ClaudeListed {
  value: string;
  resolvedModel?: string;
}

/** The channel Claude Code updates from (`autoUpdatesChannel` in its settings). */
export type ClaudeChannel = 'latest' | 'stable';

/** A harness on another machine (a host, `hostClaude`, `hostCodex`), as Obeya asks it over the connection. */
export interface HostHarness {
  /** The host's name. */
  name: string;
  harness: Harness;
  /** Whether the host answered the last time it was asked; one that did not is looked at once it does. */
  reachable(): boolean;
  /** Its version, and for Claude Code the channel it updates from; null: not installed there. Fails where the host does not answer. */
  look(): Promise<{ version: string; channel?: ClaudeChannel } | null>;
  /** The models Claude Code lists there; none for Codex, whose models the menus take from this machine's. */
  models?(): Promise<ClaudeListed[]>;
  /** Brings it up to date there. */
  update(): Promise<void>;
}

const NAMES: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * A harness installed on one machine, this one or a host: its version as last looked at, the
 * models it lists (Claude Code), the newest version npm has, and an update of it.
 */
class Install {
  version?: string;
  channel?: ClaudeChannel;
  /** The models it lists (Claude Code), as last heard. */
  private listed: Kept<ClaudeListed[]> | undefined;
  /** The newest version npm has (of its channel), as last heard. */
  private newest: Kept<string | undefined> | undefined;
  /** An update under way, or how the last one failed. */
  private updating: { running: boolean; error?: string } | undefined;

  constructor(
    private o: {
      harness: Harness;
      /** The host it is on; none: this machine. */
      host?: string;
      models?: () => Promise<ClaudeListed[]>;
      newest?: (channel?: ClaudeChannel) => Promise<string | undefined>;
      update?: () => Promise<void>;
      /** Looks at it again (after an update), which `found` then tells. */
      look: () => Promise<void>;
      /** Waited for after an update and its look, before the view no longer says it runs (Codex's models). */
      settle?: () => Promise<unknown>;
      /** Whether it can be asked for its models now (installed, logged in). */
      ready: () => boolean;
      changed: () => void;
    },
  ) {
    const { models, newest } = o;
    if (models)
      this.listed = new Kept(models, { forMs: MODELS_FOR_MS, failed: (e) => console.warn(`Obeya: ${this.named} did not list its models: ${messageOf(e)}`) });
    if (newest)
      this.newest = new Kept(() => newest(this.channel), {
        forMs: NEWEST_FOR_MS,
        failed: (e) => console.warn(`Obeya: npm did not say which ${NAMES[o.harness]} is the newest: ${messageOf(e)}`),
      });
  }

  /** What a look found; another version may stand for other models, another channel for another newest. */
  found(version: string | undefined, channel?: ClaudeChannel) {
    if (version !== this.version) this.listed?.expire();
    if (channel !== this.channel) this.newest?.expire();
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

  /** The harness here, or on the host it is on, in the log. */
  private get named() {
    return this.o.host ? `${NAMES[this.o.harness]} on ${this.o.host}` : NAMES[this.o.harness];
  }

  /**
   * The model id an agent of this Claude Code's is given for `model`: for an alias whose family it
   * lists a newer model of than the alias names (or that it lists no model under), that newer one;
   * else `model` as it is.
   */
  model(model: string): string {
    const listed = this.listed?.last ?? [];
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
        await update();
      } catch (e) {
        error = messageOf(e);
        console.error(`Obeya: updating ${this.named} failed: ${error}`);
      }
      try {
        await this.look();
        if (this.version) console.log(`Obeya: ${this.named} is at ${this.version}`);
        // the models of the version it is at now, which the look had it asked for
        this.models();
        await this.listed?.fresh();
        if (this.o.settle && this.o.ready()) await this.o.settle();
      } catch {}
      this.updating = error ? { running: false, error } : undefined;
      this.o.changed();
    })();
  }

  /** What the view says of updating it: a newer version that is out, one under way, how it failed. */
  offer(): HarnessUpdate | undefined {
    const now = this.version;
    // npm is not asked for one that is not installed
    const newest = now ? this.newest?.get() : this.newest?.last;
    if (this.updating?.running) return { version: newest ?? '', running: true };
    if (!newest || !now || Bun.semver.order(newest, now) <= 0) return undefined;
    return { version: newest, ...(this.updating?.error ? { error: this.updating.error } : {}) };
  }

  /**
   * The models it lists as last heard (nothing before it first answered), asked again in the
   * background once that is a while ago or it changed (another version).
   */
  models(): ClaudeListed[] {
    return (this.o.ready() ? this.listed?.get() : this.listed?.last) ?? [];
  }
}

export class Harnesses extends Listeners {
  /** By harness, once looked at. */
  private found: Partial<Record<Harness, HarnessFound | null>> = {};
  private models: { at: number; list: Promise<HarnessModel[]> } | undefined;
  /** When each harness here was last looked at. */
  private lookedAt: Record<Harness, number> = { claude: Date.now(), codex: Date.now() };
  /** Each harness on this machine. */
  private here: Record<Harness, Install>;
  /**
   * Each harness on the hosts, by harness and host name: when it was last looked at there, whether
   * it is installed there.
   */
  private there = new Map<string, { host: HostHarness; install: Install; at: number; looking?: boolean; installed?: boolean }>();

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
      /** Updates Claude Code. */
      updateClaude?: () => Promise<void>;
      /** The newest Codex there is; none: no update is offered. */
      codexNewest?: () => Promise<string | undefined>;
      /** Updates Codex. */
      updateCodex?: () => Promise<void>;
      /** The harnesses on the hosts of the configuration, which are looked at too. */
      hosts?: () => HostHarness[];
    },
  ) {
    super();
    const changed = () => this.emit();
    this.here = {
      claude: new Install({
        harness: 'claude',
        ...(o.claudeModels ? { models: () => o.claudeModels!(o.cwd) } : {}),
        ...(o.claudeNewest ? { newest: o.claudeNewest } : {}),
        ...(o.updateClaude ? { update: o.updateClaude } : {}),
        look: async () => {
          const claude = await this.o.claude?.();
          this.lookedAt.claude = Date.now();
          if (claude !== undefined) this.set({ claude });
        },
        ready: () => this.ready('claude'),
        changed,
      }),
      codex: new Install({
        harness: 'codex',
        ...(o.codexNewest ? { newest: () => o.codexNewest!() } : {}),
        ...(o.updateCodex ? { update: o.updateCodex } : {}),
        look: async () => {
          const codex = await (this.o.codex ?? findCodex)();
          this.lookedAt.codex = Date.now();
          this.set({ codex });
        },
        // the menus have the new version's models once the line goes
        settle: () => this.codexModels(),
        ready: () => this.ready('codex'),
        changed,
      }),
    };
  }

  /** Looks at the harnesses again. */
  async refresh(): Promise<void> {
    this.lookedAt = { claude: Date.now(), codex: Date.now() };
    const [claude, codex] = await Promise.all([this.o.claude?.(), (this.o.codex ?? findCodex)()]);
    this.set({ ...(claude !== undefined ? { claude } : {}), codex });
  }

  /** What a look found (null: not installed). */
  set(found: Partial<Record<Harness, HarnessFound | null>>) {
    const before = this.found;
    this.found = { ...this.found, ...found };
    if (JSON.stringify(this.found) === JSON.stringify(before)) return;
    // another Codex may list other models
    if (!this.ready('codex') || this.found.codex?.version !== before.codex?.version) this.models = undefined;
    this.here.claude.found(this.found.claude?.version);
    this.here.codex.found(this.found.codex?.version);
    this.emit();
  }

  /**
   * Looks at the harnesses on the hosts of the configuration, in the background: at first, again
   * after ten minutes, and on a host that did not answer once it does.
   */
  lookAtHosts(): void {
    const hosts = this.o.hosts?.() ?? [];
    const keyOf = (h: HostHarness) => `${h.harness} ${h.name}`;
    for (const key of this.there.keys()) if (!hosts.some((h) => keyOf(h) === key)) this.there.delete(key);
    for (const host of hosts) {
      const key = keyOf(host);
      let on = this.there.get(key);
      if (!on || on.host !== host) {
        const look = async () => {
          const found = await host.look();
          const at = this.there.get(key);
          if (at?.host !== host) return;
          at.installed = !!found;
          at.install.found(found?.version, found?.channel);
        };
        const newest = host.harness === 'claude' ? this.o.claudeNewest : this.o.codexNewest;
        const install = new Install({
          harness: host.harness,
          host: host.name,
          ...(host.models ? { models: () => host.models!() } : {}),
          ...(newest ? { newest } : {}),
          update: () => host.update(),
          look,
          ready: () => !!this.there.get(key)?.installed,
          changed: () => this.emit(),
        });
        on = { host, install, at: 0 };
        this.there.set(key, on);
      }
      if (on.looking || !host.reachable() || Date.now() - on.at <= MODELS_FOR_MS) continue;
      const it = on;
      it.looking = true;
      it.at = Date.now();
      void (async () => {
        try {
          const version = it.install.version;
          await it.install.look();
          if (it.install.version !== version) this.emit();
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

  /** Each harness with what it offers, for the Configuration. */
  async view(): Promise<HarnessView[]> {
    // a harness updated on the command line meanwhile: the next view has it
    for (const h of HARNESSES) {
      if (Date.now() - this.lookedAt[h] <= MODELS_FOR_MS || (h === 'claude' && !this.o.claude)) continue;
      this.lookedAt[h] = Date.now();
      this.here[h].look().catch(() => {});
    }
    this.lookAtHosts();
    // the harness's default is no entry of its own: it is one of the models, which the owner picks by name
    const resolved = aliasesOf(this.here.claude.models());
    const claude: HarnessView = {
      id: 'claude',
      ready: this.ready('claude'),
      ...this.version('claude'),
      models: AGENT_MODELS.filter((id) => id !== 'default').map((id) => ({ id, ...(resolved[id] ? { resolved: resolved[id] } : {}) })),
      ...this.updates('claude'),
    };
    const listed = this.ready('codex') ? await this.codexModels() : [];
    const codex: HarnessView = { id: 'codex', ready: this.ready('codex'), ...this.version('codex'), models: newestOfFamilies(listed), ...this.updates('codex') };
    return [claude, codex];
  }

  private version(h: Harness) {
    const v = this.found[h]?.version;
    return v ? { version: v } : {};
  }

  /** A harness's update here, and its version and update on each host that has it. */
  private updates(h: Harness): Pick<HarnessView, 'update' | 'hosts'> {
    const update = this.here[h].offer();
    const hosts: HarnessHost[] = [];
    for (const on of this.there.values()) {
      const version = on.install.version;
      if (on.host.harness !== h || !version) continue;
      const offer = on.install.offer();
      hosts.push({ name: on.host.name, version, ...(offer ? { update: offer } : {}) });
    }
    return { ...(update ? { update } : {}), ...(hosts.length ? { hosts } : {}) };
  }

  /**
   * The model id an agent of Claude Code's is given for `model`, on this machine or the host named:
   * for an alias whose family that Claude Code lists a newer model of than the alias names (or that
   * it lists no model under), that newer one; else `model` as it is.
   */
  claudeModel(model: string, host?: string): string {
    const claude = host === undefined ? this.here.claude : this.there.get(`claude ${host}`)?.install;
    return claude ? claude.model(model) : model;
  }

  /**
   * Updates a harness, on this machine or the host named, in the background (`claude update`,
   * `codex update`), then looks at it again and asks for its models, so the next agents run on the
   * new version and the menus have its models once the view no longer says it is running; the view
   * also says how it failed.
   */
  update(harness: Harness, host?: string): void {
    (host === undefined ? this.here[harness] : this.there.get(`${harness} ${host}`)?.install)?.update();
  }

  private async codexModels(): Promise<HarnessModel[]> {
    if (!this.models || Date.now() - this.models.at > MODELS_FOR_MS) {
      const list = (this.o.codexModels ?? codexModels)(this.o.cwd).catch((e) => {
        console.warn(`Obeya: Codex did not list its models: ${messageOf(e)}`);
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
  const { q, close } = idleClaude(cwd, { settingSources: [] }, there);
  const timer = setTimeout(close, 30_000);
  try {
    return (await q.supportedModels()).map((m) => ({ value: m.value, ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}) }));
  } finally {
    clearTimeout(timer);
    close();
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
  return npmNewest('@anthropic-ai/claude-code', channel);
}

/** The newest Codex, as npm has it (its `latest`, which `codex update` installs whatever installed it). */
export const codexNewest = (): Promise<string | undefined> => npmNewest('@openai/codex', 'latest');

/** The version of `pkg` npm's dist-tag `tag` names. */
async function npmNewest(pkg: string, tag: string): Promise<string | undefined> {
  const res = await fetch(`https://registry.npmjs.org/-/package/${pkg}/dist-tags`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`npm answered ${res.status}`);
  const version = ((await res.json()) as Record<string, unknown>)[tag];
  return typeof version === 'string' ? version : undefined;
}

const onHosts = new WeakMap<SshHost, Record<Harness, HostHarness>>();

/** A host's harnesses, asked over its connection: the same ones for each host, which `Harnesses` knows them by. */
function onHost(host: SshHost): Record<Harness, HostHarness> {
  let them = onHosts.get(host);
  if (!them) {
    const reachable = () => !host.unreachable;
    them = {
      claude: { name: host.name, harness: 'claude', reachable, look: () => host.claude(), models: () => claudeModels('/', host), update: () => host.updateClaude() },
      codex: { name: host.name, harness: 'codex', reachable, look: () => host.codex(), update: () => host.updateCodex() },
    };
    onHosts.set(host, them);
  }
  return them;
}

/** Claude Code on a host, asked over its connection. */
export const hostClaude = (host: SshHost): HostHarness => onHost(host).claude;

/** Codex on a host, asked over its connection. */
export const hostCodex = (host: SshHost): HostHarness => onHost(host).codex;
