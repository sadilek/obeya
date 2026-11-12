// The agents Obeya runs: their roles, harnesses, models and efforts, and how a Codex family resolves to a model.

/** The agents Obeya runs, grouped as the owner sets their harness, model and effort (`src/server/settings.ts`). */
export const AGENT_ROLES = ['coordinator', 'worker', 'explorer', 'chores'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
/** The coding agents Obeya runs its agents on, each on the machine's own installation and login. */
export const HARNESSES = ['claude', 'codex'] as const;
export type Harness = (typeof HARNESSES)[number];
/** Claude Code's models a setting may name: its default, or one of its aliases, each the newest of its family; the menus offer the aliases. */
export const AGENT_MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
/**
 * The harness, model and effort a group of agents runs with. `model`: for Claude Code one of
 * `AGENT_MODELS` (`default` for its own default); for Codex a model family (`codexFamily`), which
 * each start resolves to the newest model of that family the machine the agent runs on lists.
 */
export interface AgentSetting {
  harness: Harness;
  model: string;
  effort: AgentEffort;
}
/**
 * What the owner chose for one card's agent, over the workers' group's (`Item.agent`): a harness with
 * a model (`model` as in `AgentSetting`), an effort, or both; what is left out is the group's.
 */
export interface CardAgent {
  harness?: Harness;
  model?: string;
  effort?: AgentEffort;
}
/** A Codex model as a setting may name it: a family (`gpt-#-sol`, one `#` where the version was), or a model id Codex lists (`gpt-6.1-sol`), read as its family. */
export const CODEX_MODEL = /^(?=[^#]*#?[^#]*$)(?!#$)[A-Za-z0-9#][\w.:#-]{0,79}$/;
/** The Codex family a group runs on until the owner chooses another: Sol. */
export const CODEX_PRESET = 'gpt-#-sol';
/** A Codex model id's family and version: `gpt-6.1-sol` is `gpt-#-sol` 6.1; none for an id without a number. */
function codexVersion(id: string): { family: string; version: number[] } | null {
  const m = /^(\D*?)(\d+(?:\.\d+)*)(.*)$/.exec(id);
  return m ? { family: `${m[1]}#${m[3]}`, version: m[2]!.split('.').map(Number) } : null;
}
/**
 * The Codex family a setting names: a family as it is, a model id's family (`gpt-6.1-sol` is
 * `gpt-#-sol`; an id without a number is a family of its own), `default` the preset's.
 */
export function codexFamily(model: string): string {
  if (model === 'default') return CODEX_PRESET;
  if (model.includes('#')) return model;
  return codexVersion(model)?.family ?? model;
}
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};
/** Of each family Codex lists, the newest model (`gpt-6.1-sol`, not `gpt-5.6-sol` beside it), in Codex's order. */
export function newestOfFamilies<M extends { id: string }>(models: M[]): M[] {
  const newest = new Map<string, { id: string; version: number[] }>();
  for (const m of models) {
    const f = codexVersion(m.id);
    const known = f && newest.get(f.family);
    if (f && (!known || newer(f.version, known.version))) newest.set(f.family, { id: m.id, version: f.version });
  }
  return models.filter((m) => {
    const f = codexVersion(m.id);
    return !f || newest.get(f.family)?.id === m.id;
  });
}
/** The model a setting stores for a harness: for Codex its family, for Claude Code the alias as it is. */
export const storedModel = (harness: Harness, model: string): string => (harness === 'codex' ? codexFamily(model) : model);
/** A card's own choice as stored with it, a Codex model as its family (an id or `default` stored before reads so). */
export function cardAgentOf(stored: string): CardAgent {
  const agent = JSON.parse(stored) as CardAgent;
  return agent.harness && agent.model ? { ...agent, model: storedModel(agent.harness, agent.model) } : agent;
}
/** Whether `model` is one a group on `harness` may run with: Claude Code's aliases are no Codex model, but for the default. */
export const modelFits = (harness: Harness, model: string): boolean =>
  harness === 'claude' ? AGENT_MODELS.some((m) => m === model) : CODEX_MODEL.test(model) && (model === 'default' || !AGENT_MODELS.some((m) => m === model));
/** What applies until the owner chooses otherwise: Opus throughout, high effort for workers and exploration agents. */
export const AGENT_DEFAULTS: Record<AgentRole, AgentSetting> = {
  coordinator: { harness: 'claude', model: 'opus', effort: 'medium' },
  worker: { harness: 'claude', model: 'opus', effort: 'high' },
  explorer: { harness: 'claude', model: 'opus', effort: 'high' },
  chores: { harness: 'claude', model: 'opus', effort: 'medium' },
};
/** The default of a group on a harness: the preset's effort, with the harness's preset model (Codex's Sol family). */
export function agentDefault(role: AgentRole, harness: Harness): AgentSetting {
  const preset = AGENT_DEFAULTS[role];
  return harness === preset.harness ? preset : { harness, model: CODEX_PRESET, effort: preset.effort };
}

/**
 * A model by the name people know it by: Claude's ids by family and version (`claude-opus-5-5` is
 * Opus 5.5, `claude-3-5-haiku-20241022` Haiku 3.5), any other as its harness names it.
 */
export function modelName(model: string): string {
  const m = /^claude-(?:(\d+)-(?:(\d)-)?)?([a-z]+)(?:-(\d+)(?:-(\d))?)?(?:-\d{8})?(?:\[\w+\])?$/.exec(model);
  if (!m || (!m[1] && !m[4])) return model;
  const [major, minor] = m[1] ? [m[1], m[2]] : [m[4], m[5]];
  return `${m[3]![0]!.toUpperCase()}${m[3]!.slice(1)} ${major}${minor ? `.${minor}` : ''}`;
}

/**
 * A model id's version as people know it: `claude-opus-5-5` 5.5, `gpt-6.1-sol` 6.1; none for an id
 * without a number.
 */
export function modelVersion(id: string): string | undefined {
  const name = modelName(id);
  if (name !== id) return name.slice(name.lastIndexOf(' ') + 1);
  return codexVersion(id)?.version.join('.');
}

/** A model a harness offers, as the Configuration lists it. */
export interface HarnessModel {
  id: string;
  /** Its name as the harness gives it; absent for Claude Code's aliases, which the page names itself. */
  name?: string;
  /** The model a Claude Code alias stands for here (`opus`: `claude-opus-5-5`), the newest of its family Claude Code lists, once it has said. */
  resolved?: string;
  /** The efforts it takes, where the harness says (Codex); absent: all of `AGENT_EFFORTS`. */
  efforts?: AgentEffort[];
  /** The one the harness takes by default (Codex's), which a family no longer listed runs on. */
  isDefault?: true;
}

/**
 * A model as the pickers offer it (the Configuration's and a card's): `value` is what a setting stores
 * (Claude Code's alias, a Codex family), `name` the Codex family's name (`codexFamilyName`; absent
 * for Claude Code, whose aliases the page names itself), the efforts its newest model here takes.
 */
export interface ModelChoice {
  value: string;
  name?: string;
  /** The version it runs on here (`5.5`), shown after the name; absent where unknown or the name holds it. */
  version?: string;
  efforts: readonly AgentEffort[];
}

/**
 * The models a picker offers on a harness, with the one chosen (`chosen`, as stored) among them even
 * where the harness no longer lists it. Codex's are its families, each named without a version, which `version` carries.
 */
export function modelChoices(harness: HarnessView | undefined, chosen?: string): ModelChoice[] {
  const codex = harness?.id === 'codex';
  const listed: ModelChoice[] = newestOfFamilies(harness?.models ?? []).map((m) => {
    const name = codex ? codexFamilyName(codexFamily(m.id), m.name ?? m.id) : undefined;
    // a family named by its newest model (`o3`) has its version in the name already
    const version = modelVersion(codex ? m.id : (m.resolved ?? ''));
    return {
      value: codex ? codexFamily(m.id) : m.id,
      ...(name !== undefined ? { name } : {}),
      ...(version && !name?.includes(version) ? { version } : {}),
      efforts: m.efforts ?? AGENT_EFFORTS,
    };
  });
  if (chosen === undefined || listed.some((c) => c.value === chosen)) return listed;
  return [...listed, { value: chosen, ...(codex ? { name: codexFamilyName(chosen) } : {}), efforts: AGENT_EFFORTS }];
}

/**
 * A Codex family by the name people know it by, without a version, as Claude Code's aliases are
 * named: what follows the version (`gpt-#-sol` is Sol, `gpt-#-codex-max` Codex Max); a family named
 * only by its version (`gpt-#`, `o#`) by its newest model's name here (`newest`), else its key without the version.
 */
export function codexFamilyName(family: string, newest?: string): string {
  const after = /#[-.]?([A-Za-z].*)$/.exec(family)?.[1];
  if (after) return after.split(/[-_.]/).filter(Boolean).map((w) => `${w[0]!.toUpperCase()}${w.slice(1)}`).join(' ');
  return newest ?? family.replace(/[-.]?#/, '');
}

/** A harness as this machine has it: installed, logged in, and the models it offers. */
export interface HarnessView {
  id: Harness;
  /** Installed and logged in: agents can run on it. */
  ready: boolean;
  /** Its version, once found. */
  version?: string;
  /** The models it offers to choose from: Claude Code's aliases; Codex's, of each family the newest. */
  models: HarnessModel[];
  /** Its update on this machine. */
  update?: HarnessUpdate;
  /** It on each other machine of the configuration (hosts) that answered with its version. */
  hosts?: HarnessHost[];
}

/**
 * A harness's update: the newer version that is out (`version`), the update under way
 * (`running`), or why the last one failed (`error`); absent while it is the newest.
 */
export interface HarnessUpdate {
  version: string;
  running?: true;
  error?: string;
}

/** A harness on a host: the version it is at there, and its update. */
export interface HarnessHost {
  name: string;
  version: string;
  update?: HarnessUpdate;
}

/** The harness, model and effort of each group of agents, as they apply (`settings.json` over `AGENT_DEFAULTS`). */
export interface AgentsView {
  file: string;
  agents: Record<AgentRole, AgentSetting>;
  harnesses: HarnessView[];
  /** What a group the owner chose nothing for runs on here: Claude Code, unless only Codex is ready. */
  preset: Harness;
}
