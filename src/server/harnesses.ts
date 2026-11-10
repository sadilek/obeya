// The harnesses Obeya runs agents on, as this machine has them: Claude Code and Codex, each
// installed or not, logged in or not. The setup assistant shows what it found (machine.ts) and tells
// this what it found; Obeya looks once as it starts. A group of agents the owner chose no harness for
// runs on Claude Code, unless only Codex is ready here. The Configuration lists each harness with the
// models it offers: Claude Code's aliases, and the models Codex lists for its login, of each family
// (`gpt-6.1-sol`, `gpt-5.6-sol`) only the newest, which stands for the family. Each with the version
// it runs on here: Codex's model ids carry it; which model an alias of Claude Code's stands for, an
// idle Claude Code session says, asked in the background so the menus never wait for it.

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

/** How long Codex's list of models is kept before it is asked again. */
const MODELS_FOR_MS = 10 * 60_000;

export class Harnesses {
  /** By harness, once looked at. */
  private found: Partial<Record<Harness, HarnessFound | null>> = {};
  private models: { at: number; list: Promise<HarnessModel[]> } | undefined;
  /** The models Claude Code's aliases stand for, as last heard, and when it was asked. */
  private aliases: { at: number; resolved: Partial<Record<AgentModel, string>>; asking?: true } | undefined;
  private listeners = new Set<() => void>();

  constructor(
    private o: {
      /** Where Codex is asked for its models. */
      cwd: string;
      /** Looks at Claude Code (the setup assistant's own check); none: it stays as found by `set`. */
      claude?: () => Promise<HarnessFound | null>;
      codex?: () => Promise<HarnessFound | null>;
      codexModels?: (cwd: string) => Promise<HarnessModel[]>;
      /** Asks Claude Code which model each of its aliases stands for; none: the aliases go without a version. */
      claudeAliases?: (cwd: string) => Promise<Partial<Record<AgentModel, string>>>;
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
    const claude = this.found.claude?.version;
    this.found = { ...this.found, ...found };
    if (JSON.stringify(this.found) === before) return;
    if (!this.ready('codex')) this.models = undefined;
    // another version of Claude Code may stand for other models; asked as Obeya starts, the menus have them at once
    if (this.aliases && this.found.claude?.version !== claude) this.aliases.at = 0;
    this.claudeAliases();
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
    // the harness's default is no entry of its own: it is one of the models, which the owner picks by name
    const resolved = this.claudeAliases();
    const claude: HarnessView = {
      id: 'claude',
      ready: this.ready('claude'),
      ...this.version('claude'),
      models: AGENT_MODELS.filter((id) => id !== 'default').map((id) => ({ id, ...(resolved[id] ? { resolved: resolved[id] } : {}) })),
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
   * What Claude Code's aliases stand for as last heard (nothing before it first answered), asked
   * again in the background once that is a while ago or Claude Code changed (another version).
   */
  private claudeAliases(): Partial<Record<AgentModel, string>> {
    const ask = this.o.claudeAliases;
    const known = this.aliases;
    if (ask && this.ready('claude') && !known?.asking && (!known || Date.now() - known.at > MODELS_FOR_MS)) {
      this.aliases = { at: known?.at ?? 0, resolved: known?.resolved ?? {}, asking: true };
      ask(this.o.cwd).then(
        (resolved) => (this.aliases = { at: Date.now(), resolved }),
        (e) => {
          console.warn(`Obeya: Claude Code did not list its models: ${e instanceof Error ? e.message : e}`);
          this.aliases = { at: Date.now(), resolved: known?.resolved ?? {} };
        },
      );
    }
    return known?.resolved ?? {};
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
 * Which model each of Claude Code's aliases stands for, from an idle Claude Code session in `cwd`
 * (without the owner's settings, hooks and MCP servers, and without a prompt) that lists its models.
 */
export async function claudeAliases(cwd: string): Promise<Partial<Record<AgentModel, string>>> {
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
    return aliasesOf(await q.supportedModels());
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/**
 * The model each alias stands for, from the models Claude Code lists: the one it lists under the
 * alias, else the newest of the alias's family it lists (it may list `fable` only by its id).
 */
export function aliasesOf(listed: { value: string; resolvedModel?: string }[]): Partial<Record<AgentModel, string>> {
  const out: Partial<Record<AgentModel, string>> = {};
  const number = (id: string) => (modelVersion(id) ?? '0').split('.').map(Number);
  const newer = (a: number[], b: number[]) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0);
  for (const alias of AGENT_MODELS) {
    if (alias === 'default') continue;
    const own = listed.find((m) => m.value === alias)?.resolvedModel;
    const family = listed.map((m) => m.resolvedModel ?? m.value).filter((id) => modelName(id).toLowerCase().startsWith(`${alias} `));
    const newest = family.sort((a, b) => newer(number(b), number(a)))[0];
    const id = own ?? newest;
    if (id) out[alias] = id;
  }
  return out;
}
