// Obeya's own settings, in `settings.json` under its home beside `canvases.json` and `demo.json`:
// the language Obeya speaks to the owner, and the model and effort of each group of agents. The
// owner chooses them in the settings sheet; until then the system's language applies, and each job
// keeps the model and effort Obeya gives it. Saving restarts nothing: the page loads again in the
// new language, and the server reads the file whenever it needs the language or starts an agent.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_SETTINGS_FILE, systemLanguage } from '../../plugin/skills/demo/lib/language.ts';
import { type Language, LANGUAGES } from '../core/locale';
import { AGENT_EFFORTS, AGENT_MODELS, AGENT_ROLES, type AgentChoice, type AgentRole, type AgentsView, type LanguageView } from '../core/types';
import { BadRequest } from './board';

export { systemLanguage };

export const SETTINGS_FILE = OWNER_SETTINGS_FILE;

interface Settings {
  language?: Language;
  agents?: Partial<Record<AgentRole, AgentChoice>>;
}

function read(home: string): Settings {
  try {
    const o = JSON.parse(readFileSync(join(home, SETTINGS_FILE), 'utf8')) as Record<string, unknown>;
    const language = LANGUAGES.find((l) => l === o.language);
    return { ...o, ...(language ? { language } : { language: undefined }), agents: agentsOf(o.agents) };
  } catch {
    return {};
  }
}

export function languageView(home: string, system = systemLanguage()): LanguageView {
  const chosen = read(home).language ?? null;
  return { file: join(home, SETTINGS_FILE), chosen, system, language: chosen ?? system };
}

/** The language that applies: the owner's choice, else the system's. */
export const ownerLanguage = (home: string) => languageView(home).language;

/** Saves the owner's choice; `null` follows the system again. Other settings in the file stay. */
export function saveLanguage(home: string, input: unknown): LanguageView {
  const language = (input as { language?: unknown } | null)?.language;
  if (language !== null && !LANGUAGES.some((l) => l === language)) throw new BadRequest('invalid', `language must be one of ${LANGUAGES.join(', ')} or null`);
  const { language: _, ...rest } = existsSync(join(home, SETTINGS_FILE)) ? read(home) : {};
  write(home, language ? { ...rest, language: language as Language } : rest);
  console.log(`Obeya: language ${language ?? 'of the system'} saved to ${join(home, SETTINGS_FILE)}`);
  return languageView(home);
}

function write(home: string, settings: Settings) {
  const { agents, ...rest } = settings;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, SETTINGS_FILE), `${JSON.stringify(agents && Object.keys(agents).length ? { ...rest, agents } : rest, null, 2)}\n`);
}

/** The known choices in a file's `agents`; anything else in it is left out. */
function agentsOf(input: unknown): Partial<Record<AgentRole, AgentChoice>> {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, { model?: unknown; effort?: unknown } | undefined>;
  const agents: Partial<Record<AgentRole, AgentChoice>> = {};
  for (const role of AGENT_ROLES) {
    const model = AGENT_MODELS.find((m) => m === o[role]?.model);
    const effort = AGENT_EFFORTS.find((e) => e === o[role]?.effort);
    if (model || effort) agents[role] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  return agents;
}

export function agentsView(home: string): AgentsView {
  const agents = read(home).agents ?? {};
  return { file: join(home, SETTINGS_FILE), chosen: Object.fromEntries(AGENT_ROLES.map((r) => [r, agents[r] ?? {}])) as Record<AgentRole, AgentChoice> };
}

/** The model and effort the owner chose for a group of agents; read whenever one starts. */
export const agentChoice = (home: string, role: AgentRole): AgentChoice => read(home).agents?.[role] ?? {};

/**
 * Saves the choices for the groups given (`{ worker: { model: 'opus' } }`); a model or effort left
 * out or `null` is Obeya's own again. Other groups and settings in the file stay.
 */
export function saveAgents(home: string, input: unknown): AgentsView {
  const given = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  for (const [role, choice] of Object.entries(given)) {
    if (!AGENT_ROLES.some((r) => r === role)) throw new BadRequest('invalid', `agents are one of ${AGENT_ROLES.join(', ')}`);
    const { model, effort, ...other } = (choice && typeof choice === 'object' ? choice : {}) as Record<string, unknown>;
    if (Object.keys(other).length) throw new BadRequest('invalid', 'a choice has a model and an effort');
    if (model != null && !AGENT_MODELS.some((m) => m === model)) throw new BadRequest('invalid', `model must be one of ${AGENT_MODELS.join(', ')} or null`);
    if (effort != null && !AGENT_EFFORTS.some((e) => e === effort)) throw new BadRequest('invalid', `effort must be one of ${AGENT_EFFORTS.join(', ')} or null`);
  }
  const settings = existsSync(join(home, SETTINGS_FILE)) ? read(home) : {};
  write(home, { ...settings, agents: agentsOf({ ...settings.agents, ...given }) });
  console.log(`Obeya: models and effort of the agents saved to ${join(home, SETTINGS_FILE)}`);
  return agentsView(home);
}
