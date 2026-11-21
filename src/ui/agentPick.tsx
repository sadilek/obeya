// The harness, model and effort a card's agents run on (its worker, an idea's exploration agent):
// each role's setting until the owner picks another for this card, which then goes with every
// session of each of them. One picker under the card's buttons names it, whichever button starts the
// agent, and changes it in one place. One component for every card that starts an agent.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CardAction, Item } from '../core/types';
import { AGENT_EFFORTS, type AgentEffort, type AgentModel, type AgentsView, byFamily, type HarnessUpdate as HarnessUpdateState, type CardAgent, type Harness, HARNESSES, modelChoices, type ModelChoice, modelName } from '../core/agents';
import { useMenuClose, usePlaced } from './menu';
import { api, failText } from './api';
import { usePoll } from './act';
import { useAsked } from './asked';
import { phoneView } from './phone';
import { onThisMachine } from './reauthenticate';
import { t } from './strings';

/** The harnesses and the workers' group as last heard, shown at once by the next card while it asks again. */
let last: AgentsView | null = null;
const agentsView = () => api.agents().then((v) => (last = v));

/** A model as a picker names it, without its version: Claude's by Obeya's names for them, Codex's and Gemini's by their family's name, else its id. */
export const modelLabel = (harness: Harness, m: Pick<ModelChoice, 'value' | 'name'>) => (harness === 'claude' ? (t.config.agents.models[m.value as AgentModel] ?? m.value) : (m.name ?? m.value));

/** The efforts a model of `choices` takes; every effort for one that does not say. */
export const effortsOf = (choices: ModelChoice[], model: string) => choices.find((m) => m.value === model)?.efforts ?? AGENT_EFFORTS;

/** A harness and model as the owner knows them: "Claude Code · Opus", "Codex · Sol", "Gemini · Neon" (a family by its name, without a version). */
export function agentLabel(view: AgentsView | null, harness: Harness, model: string): string {
  if (harness === 'claude' && model === 'default') return t.config.agents.models.default;
  const choice = byFamily(harness) ? modelChoices(view?.harnesses.find((h) => h.id === harness), model).find((c) => c.value === model) : undefined;
  return `${t.harnesses[harness]} · ${modelLabel(harness, choice ?? { value: model })}`;
}

/** The card's choice without what is empty; nothing left: the groups' again. */
const choice = (c: CardAgent): CardAgent | null => (c.harness || c.effort ? c : null);

/** The agent of a card a menu is for: its worker, or an idea's exploration agent, each with its group's setting where the card chose nothing. */
export type CardRole = 'worker' | 'explorer';

/** What the card chose of its own, as its line names it ("Codex · Sol · effort very high"); empty without a choice. */
export const chosenLabel = (view: AgentsView | null, agent: CardAgent | undefined): string =>
  [agent?.harness && agent.model ? agentLabel(view, agent.harness, agent.model) : '', agent?.effort ? t.agentPick.chosenEffort(t.config.agents.efforts[agent.effort]) : ''].filter(Boolean).join(' · ');

/**
 * The card's choice as a menu of `role` shows and changes it: what it runs on (the card's choice over
 * the group's setting), and picks that save the card's choice through `act`. What equals the group's
 * setting is no choice of the card's: it follows that setting. `saving` while a pick is on its way.
 */
function useCardChoice(item: Item, role: CardRole, act: (a: CardAction) => Promise<void>) {
  const [view, setView] = useAgentsView();
  // a start while the choice is still on its way would run on the one before
  const [saving, setSaving] = useState(false);
  if (!view) return null;
  const group = view.agents[role];
  const own = item.agent ?? {};
  const listed = (h: Harness) => view.harnesses.find((x) => x.id === h);
  // the card's own choice, where it names a harness and model
  const mine = own.harness && own.model ? { harness: own.harness, model: own.model } : null;
  const { harness, model } = mine ?? group;
  // each harness's models as the Configuration lists them, the one checked among them even where no longer listed
  const choices = (h: Harness) => modelChoices(listed(h), harness === h ? model : undefined);
  const save = (next: CardAgent | null) => {
    if (JSON.stringify(next) === JSON.stringify(item.agent ?? null)) return;
    setSaving(true);
    act({ action: 'agent', agent: next })
      .catch(() => {})
      .finally(() => setSaving(false));
  };
  const pickModel = (h: Harness, m: string) => {
    const mine = h !== group.harness || m !== group.model;
    // an effort the new model does not take goes back to the group's
    const kept = own.effort && effortsOf(choices(h), m).includes(own.effort) ? own.effort : undefined;
    save(choice({ ...(mine ? { harness: h, model: m } : {}), ...(kept ? { effort: kept } : {}) }));
  };
  const pickEffort = (e: AgentEffort) => save(choice({ ...mine, ...(e !== group.effort ? { effort: e } : {}) }));
  const on: OnModel = { harness, model, effort: own.effort ?? group.effort };
  return { view, setView, on, pickModel, pickEffort, saving };
}

