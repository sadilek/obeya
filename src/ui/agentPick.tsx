// The harness, model and effort a card's agent runs on, chosen beside the button that starts it: the
// workers' group's until the owner picks another for this card, which then goes with every session
// of its run. Rarely wanted, so the start button only gets a narrow part with a triangle that opens
// the menu; a choice of the card's own is named beside it. One component for every button that
// starts a card.

import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AGENT_EFFORTS, type AgentEffort, type AgentModel, type AgentsView, type CardAction, type CardAgent, type Harness, HARNESSES, type Item, modelChoices, modelName } from '../core/types';
import { useMenuClose } from './queue';
import { placeOnScreen } from './snooze';
import { api } from './api';
import { t } from './strings';

/** The harnesses and the workers' group as last heard, shown at once by the next card while it asks again. */
let last: AgentsView | null = null;
const agentsView = () => api.agents().then((v) => (last = v));

/** A harness and model as the owner knows them: „Claude Code · Opus“, „Codex · Sol“ (a Codex family by its name, without a version). */
export function agentLabel(view: AgentsView | null, harness: Harness, model: string): string {
  const a = t.config.agents;
  if (harness === 'claude') return model === 'default' ? a.models.default : `${t.harnesses.claude} · ${a.models[model as AgentModel] ?? model}`;
  const choice = modelChoices(view?.harnesses.find((h) => h.id === 'codex'), model).find((c) => c.value === model);
  return `${t.harnesses.codex} · ${choice?.name ?? model}`;
}

/** The card's choice without what is empty; nothing left: the group's again. */
const choice = (c: CardAgent): CardAgent | null => (c.harness || c.effort ? c : null);

/**
 * The button that starts the card (`children`), joined to a narrow part with a triangle that opens
 * the menu of harnesses, models and efforts, in the start button's colours (`primary`); a choice of
 * the card's own is named beside them. Where the harnesses are not known (yet), the start button alone.
 */
