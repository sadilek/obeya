// Obeya's own settings, in `settings.json` under its home beside `canvases.json` and `demo.json`:
// the language of Obeya's interface and the one its agents talk to the owner in, light or dark, the harness, model and effort of each group of
// agents, how other devices reach Obeya (remote.ts), whether the bar shows the plan's usage limits (usage.ts), and whether the page shows what the agents cost. The owner chooses them in the settings sheet;
// until then the system's language and look apply, the agents run as `AGENT_DEFAULTS` says, and
// no other device reaches Obeya. Saving restarts nothing: the page loads again in the new
// language, takes the new look at once, and the server reads the file whenever it needs the
// language or starts an agent.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chosenConversationLanguage, chosenLanguage, conversationLanguageIn, OWNER_SETTINGS_FILE as SETTINGS_FILE, ownerLanguageIn, ownerSettingsWritten, systemLanguage } from '../../plugin/skills/demo/lib/language.ts';
import { type Language, LANGUAGES } from '../core/locale';
import { AGENT_DEFAULTS, AGENT_EFFORTS, AGENT_MODELS, AGENT_ROLES, agentDefault, type AgentEffort, type AgentRole, type AgentSetting, type AgentsView, type CostsView, type Harness, HARNESSES, type HarnessView, modelFits, storedModel, type LanguageView, type RemoteSetting, type Theme, THEMES, type ThemeView, type UsageMeterView } from '../core/types';
import { BadRequest } from './board';

interface Settings {
  /** The interface's: Obeya's own words. */
  language?: Language;
  /** The agents' to the owner until the owner's words say otherwise; absent, the interface's. */
  conversationLanguage?: Language;
  /** Light or dark; absent follows the system. */
  theme?: Theme;
  /** Only what differs from `AGENT_DEFAULTS`, so a changed default reaches what the owner left. */
  agents?: Partial<Record<AgentRole, Chosen>>;
  /** How other devices reach Obeya; absent, they do not. */
  remote?: RemoteSetting;
  /** `false`: the bar does not show the plan's usage limits; absent, it does. */
  usageMeter?: false;
  /** `true`: the page shows what the agents cost; absent, it does not (they are counted either way). */
  costs?: true;
}

function read(home: string): Settings {
  try {
    const o = JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8')) as Record<string, unknown>;
    const language = LANGUAGES.find((l) => l === o.language);
    const conversationLanguage = LANGUAGES.find((l) => l === o.conversationLanguage);
    const theme = THEMES.find((x) => x === o.theme);
    return { ...o, language, conversationLanguage, theme, agents: agentsOf(o.agents), remote: remoteOf(o.remote) ?? undefined, usageMeter: o.usageMeter === false ? false : undefined, costs: o.costs === true ? true : undefined };
  } catch {
    return {};
  }
}

export function languageView(home: string, system = systemLanguage()): LanguageView {
  const chosen = chosenLanguage(home) ?? null;
  const language = chosen ?? system;
  const conversationChosen = chosenConversationLanguage(home) ?? null;
  return { file: join(home, SETTINGS_FILE), chosen, system, language, conversationChosen, conversation: conversationChosen ?? language };
}

/** The interface language that applies: the owner's choice, else the system's. */
export const ownerLanguage = ownerLanguageIn;

/** The conversation language that applies: the owner's choice, else the interface language. */
export const conversationLanguage = conversationLanguageIn;

/**
 * Saves the owner's choice of the interface language (`language`) or the conversation language
 * (`conversation`), whichever the input names; `null` follows the system, or the interface, again.
 * Other settings in the file stay.
 */
export function saveLanguage(home: string, input: unknown): LanguageView {
  const given = (input && typeof input === 'object' ? input : {}) as { language?: unknown; conversation?: unknown };
  const valid = (v: unknown) => v === null || LANGUAGES.some((l) => l === v);
  if (!('language' in given) && !('conversation' in given)) throw new BadRequest('invalid', 'name language or conversation');
  for (const key of ['language', 'conversation'] as const)
    if (key in given && !valid(given[key])) throw new BadRequest('invalid', `${key} must be one of ${LANGUAGES.join(', ')} or null`);
  if ('language' in given) save(home, 'language', given.language as Language | null, `language ${given.language ?? 'of the system'}`);
  if ('conversation' in given) save(home, 'conversationLanguage', given.conversation as Language | null, `conversation language ${given.conversation ?? 'of the interface'}`);
  return languageView(home);
}

export const themeView = (home: string): ThemeView => ({ file: join(home, SETTINGS_FILE), chosen: read(home).theme ?? null });