/** The agent a card's buttons start first: an idea's (or a proposed idea's) exploration agent, else its worker. */
const firstRole = (item: Item): CardRole => (item.state === 'idea' || (item.state === 'proposal' && item.proposal?.idea) ? 'explorer' : 'worker');

/**
 * Among a card's buttons, on every card whose buttons start an agent: a small button with an icon
 * that names on hover what the agent runs on, whichever of them starts it ("Start agent", "Discuss as
 * an idea", "Plan as a project", "Build it like this"; where the other role's setting differs, that
 * too), and opens the menu of harnesses, models and efforts that changes the card's choice in this
 * one place. Only while the card has a choice of its own does it name it, with a × back to the
 * settings.
 */
export function AgentChoice({ item, act }: { item: Item; act: (a: CardAction) => Promise<void> }) {
  const role = firstRole(item);
  const pick = useCardChoice(item, role, act);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  usePlaced(open, menu, () => box.current!.getBoundingClientRect());
  useMenuClose(open, [box, menu], () => setOpen(false), true);
  if (!pick || item.kind === 'project') return null;
  const { view, setView, on, pickModel, pickEffort, saving } = pick;
  const p = t.agentPick;
  const own = item.agent ?? {};
  // the other role runs on its own setting where the card chose no harness and model, with the card's effort where it chose one
  const other: CardRole = role === 'explorer' ? 'worker' : 'explorer';
  const group = view.agents[other];
  const second: OnModel = own.harness && own.model ? on : { harness: group.harness, model: group.model, effort: own.effort ?? group.effort };
  const differs = second.harness !== on.harness || second.model !== on.model || second.effort !== on.effort;
  const label = onModelLabel(view, on);
  const says = [`${p.runsOn} ${label}`, differs ? p.other[other](onModelLabel(view, second)) : ''].filter(Boolean).join(', ');
  const chosen = !!item.agent;
  return (
    <span className={['agent-choice', chosen && 'chosen', saving && 'saving'].filter(Boolean).join(' ')} ref={box}>
      <button
        className="btn agent-choice-btn"
        title={`${says}. ${p.hint}`}
        aria-label={says}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) agentsView().then(setView, () => {});
          setOpen(!open);
        }}
      >
        <ChipIcon />
        {/* Claude Code goes without saying beside its models' names; Codex is named */}
        {chosen && <span className="agent-choice-label">{on.harness === 'claude' ? label.replace(`${t.harnesses.claude} · `, '') : label}</span>}
      </button>
      {chosen && (
        <button className="btn agent-choice-reset" title={p.reset} aria-label={p.reset} onClick={() => void act({ action: 'agent', agent: null }).catch(() => {})}>
          ×
        </button>
      )}
      {open &&
        createPortal(
          <div className="snooze-menu agent-menu" role="menu" ref={menu}>
            <div className="snooze-h agent-runs-on">{says}</div>
            <ModelMenu view={view} onView={setView} harnesses={HARNESSES} on={on} onModel={pickModel} onEffort={pickEffort} />
          </div>,
          document.body,
        )}
    </span>
  );
}

/** A chip, for what an agent runs on. */
const ChipIcon = () => (
  <svg className="agent-chip" viewBox="0 0 16 16" width="15" height="15" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
    <rect x="6.3" y="6.3" width="3.4" height="3.4" rx=".5" />
    <path d="M6.5 1.8v2.2M9.5 1.8v2.2M6.5 12v2.2M9.5 12v2.2M1.8 6.5h2.2M1.8 9.5h2.2M12 6.5h2.2M12 9.5h2.2" />
  </svg>
);