export function AgentPick({ item, act, primary = true, children }: { item: Item; act: (a: CardAction) => Promise<void>; primary?: boolean; children: ReactNode }) {
  const [view, setView] = useState<AgentsView | null>(last);
  const [open, setOpen] = useState(false);
  // a start while the choice is still on its way would run on the one before
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    agentsView().then((v) => live && setView(v), () => {});
    return () => void (live = false);
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => menu.current && box.current && placeOnScreen(menu.current, box.current.getBoundingClientRect());
    place();
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    return () => {
      removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
    };
  }, [open, view]);
  // the menu lies over the page, above the panel and the controls floating over it, and is part of the box for closing it
  const both = useRef({ contains: (n: Node | null) => !!box.current?.contains(n) || !!menu.current?.contains(n) });
  useMenuClose(open, both as unknown as RefObject<HTMLElement>, () => setOpen(false), true);
  if (!view) return <>{children}</>;
  const p = t.agentPick;
  const efforts = t.config.agents.efforts;
  const group = view.agents.worker;
  const own = item.agent ?? {};
  const listed = (h: Harness) => view.harnesses.find((x) => x.id === h);
  const harness = own.harness && own.model ? own.harness : group.harness;
  const model = own.harness && own.model ? own.model : group.model;
  // each harness's models as the Konfiguration lists them, the one checked among them even where no longer listed
  const choices = (h: Harness) => modelChoices(listed(h), harness === h ? model : undefined);
  // the efforts the model takes (Codex lists them), the one chosen among them
  const takes = choices(harness).find((m) => m.value === model)?.efforts ?? AGENT_EFFORTS;
  const save = (next: CardAgent | null) => {
    if (JSON.stringify(next) === JSON.stringify(item.agent ?? null)) return;
    setSaving(true);
    act({ action: 'agent', agent: next })
      .catch(() => {})
      .finally(() => setSaving(false));
  };
  // what equals the workers' setting is no choice of the card's: it follows that setting
  const pickModel = (h: Harness, m: string) => {
    const mine = h !== group.harness || m !== group.model;
    // an effort the new model does not take goes back to the group's
    const kept = own.effort && (choices(h).find((x) => x.value === m)?.efforts ?? AGENT_EFFORTS).includes(own.effort) ? own.effort : undefined;
    save(choice({ ...(mine ? { harness: h, model: m } : {}), ...(kept ? { effort: kept } : {}) }));
  };
  const pickEffort = (e: AgentEffort) => save(choice({ ...(own.harness && own.model ? { harness: own.harness, model: own.model } : {}), ...(e !== group.effort ? { effort: e } : {}) }));
  const effort = own.effort ?? group.effort;
  const chosen = [own.harness && own.model ? agentLabel(view, own.harness, own.model) : '', own.effort ? p.chosenEffort(efforts[own.effort]) : ''].filter(Boolean).join(' · ');
  return (
    <span className={saving ? 'agent-split saving' : 'agent-split'} ref={box}>
      {children}
      <button
        className={['btn', primary && 'primary', 'agent-pick'].filter(Boolean).join(' ')}
        title={p.hint}
        aria-label={p.hint}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) agentsView().then(setView, () => {});
          setOpen(!open);
        }}
      >
        <svg className="agent-caret" viewBox="0 0 10 10" width="9" height="9" aria-hidden>
          <path d="M1.5 3.2h7L5 7.2z" fill="currentColor" />
        </svg>
      </button>
      {chosen && (
        <span className="agent-chosen hint" title={p.chosenHint}>
          {chosen}
        </span>
      )}
      {open &&
        createPortal(
          <div className="snooze-menu agent-menu" role="menu" ref={menu}>
            {HARNESSES.map((h: Harness) => {
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
                    const on = harness === h && model === m.value;
                    return (
                      <button key={m.value} className="snooze-opt" role="menuitemradio" aria-checked={on} onClick={() => pickModel(h, m.value)}>
                        <Check on={on} />
                        {h === 'claude' ? (t.config.agents.models[m.value as AgentModel] ?? m.value) : (m.name ?? m.value)}
                      </button>
                    );
                  })}
                  {h === 'codex' && <div className="hint agent-family">{t.config.agents.codexFamily}</div>}
                </div>
              );
            })}
            <div className="snooze-h agent-h agent-effort-h">{p.effort}</div>
            <div className="agent-efforts" role="group" aria-label={p.effort}>
              {takes.map((e) => (
                <button key={e} className={effort === e ? 'agent-effort on' : 'agent-effort'} role="menuitemradio" aria-checked={effort === e} onClick={() => pickEffort(e)}>
                  {efforts[e]}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </span>
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
 * its workspace is made ready), what it will run on: the card's choice over the workers' setting.
 */
export function RunsOn({ item }: { item: Item }) {
  const starting = !item.runsOn && (item.state === 'working' || (item.state === 'planned' && !!item.queue));
  // Codex's models go by the names Codex gives them, as in the menu and before the session started
  const codex = item.runsOn?.harness === 'codex';
  const [view, setView] = useState<AgentsView | null>(last);
  useEffect(() => {
    if (!starting && !codex) return;
    let live = true;
    agentsView().then((v) => live && setView(v), () => {});
    return () => void (live = false);
  }, [starting, codex]);
  const efforts = t.config.agents.efforts;
  if (item.runsOn) {
    const { harness, model, effort } = item.runsOn;
    // not the id first and the name a moment later
    if (codex && !view) return null;
    const name = codex ? (view?.harnesses.find((h) => h.id === 'codex')?.models.find((m) => m.id === model)?.name ?? model) : modelName(model);
    return (
      <span className="runs-on" title={t.talk.runsOn(t.harnesses[harness], model, effort && efforts[effort])}>
        {t.harnesses[harness]} · {name}
        {effort && ` · ${t.agentPick.chosenEffort(efforts[effort])}`}
      </span>
    );
  }
  if (!starting || !view) return null;
  const group = view.agents.worker;
  const own = item.agent ?? {};
  const label = [own.harness && own.model ? agentLabel(view, own.harness, own.model) : agentLabel(view, group.harness, group.model), t.agentPick.chosenEffort(efforts[own.effort ?? group.effort])].join(' · ');
  return (
    <span className="runs-on" title={t.talk.startsOn(label)}>
      {label}
    </span>
  );
}