/** Saves light or dark; `null` follows the system again. Other settings in the file stay. */
export function saveTheme(home: string, input: unknown): ThemeView {
  const theme = (input as { theme?: unknown } | null)?.theme;
  if (theme !== null && !THEMES.some((x) => x === theme)) throw new BadRequest('invalid', `theme must be one of ${THEMES.join(', ')} or null`);
  save(home, 'theme', theme as Theme | null, `${theme ?? "the system's"} look`);
  return themeView(home);
}

export const usageMeterView = (home: string): UsageMeterView => ({ file: join(home, SETTINGS_FILE), on: read(home).usageMeter !== false });

/** Saves whether the bar shows the plan's usage limits (`{ on }`). Other settings in the file stay. */
export function saveUsageMeter(home: string, input: unknown): UsageMeterView {
  const on = (input as { on?: unknown } | null)?.on;
  if (typeof on !== 'boolean') throw new BadRequest('invalid', 'on must be true or false');
  save(home, 'usageMeter', on ? null : false, `usage limits ${on ? 'shown' : 'not shown'} in the bar,`);
  return usageMeterView(home);
}

export const costsView = (home: string): CostsView => ({ file: join(home, SETTINGS_FILE), on: read(home).costs === true });

/** Saves whether the page shows what the agents cost (`{ on }`). Other settings in the file stay. */
export function saveCosts(home: string, input: unknown): CostsView {
  const on = (input as { on?: unknown } | null)?.on;
  if (typeof on !== 'boolean') throw new BadRequest('invalid', 'on must be true or false');
  save(home, 'costs', on ? true : null, `costs ${on ? 'shown' : 'not shown'},`);
  return costsView(home);
}

/** Saves one of the owner's choices, or with `null` takes it out; the other settings in the file stay. */
function save<K extends 'language' | 'conversationLanguage' | 'theme' | 'remote' | 'usageMeter' | 'costs'>(home: string, key: K, value: Settings[K] | null, what: string) {
  write(home, { ...read(home), [key]: value ?? undefined });
  console.log(`Obeya: ${what} saved to ${join(home, SETTINGS_FILE)}`);
}

function write(home: string, settings: Settings) {
  const { agents, ...rest } = settings;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, SETTINGS_FILE), `${JSON.stringify(agents && Object.keys(agents).length ? { ...rest, agents } : rest, null, 2)}\n`);
  ownerSettingsWritten(home);
}

/** What the file says of a group: what differs from the preset. */
type Chosen = Partial<AgentSetting>;

/**
 * The known choices in a file's `agents`: a harness chosen, and a model and effort that differ from
 * the defaults; anything else in it is left out. A model differs from its harness's preset (the
 * harness named, else Claude Code's), and only one that harness takes; a Codex model is its family
 * (a model id or `default` written before reads as one).
 */