/** The harnesses and the groups' settings, as last heard until asked again. */
export function useAgentsView(): [AgentsView | null, (v: AgentsView) => void] {
  const [view, setView] = useState<AgentsView | null>(last);
  useEffect(() => {
    let live = true;
    agentsView().then((v) => live && setView(v), () => {});
    return () => void (live = false);
  }, []);
  return [view, setView];
}

/**
 * "Continue with Codex" (or another harness) on a card whose worker waits for the limit of its
 * harness (`from`), and beside it the chip button of a card's buttons, here naming what the new
 * agent runs on (`to` until the owner picks another), which opens the other harnesses' models and
 * efforts. `onGo` gets the pick.
 */
export function ContinueOn({ from, to, onGo }: { from: Harness; to: OnModel; onGo: (on: OnModel) => void }) {
  const [view, setView] = useAgentsView();
  const [on, setOn] = useState<OnModel>(to);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  usePlaced(open, menu, () => box.current!.getBoundingClientRect());
  useMenuClose(open, [box, menu], () => setOpen(false), true);
  const pickModel = (harness: Harness, model: string) => {
    const takes = view ? effortsOf(modelChoices(view.harnesses.find((h) => h.id === harness), model), model) : AGENT_EFFORTS;
    setOn({ harness, model, effort: takes.includes(on.effort) ? on.effort : (takes.at(-1) ?? on.effort) });
  };
  return (
    <span className="agent-split" ref={box}>
      <button className="btn primary" onClick={() => onGo(on)}>
        {t.moveTo.button(t.harnesses[on.harness])}
      </button>
      {view && (
        <span className="agent-choice chosen alone">
          <button className="btn agent-choice-btn" title={t.moveTo.pickHint} aria-label={`${t.moveTo.pickHint}: ${onModelLabel(view, on)}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChipIcon />
            {/* the button beside it names the harness */}
            <span className="agent-choice-label">{onModelLabel(view, on).replace(`${t.harnesses[on.harness]} · `, '')}</span>
          </button>
        </span>
      )}
      {open &&
        view &&
        createPortal(
          <div className="snooze-menu agent-menu" role="menu" ref={menu}>
            <ModelMenu view={view} onView={setView} harnesses={HARNESSES.filter((h) => h !== from)} on={on} onModel={pickModel} onEffort={(effort) => setOn({ ...on, effort })} />
          </div>,
          document.body,
        )}
    </span>
  );
}

/** What a picker shows as chosen: a harness's model and the effort it runs with. */
export interface OnModel {
  harness: Harness;
  model: string;
  effort: AgentEffort;
}

/**
 * The content of a menu of models (a card's start button, the Configuration's pickers, "Continue
 * with …"): each harness of `harnesses` with its models as the Configuration lists them (one not set
 * up named as such), "Wait" first where `none` is given, then the efforts the chosen model takes.
 * `on`: what is checked; none while "Wait" is.
 */
export function ModelMenu({
  view,
  onView,
  harnesses,
  on,
  onModel,
  onEffort,
  none,
}: {
  view: AgentsView;
  onView: (v: AgentsView) => void;
  harnesses: readonly Harness[];
  on: OnModel | null;
  onModel: (h: Harness, model: string) => void;
  onEffort: (e: AgentEffort) => void;
  none?: { label: string; onPick: () => void };
}) {
  const listed = (h: Harness) => view.harnesses.find((x) => x.id === h);
  // the one checked among them even where no longer listed
  const choices = (h: Harness) => modelChoices(listed(h), on?.harness === h ? on.model : undefined);
  const efforts = t.config.agents.efforts;
  // the efforts the model takes (Codex lists them), the one chosen among them
  const takes = on ? effortsOf(choices(on.harness), on.model) : [];
  return (
    <>
      {none && (
        <button className="snooze-opt" role="menuitemradio" aria-checked={!on} onClick={none.onPick}>
          <Check on={!on} />
          {none.label}
        </button>
      )}
      {harnesses.map((h: Harness) => {
        const found = listed(h);
        if (!found?.ready)
          return (
            <div key={h} className="snooze-h agent-h">
              {t.config.agents.notReady(t.harnesses[h])}
            </div>
          );
        return (
          <div key={h} className="agent-group" role="group" aria-label={t.harnesses[h]}>
            <div className="snooze-h agent-h">{t.harnesses[h]}</div>
            {choices(h).map((m) => {
              const checked = on?.harness === h && on.model === m.value;
              return (
                <button key={m.value} className="snooze-opt" role="menuitemradio" aria-checked={checked} onClick={() => onModel(h, m.value)}>
                  <Check on={checked} />
                  {modelLabel(h, m)}
                  {m.version && <span className="agent-version">{m.version}</span>}
                </button>
              );
            })}
            <HarnessUpdate harness={h} view={view} onView={onView} />
          </div>
        );
      })}
      {on && (
        <>
          <div className="snooze-h agent-h agent-effort-h">{t.agentPick.effort}</div>
          <div className="agent-efforts" role="group" aria-label={t.agentPick.effort}>
            {(takes.includes(on.effort) ? takes : [...takes, on.effort]).map((e) => (
              <button key={e} className={on.effort === e ? 'agent-effort on' : 'agent-effort'} role="menuitemradio" aria-checked={on.effort === e} onClick={() => onEffort(e)}>
                {efforts[e]}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** A harness, model and effort as a picker's button names them: "Codex · Sol 6.1 · effort high". */
export function onModelLabel(view: AgentsView, on: OnModel): string {
  const choice = modelChoices(view.harnesses.find((h) => h.id === on.harness), on.model).find((c) => c.value === on.model);
  const model = `${modelLabel(on.harness, choice ?? { value: on.model })}${choice?.version ? ` ${choice.version}` : ''}`;
  return [t.harnesses[on.harness], model, t.agentPick.chosenEffort(t.config.agents.efforts[on.effort])].join(' · ');
}

/**
 * A button that names what is chosen and opens a menu of models (`ModelMenu`) under it: the
 * Configuration's pickers. `name`: what it picks, for its accessible name.
 */
export function ModelPicker({ label, name, className, disabled, menu }: { label: string; name?: string; className?: string; disabled?: boolean; menu: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  usePlaced(open, list, () => box.current!.getBoundingClientRect());
  useMenuClose(open, [box, list], () => setOpen(false), true);
  return (
    <span className={['model-picker', className].filter(Boolean).join(' ')} ref={box}>
      <button className="model-picker-btn" aria-label={name ? `${name}: ${label}` : label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
        <span className="model-picker-label">{label}</span>
        <svg className="agent-caret" viewBox="0 0 10 10" width="9" height="9" aria-hidden>
          <path d="M1.5 3.2h7L5 7.2z" fill="currentColor" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div className="snooze-menu agent-menu" role="menu" ref={list}>
            {menu(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * A newer version of a harness (Claude Code, Codex) that is out, with the button that updates it, in
 * a card's menu of models and in the Configuration: a line for this machine and one for each host
 * whose installation is behind; while an update runs, the view is asked again until it is done, and
 * then has the new version's models.
 */
export function HarnessUpdate({ harness, view, onView }: { harness: Harness; view: AgentsView; onView: (view: AgentsView) => void }) {
  const found = view.harnesses.find((h) => h.id === harness);
  const hosts = (found?.hosts ?? []).filter((h) => h.update);
  const logins = (found?.hosts ?? []).filter((h) => h.loggedIn === false);
  const running = !!found?.update?.running || hosts.some((h) => h.update?.running);
  const [asked, setAsked] = useState<string | null>(null);
  usePoll(running, () => agentsView().then(onView, () => {}), 1500);
  const start = (host?: string) => {
    setAsked(host ?? '');
    api
      .updateHarness(harness, host)
      .then((v) => ((last = v), onView(v)))
      .catch(() => {})
      .finally(() => setAsked(null));
  };
  const name = t.harnesses[harness];
  const line = (update: HarnessUpdateState, now: string | undefined, host?: string) => {
    const u = t.harnessUpdate;
    return (
      <div key={host ?? ''} className={update.error ? 'harness-update failed' : 'harness-update'} title={now ? u.hint(now, host) : undefined}>
        <span className="harness-update-text">{update.running ? u.running(name, host) : update.error ? u.failed(update.error, host) : u.out(name, update.version, host, now)}</span>
        {!update.running && (
          <button className="btn" disabled={asked === (host ?? '')} onClick={() => start(host)}>
            {update.error ? u.again : u.button}
          </button>
        )}
      </div>
    );
  };
  if (!found?.update && !hosts.length && !logins.length) return null;
  return (
    <>
      {found?.update && line(found.update, found.version)}
      {hosts.map((h) => line(h.update!, h.version, h.name))}
      {logins.map((h) => (
        <HostLogin key={`login ${h.name}`} harness={harness} host={h.name} onView={onView} />
      ))}
    </>
  );
}

/**
 * A host whose Gemini is not logged in there, with a button that logs it in: a terminal here runs
 * agy's login there over SSH, where the owner signs in with Google and pastes the code. The view is
 * then asked again until the host's next look finds it logged in, and the line goes.
 */
function HostLogin({ harness, host, onView }: { harness: Harness; host: string; onView: (view: AgentsView) => void }) {
  // the terminal opens on the machine Obeya runs on: another device gets the line without the button
  const here = useAsked(!phoneView() && onThisMachine, !phoneView());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [opened, setOpened] = useState(false);
  usePoll(opened, () => agentsView().then(onView, () => {}), 5000);
  const u = t.harnessUpdate;
  const name = t.harnesses[harness];
  const login = async () => {
    setBusy(true);
    setStatus('');
    try {
      const r = await api.setupLogin('needed', 'geminiLogin', false, host);
      setOpened(true);
      setStatus(r.opened ? t.setup.terminalOpen : `${t.setup.noTerminal} ${r.command}`);
    } catch (e) {
      setStatus(failText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="harness-update">
      <span className="harness-update-text">
        {u.notLoggedIn(name, host)}
        {status && <span className="harness-update-status" role="status">{status}</span>}
      </span>
      {here && (
        <button className="btn" disabled={busy} title={u.logInHint(name, host)} onClick={() => void login()}>
          {u.logIn}
        </button>
      )}
    </div>
  );
}

const Check = ({ on }: { on: boolean }) => (
  <span className="agent-check" aria-hidden>
    {on ? '✓' : ''}
  </span>
);

/**
 * Beside the conversation's heading: the harness, model and effort the card's agent session runs on;
 * once the card is started and before that session is there (Obeya checks it, it waits in the queue,
 * its workspace is made ready), what it will run on: the card's choice over the workers' setting. Not on a card whose buttons start its
 * agent, which names that among them.
 */
export function RunsOn({ item }: { item: Item }) {
  // a card whose buttons start its agent names that among them, once (`AgentChoice`)
  const among = (item.state === 'planned' && !item.queue) || item.state === 'proposal' || (item.state === 'idea' && !item.archivedAt);
  const starting = !item.runsOn && (item.state === 'working' || (item.state === 'planned' && !!item.queue));
  // Codex's and Gemini's models go by the names their harness gives them, as in the menu and before the session started
  const codex = !!item.runsOn && byFamily(item.runsOn.harness);
  const [view, setView] = useState<AgentsView | null>(last);
  useEffect(() => {
    if (!starting && !codex) return;
    let live = true;
    agentsView().then((v) => live && setView(v), () => {});
    return () => void (live = false);
  }, [starting, codex]);
  if (among) return null;
  const efforts = t.config.agents.efforts;
  if (item.runsOn) {
    const { harness, model, effort } = item.runsOn;
    // not the id first and the name a moment later
    if (codex && !view) return null;
    const name = codex ? (view?.harnesses.find((h) => h.id === harness)?.models.find((m) => m.id === model)?.name ?? model) : modelName(model);
    return (
      <span className="runs-on" title={t.talk.runsOn(t.harnesses[harness], model, effort && efforts[effort])}>
        {/* Gemini's models carry their harness's name already (Gemini 4 Neon) */}
        {name.startsWith(t.harnesses[harness]) ? name : `${t.harnesses[harness]} · ${name}`}
        {effort && ` · ${t.agentPick.chosenEffort(efforts[effort])}`}
      </span>
    );
  }
  if (!starting || !view) return null;
  const group = view.agents.worker;
  const own = item.agent ?? {};
  const on = own.harness && own.model ? { harness: own.harness, model: own.model } : group;
  const label = [agentLabel(view, on.harness, on.model), t.agentPick.chosenEffort(efforts[own.effort ?? group.effort])].join(' · ');
  return (
    <span className="runs-on" title={t.talk.startsOn(label)}>
      {label}
    </span>
  );
}