function agentsOf(input: unknown): Partial<Record<AgentRole, Chosen>> {
  const o = { ...((input && typeof input === 'object' ? input : {}) as Record<string, { harness?: unknown; model?: unknown; effort?: unknown } | undefined>) };
  // the Coordinator's choice, written as `koordinator` (its German name) before it was renamed
  o.coordinator ??= o.koordinator;
  const agents: Partial<Record<AgentRole, Chosen>> = {};
  for (const role of AGENT_ROLES) {
    // a harness chosen stays, Claude Code too: otherwise the fallback would take its place on a machine with only Codex ready
    const harness = HARNESSES.find((h) => h === o[role]?.harness);
    const on = harness ?? AGENT_DEFAULTS[role].harness;
    const given = o[role]?.model;
    const fits = typeof given === 'string' && modelFits(on, given) ? storedModel(on, given) : undefined;
    const model = fits !== agentDefault(role, on).model ? fits : undefined;
    const effort = AGENT_EFFORTS.find((e) => e === o[role]?.effort && e !== AGENT_DEFAULTS[role].effort);
    if (harness || model || effort) agents[role] = { ...(harness ? { harness } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  return agents;
}

/**
 * The harness, model and effort a group of agents runs with: the owner's choice, else the default;
 * read whenever one starts. `fallback`: the harness of a group the owner chose none for (Claude Code,
 * unless this machine has only Codex). A model the harness does not take is its default.
 */
export function agentSetting(home: string, role: AgentRole, fallback: Harness = AGENT_DEFAULTS[role].harness): AgentSetting {
  const chosen = read(home).agents?.[role] ?? {};
  const harness = chosen.harness ?? fallback;
  const preset = agentDefault(role, harness);
  // a model chosen is one of the harness chosen with it, Claude Code's where none was
  const model = chosen.model && (chosen.harness ?? AGENT_DEFAULTS[role].harness) === harness && modelFits(harness, chosen.model) ? storedModel(harness, chosen.model) : preset.model;
  return { harness, model, effort: chosen.effort ?? preset.effort };
}

/** Each group's setting, with the harnesses this machine has (`Harnesses.view`). */
export function agentsView(home: string, harnesses: HarnessView[] = [], fallback?: Harness): AgentsView {
  const agents = Object.fromEntries(AGENT_ROLES.map((r) => [r, agentSetting(home, r, fallback)])) as Record<AgentRole, AgentSetting>;
  return { file: join(home, SETTINGS_FILE), agents, harnesses, preset: fallback ?? 'claude' };
}

/**
 * Saves the choices for the groups given (`{ worker: { harness: 'codex' } }`). A harness chosen
 * without a model takes that harness's preset model; a Codex model is saved as its family (a model
 * id given saves the family it belongs to). Other groups and settings in the file stay.
 */
export function saveAgents(home: string, input: unknown, harnesses: HarnessView[] = [], fallback?: Harness): AgentsView {
  const given = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const settings = read(home);
  const agents: Partial<Record<AgentRole, Chosen>> = { ...settings.agents };
  for (const [role, choice] of Object.entries(given)) {
    if (!AGENT_ROLES.some((r) => r === role)) throw new BadRequest('invalid', `agents are one of ${AGENT_ROLES.join(', ')}`);
    const r = role as AgentRole;
    const { harness, model, effort, ...other } = (choice && typeof choice === 'object' ? choice : {}) as Record<string, unknown>;
    if (Object.keys(other).length) throw new BadRequest('invalid', 'a choice has a harness, a model and an effort');
    if (harness !== undefined && !HARNESSES.some((h) => h === harness)) throw new BadRequest('invalid', `harness must be one of ${HARNESSES.join(', ')}`);
    const before = agentSetting(home, r, fallback);
    const on = (harness as Harness | undefined) ?? before.harness;
    if (model !== undefined && (typeof model !== 'string' || !modelFits(on, model))) throw new BadRequest('invalid', on === 'claude' ? `model must be one of ${AGENT_MODELS.join(', ')}` : 'model must be a Codex model family or id');
    if (effort !== undefined && !AGENT_EFFORTS.some((e) => e === effort)) throw new BadRequest('invalid', `effort must be one of ${AGENT_EFFORTS.join(', ')}`);
    // another harness starts from its own default model
    const next = model !== undefined ? storedModel(on, model as string) : on === before.harness ? before.model : agentDefault(r, on).model;
    // the harness is kept once chosen, or where the group runs on another than the preset's
    const keep = harness !== undefined || settings.agents?.[r]?.harness !== undefined || on !== AGENT_DEFAULTS[r].harness;
    agents[r] = { ...(keep ? { harness: on } : {}), model: next as string, effort: (effort as AgentEffort | undefined) ?? before.effort };
  }
  write(home, { ...settings, agents: agentsOf(agents) });
  console.log(`Obeya: harness, model and effort of the agents saved to ${join(home, SETTINGS_FILE)}`);
  return agentsView(home, harnesses, fallback);
}

/** A setting for other devices as the file or the page gives it; `null` for none or one Obeya cannot use. */
export function remoteOf(input: unknown): RemoteSetting | null {
  const o = (input && typeof input === 'object' ? input : {}) as { via?: unknown; address?: unknown; awake?: unknown };
  const awake = o.awake === 'always' ? { awake: 'always' as const } : {};
  if (o.via === 'tailscale') return { via: 'tailscale', ...awake };
  if (o.via === 'address' && typeof o.address === 'string' && o.address.trim()) return { via: 'address', address: o.address.trim(), ...awake };
  return null;
}

/** How other devices reach Obeya, as the owner set it; `null`: they do not. */
export const remoteSetting = (home: string): RemoteSetting | null => read(home).remote ?? null;

/** Saves how other devices reach Obeya (`{ remote }`); `null` turns it off. Other settings in the file stay. */
export function saveRemote(home: string, input: unknown): RemoteSetting | null {
  const given = (input as { remote?: unknown } | null)?.remote;
  const remote = given === null ? null : remoteOf(given);
  if (given !== null && !remote) throw new BadRequest('invalid', 'remote must be null, { via: "tailscale" } or { via: "address", address }, each with an optional awake: "always"');
  save(home, 'remote', remote, `other devices ${remote ? `reach it ${remote.via === 'tailscale' ? 'through Tailscale' : `at ${remote.address}`}` : 'do not reach it'},`);
  return remote;
}
