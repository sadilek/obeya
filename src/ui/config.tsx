// Obeya's configuration, in a dialog over the page with its sections listed on the left: the
// canvases it serves and their repositories, edited and saved together (Obeya then starts again
// with them), and the settings saved on their own (models, voice, demos, language). The server's
// own settings come from its command line and show read-only.

import { type CSSProperties, Fragment, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { AGENT_EFFORTS, AGENT_MODELS, AGENT_ROLES, type AgentEffort, type AgentModel, type AgentRole, type AgentSetting, type AgentsView, blocksSaving, type CanvasConfig, type ConfigChecked, type ConfigProblem, type ConfigView, commandLines, type DemoSettings, type DemoSettingsView, type DemoSpaceView, type DemoSite, type DemoVoiceCheck, type FilledClones, type PersonalSiteView, type SiteSetupJob, type Language, type HostConfig, type LanguageView, type NarrationLanguage, restartsAgents, type RepoConfig, type RepoSettings, type RepoTrust, type RepoValues, type ResolvedCanvas, type SettingsShared, type SettingValue, layerSettings, SHARED_FIELDS, NESTED_SETTINGS, type NestedSetting, isNested, type PageTags, type SetupCheck, START_FAILED, type Theme, THEMES, type ThemeView, type UsageMeterView, type VoiceKind, type VoiceSetupView, withClones } from '../core/types';
import { lineDiff } from '../core/diff';
import { parseTagLines, tagLines } from '../core/page-tags';
import { LANGUAGES } from '../core/locale';
import { AccessSection } from './access';
import { api, reload, type SiteHow } from './api';
import { keepConfigDraft, keptConfigDraft } from './configDraft';
import { keep } from './keep';
import { plain } from './markdown';
import { demoState, GitSetup, platformName, RecognitionDetail, SetupList, useFolderWithoutGit, voiceState } from './setup';
import { useFitHeight } from './fitHeight';
import { useCopy } from './copy';
import { failText, fileSize, snoozeWhen, t } from './strings';
import { applyTheme } from './theme';
import { WishLink } from './wish';
import { canvasPath } from './address';

declare global {
  interface Window {
    /**
     * In the app's window (app/src/main.rs); `built`: installed from a checkout, the commit it was built
     * from; `handedOver`: its shell started again, and the page before handed over what a reload keeps.
     */
    obeyaApp?: { version: string; platform: string; built?: string | null; handedOver?: boolean };
    /** Called by the app before its shell starts again while the server runs on (`handOver`). */
    obeyaHandOver?: (token: string) => Promise<void>;
  }
}

type Checked = Pick<ConfigChecked, 'resolved' | 'problems'>;

/** Hands the Koordinator a request; to the one of `canvas` where given, else to this page's. */
type Ask = (text: string, canvas?: string) => void;

/** The dialog's sections, in the order its list shows them. */
type Section = 'canvases' | 'agents' | 'voice' | 'demos' | 'devices' | 'general';
const SECTIONS: Section[] = ['canvases', 'agents', 'voice', 'demos', 'devices', 'general'];
// the section shown, per tab: a new language reloads the page (as a save that restarts Obeya does), and the dialog comes back at it
const SECTION_KEY = 'obeya-config-section';

// the canvas shown in Leinwände, per tab, by its place in the list
const CANVAS_KEY = 'obeya-config-canvas';

/** Opens the dialog at the canvases next time, at the one the page shows, as from the note on a plan directory. */
export const showCanvasesSection = () => {
  sessionStorage.setItem(SECTION_KEY, 'canvases');
  sessionStorage.removeItem(CANVAS_KEY);
};

/** The canvas this tab showed last in the dialog, if any. */
const keptCanvas = () => {
  const n = Number(sessionStorage.getItem(CANVAS_KEY) ?? NaN);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** Opens the dialog at the demos next time, as from the hint on a card to set up a personal demo site. */
export const showDemosSection = () => {
  sessionStorage.setItem(SECTION_KEY, 'demos');
  sessionStorage.setItem(PERSONAL_SHOW_KEY, '1');
};
/** The personal demo site is to be scrolled to once the dialog shows it. */
const PERSONAL_SHOW_KEY = 'obeya-config-personal';

/** Opens the dialog at „Von anderen Geräten“ next time, as from „Telefon verbinden“. */
export const showDevicesSection = () => sessionStorage.setItem(SECTION_KEY, 'devices');

/** The section this tab showed last, if any. */
const keptSection = () => {
  const s = sessionStorage.getItem(SECTION_KEY) as Section | null;
  return s && SECTIONS.includes(s) ? s : null;
};

/** A repository's clone count (or its slots, or one of its settings, folded open) to show and focus when the dialog opens. */
export interface ConfigFocus {
  canvas: string;
  repo: string;
  field: 'clones' | 'slots' | 'settings';
  /** With `settings`: the setting to show. */
  setting?: string;
}
const FOCUS_KEY = 'obeya-config-focus';

/** Opens the dialog next time at a repository's clone count or slots, as from a card waiting for a free clone or slot. */
export const showRepoClones = (f: ConfigFocus) => {
  showCanvasesSection();
  sessionStorage.setItem(FOCUS_KEY, JSON.stringify(f));
};

/** The canvases' draft as written down, with the id each canvas had when loaded. */
type KeptCanvases = { draft: CanvasConfig[]; origin: (string | null)[] };
const ofKept = (k: KeptCanvases) => k.draft;

/**
 * The draft with the ids of its canvases once the check of the configuration as `loaded` resolved
 * them: a canvas without one yet gets the id of the loaded canvas with its repositories, and a
 * running one the owner renamed meanwhile keeps it, as a rename does once the id is known; one they
 * added has none.
 */
function pinned(kept: KeptCanvases, loaded: CanvasConfig[], resolved: Checked['resolved'], running: string[]): KeptCanvases {
  const taken = new Set<number>();
  const out = kept.draft.map((c, i) => {
    if (kept.origin[i]) return { c, id: kept.origin[i]! };
    const j = loaded.findIndex((l, k) => !taken.has(k) && JSON.stringify(l.repos) === JSON.stringify(c.repos));
    if (j < 0) return { c, id: null };
    taken.add(j);
    const id = resolved[j]?.id ?? null;
    return { c: id && running.includes(id) && !c.id && c.name !== loaded[j]!.name ? { ...c, id } : c, id };
  });
  return { draft: out.map((x) => x.c), origin: out.map((x) => x.id) };
}

/** `list` with its entry at `from` moved to `to`. */
const moved = <T,>(list: T[], from: number, to: number): T[] => {
  const out = [...list];
  out.splice(to, 0, ...out.splice(from, 1));
  return out;
};

/** The check of `n` canvases with the one at `from` moved to `to`, as the draft's: its ids and problems stay with it until the draft is checked again. */
function checkedMoved(c: Checked, n: number, from: number, to: number): Checked {
  const order = moved([...Array(n).keys()], from, to);
  return {
    resolved: order.map((i) => c.resolved[i] ?? null),
    problems: c.problems.map((p) => (p.canvas === undefined ? p : { ...p, canvas: order.indexOf(p.canvas) })),
  };
}

export function ConfigDialog({ on, page, onClose, onSetup, onAsk, onTalk, onProblems, onConnect, revs }: { on: boolean; /** The canvas the page shows: the one Leinwände shows first. */ page?: string; onClose: () => void; onSetup: () => void; onAsk: Ask; onTalk: () => void; onProblems: (n: number) => void; onConnect: () => void; revs: string }) {
  const [view, setView] = useState<ConfigView | null>(null);
  const [draft, setDraft] = useState<CanvasConfig[]>([]);
  const [checked, setChecked] = useState<Checked | null>(null);
  // the check of the configuration as saved: it reads every repository, so it comes after the configuration
  const [saved, setSaved] = useState<Checked | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [json, setJson] = useState(false);
  const [section, setSectionState] = useState<Section>(() => keptSection() ?? 'canvases');
  const setSection = (s: Section) => {
    sessionStorage.setItem(SECTION_KEY, s);
    setSectionState(s);
  };
  // the id each canvas of the draft had when loaded: renaming a running canvas keeps it, and its cards
  const [origin, setOrigin] = useState<(string | null)[]>([]);
  // a repository added here whose settings say clones gets as many as the first canvas's, once it is checked, until existing ones are listed
  const filled = useRef<FilledClones>(new Map());
  // the canvases as loaded while their ids are unknown yet: those come with the check of the saved configuration
  const unpinned = useRef<CanvasConfig[] | null>(null);
  // counts the drafts loaded anew (reset, read again): a canvas of the one before is not one of this one
  const [loads, setLoads] = useState(0);
  const load = (v: ConfigView, c: Checked | null) => {
    setLoads((n) => n + 1);
    filled.current.clear();
    setDraft(v.canvases);
    setOrigin(c ? c.resolved.map((r) => r?.id ?? null) : v.canvases.map(() => null));
    unpinned.current = c ? null : v.canvases;
  };
  const now = useRef({ draft, origin, running: view?.running ?? [] });
  now.current = { draft, origin, running: view?.running ?? [] };
  const savedSeq = useRef(0);
  const checkSaved = () => {
    const n = ++savedSeq.current;
    api.configCheck().then((c) => {
      if (n !== savedSeq.current) return;
      setSaved(c);
      onProblems(c.problems.length);
      const loaded = unpinned.current;
      unpinned.current = null;
      if (!loaded) return;
      const p = pinned(now.current, loaded, c.resolved, now.current.running);
      if (p.draft.some((x, i) => x !== now.current.draft[i])) setDraft(p.draft);
      setOrigin(p.origin);
    }, console.error);
  };

  // the field to show once the canvases are there; a new object each time, so a second jump to the same one still scrolls
  const [focus, setFocus] = useState<ConfigFocus | null>(null);

  // the canvas Leinwände shows, by its place in the draft; until one is chosen, the field to show's or the page's, once their ids are known
  const [pick, setPickState] = useState<number | null>(keptCanvas);
  const setPick = (i: number | null) => {
    if (i === null) sessionStorage.removeItem(CANVAS_KEY);
    else sessionStorage.setItem(CANVAS_KEY, String(i));
    setPickState(i);
  };
  const idAt = (i: number) => origin[i] ?? checked?.resolved[i]?.id ?? null;
  const wanted = useRef<string | null>(null);
  useEffect(() => {
    const id = wanted.current;
    if (!id) return;
    const i = draft.findIndex((_, j) => idAt(j) === id);
    if (i < 0) return;
    wanted.current = null;
    setPick(i);
  }, [origin, checked, view]);
  const shown = Math.min(pick ?? 0, Math.max(0, draft.length - 1));

  // a key per canvas that goes with it when it moves or one above it goes, and what is open in it with it
  const keys = useRef<number[]>([]);
  const nextKey = useRef(0);
  const keyed = useRef(loads);
  if (keyed.current !== loads || keys.current.length !== draft.length) {
    keyed.current = loads;
    keys.current = draft.map(() => nextKey.current++);
  }

  const changed = !!view && JSON.stringify(draft) !== JSON.stringify(view.canvases);
  const changedRef = useRef(changed);
  changedRef.current = changed;
  // a draft not saved yet is written down as it changes: a reload (Obeya's restart) brings it back
  useEffect(() => {
    if (view) keepConfigDraft<KeptCanvases>(sessionStorage, 'canvases', { draft, origin }, view.canvases, ofKept);
  }, [draft, origin, view]);
  // read afresh whenever the dialog opens: the Koordinator or the file may have changed it; a draft not saved yet stays, after a reload too
  useEffect(() => {
    if (!on) return;
    const s = keptSection();
    if (s) setSectionState(s);
    const f = sessionStorage.getItem(FOCUS_KEY);
    sessionStorage.removeItem(FOCUS_KEY);
    const fo = f ? (JSON.parse(f) as ConfigFocus) : null;
    setFocus(fo);
    // the canvas with the field to show, else the one this tab showed last, else the page's
    const kept = keptCanvas();
    wanted.current = fo?.canvas ?? (kept === null ? (page ?? null) : null);
    setPickState(fo ? null : kept);
    setSaved(null);
    api.config().then((v) => {
      setView(v);
      const kept = !changedRef.current && keptConfigDraft<KeptCanvases>(sessionStorage, 'canvases', v.canvases, ofKept);
      if (kept) {
        setLoads((n) => n + 1);
        setDraft(kept.draft);
        setOrigin(kept.origin);
        unpinned.current = v.canvases;
      } else if (!changedRef.current) load(v, null);
      setStatus(v.restarting ? t.config.saved : '');
      checkSaved();
    }, console.error);
  }, [on]);

  // what the problems are read from changed while the dialog is open (a repository did not start, say): the saved configuration is checked again
  const revsSeen = useRef(revs);
  useEffect(() => {
    if (revsSeen.current === revs) return;
    revsSeen.current = revs;
    if (on && view) checkSaved();
  }, [revs]);

  const take = (c: Checked, checkedDraft: CanvasConfig[]) => {
    setChecked(c);
    const next = view && withClones(checkedDraft, view.canvases, c.resolved, filled.current);
    if (next) setDraft(next);
  };

  // the draft is checked as it is edited: paths, settings, ids; as saved, it has the check of the saved configuration
  const seq = useRef(0);
  useEffect(() => {
    if (!changed) setChecked(saved);
  }, [changed, saved]);
  useEffect(() => {
    if (!view || !changed) return void ++seq.current;
    const n = ++seq.current;
    const h = setTimeout(() => api.checkConfig(draft).then((c) => n === seq.current && take(c, draft), console.error), 300);
    return () => clearTimeout(h);
  }, [draft, view]);

  const problems = checked?.problems ?? [];
  const c = t.config;
  // a path that became a repository here (git set up in its folder): its problem goes
  const recheck = () => {
    const n = ++seq.current;
    api.checkConfig(draft).then((v) => n === seq.current && take(v, draft), console.error);
  };
  // problems of no one canvas (none at all, the file broken): counted at the heading over them
  const overall = problems.filter((p) => p.canvas === undefined);
  // a canvas differs from the saved one with its id, or from the one at its place while ids are unknown; one added always
  const canvasChanged = (i: number) => {
    if (!view || !changed) return false;
    const id = origin[i];
    const j = id && saved ? saved.resolved.findIndex((r) => r?.id === id) : i;
    return j !== i || JSON.stringify(draft[i]) !== JSON.stringify(view.canvases[j]);
  };
  const canvasName = (x: CanvasConfig, i: number) => x.name?.trim() || checked?.resolved[i]?.name || c.canvas(i + 1);
  const showCanvas = (i: number) => {
    wanted.current = null;
    setFocus(null);
    setSection('canvases');
    setPick(i);
  };
  const addCanvas = () => {
    keys.current = [...keys.current, nextKey.current++];
    setDraft([...draft, { repos: [{ path: '' }] }]);
    setOrigin([...origin, null]);
    showCanvas(draft.length);
  };
  const setCanvas = (i: number, x: CanvasConfig | null) => {
    if (x) return setDraft(draft.map((y, j) => (j === i ? x : y)));
    keys.current = keys.current.filter((_, j) => j !== i);
    setDraft(draft.filter((_, j) => j !== i));
    setOrigin(origin.filter((_, j) => j !== i));
    // the next one takes its place; after the last, the one before it
    setPick(Math.max(0, Math.min(i, draft.length - 2)));
  };
  const moveCanvas = (from: number, to: number) => {
    keys.current = moved(keys.current, from, to);
    setDraft(moved(draft, from, to));
    setOrigin(moved(origin, from, to));
    if (checked) setChecked(checkedMoved(checked, draft.length, from, to));
    if (shown === from) setPick(to);
  };
  return (
    // a press on the dim around the dialog closes it; a press that starts inside does not
    <div id="config" className={on ? 'on' : undefined} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cfg-box" role="dialog" aria-modal="true" aria-label={c.title}>
        <nav className="cfg-nav">
          <div className="p-kind">{c.kind}</div>
          <h2>{c.title}</h2>
          <div className="cfg-ask">
            <p className="hint">{c.koordinator}</p>
            <button className="btn small" onClick={onTalk}>
              {c.askObeya}
            </button>
          </div>
          <ul>
            {SECTIONS.map((s) =>
              s === 'canvases' ? (
                <li key={s} className="cfg-nav-group">
                  {/* a heading over the canvases, each of them a section of its own */}
                  <span className="cfg-nav-title">
                    {c.sections.canvases}
                    {changed && !draft.some((_, i) => canvasChanged(i)) && <span className="cfg-dot" title={c.unsaved} />}
                    {overall.length > 0 && (
                      <span className="n err" title={c.problemCount(overall.length)}>
                        {overall.length}
                      </span>
                    )}
                  </span>
                  <ul>
                    {draft.map((x, i) => {
                      const on = section === 'canvases' && i === shown;
                      const n = problems.filter((p) => p.canvas === i).length;
                      return (
                        <li key={keys.current[i]}>
                          <button className={on ? 'on' : undefined} aria-current={on || undefined} onClick={() => showCanvas(i)}>
                            <span className="cfg-nav-name">{canvasName(x, i)}</span>
                            {canvasChanged(i) && <span className="cfg-dot" title={c.unsaved} />}
                            {n > 0 && (
                              <span className="n err" title={c.problemCount(n)}>
                                {n}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                    {view && (
                      <li>
                        <button className="cfg-nav-add" onClick={addCanvas}>
                          {c.addCanvas}
                        </button>
                      </li>
                    )}
                  </ul>
                </li>
              ) : (
                <li key={s}>
                  <button className={s === section ? 'on' : undefined} aria-current={s === section || undefined} onClick={() => setSection(s)}>
                    {c.sections[s]}
                  </button>
                </li>
              ),
            )}
          </ul>
          <div className="cfg-nav-foot">
            <button className="btn small" onClick={onSetup}>
              {t.setup.check}
            </button>
            <WishLink onOpen={onClose} />
          </div>
        </nav>
        {/* on the box, not in the scrolling column, so it stays in view however far that scrolls */}
        <button className="cfg-close" title={t.close} onClick={onClose}>
          ✕
        </button>
        <div className="cfg-main">
          <section className="cfg-sec" hidden={section !== 'canvases'}>
            {!view ? (
              <>
                <Head title={c.sections.canvases} />
                <p className="hint">{c.loading}</p>
              </>
            ) : (
              <Canvases
                view={view}
                draft={draft}
                origin={origin}
                n={shown}
                canvasKey={keys.current[shown]}
                checked={checked}
                changed={changed}
                busy={busy}
                focus={focus}
                onAsk={onAsk}
                onRecheck={recheck}
                onCanvas={setCanvas}
                onMove={moveCanvas}
                onSave={async () => {
                  setBusy(true);
                  let applies = false;
                  try {
                    const { restarting, applied } = await api.saveConfig(draft);
                    // what is saved now is the draft as last checked; settings applied at once change what the
                    // repositories amount to (where „Für alle“ goes, say), so it is read and checked again
                    const fresh = applied ? await api.config() : null;
                    savedSeq.current++;
                    setSaved(checked);
                    setView({ ...(fresh ?? view), canvases: draft, restarting });
                    checkSaved();
                    setStatus(restarting ? c.saved : applied ? (restartsAgents(view.canvases, draft) ? c.savedRestarts : c.savedApplied) : c.savedOnly);
                    applies = !restarting;
                  } catch (e) {
                    setStatus(failText(e));
                  }
                  setBusy(false);
                  return applies;
                }}
                onReset={() => load(view, saved)}
                onReload={async () => {
                  const v = await api.config();
                  setView(v);
                  load(v, null);
                  checkSaved();
                }}
                status={status}
                json={json}
                onJson={() => setJson(!json)}
              />
            )}
          </section>
          <section className="cfg-sec" hidden={section !== 'agents'}>
            <AgentsBlock on={on} />
          </section>
          <section className="cfg-sec" hidden={section !== 'voice'}>
            <VoiceBlock on={on} />
          </section>
          <section className="cfg-sec" hidden={section !== 'demos'}>
            <DemoBlock on={on} />
            <PersonalSiteBlock on={on && section === 'demos'} />
          </section>
          <section className="cfg-sec" hidden={section !== 'devices'}>
            <AccessSection on={on && section === 'devices'} onConnect={onConnect} />
          </section>
          <section className="cfg-sec" hidden={section !== 'general'}>
            <Head title={c.sections.general} />
            <LanguageBlock on={on} />
            <ThemeBlock on={on} />
            <UsageBlock on={on} />
            {view && <ServerBlock server={view.server} />}
          </section>
        </div>
      </div>
    </div>
  );
}

/** A section's title, what it is about, and the file it is saved in; `sub` for a part of a section. */
export function Head({ title, hint, file, sub }: { title: string; hint?: ReactNode; file?: string; sub?: boolean }) {
  return (
    <header className={sub ? 'cfg-head sub' : 'cfg-head'}>
      {sub ? <h4>{title}</h4> : <h3>{title}</h3>}
      {hint && <p className="hint">{hint}</p>}
      {file && (
        <p className="hint cfg-file">
          {t.config.fromFile} <code>{file}</code>
        </p>
      )}
    </header>
  );
}

/** One setting: what it is on the left (an info icon there shows while the pointer is on the row), the control with what to know about it on the right. */
export function Field({ label, hint, className, children }: { label: ReactNode; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={className ? `cfg-field cfg-has-info ${className}` : 'cfg-field cfg-has-info'}>
      <div className="cfg-label">{label}</div>
      <div className="cfg-control">
        {children}
        {hint && <p className="hint">{hint}</p>}
      </div>
    </div>
  );
}

/**
 * What to know about a field, behind a small icon: the icon shows while the pointer is on the field or its
 * label (the nearest `.cfg-has-info` around it) or the field has the focus, so the page stays calm; the text
 * shows on the icon at once, kept inside the window.
 */
function Info({ text }: { text: string }) {
  const id = useId();
  const icon = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<CSSProperties | null>(null);
  const show = () => {
    const r = icon.current!.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left - 12, innerWidth - TIP_WIDTH - 8));
    // below the icon, or above it in the lower part of the window
    setAt(r.bottom > innerHeight * 0.65 ? { left, bottom: innerHeight - r.top + 6 } : { left, top: r.bottom + 6 });
  };
  useEffect(() => {
    if (!at) return;
    const hide = () => setAt(null);
    addEventListener('scroll', hide, true);
    return () => removeEventListener('scroll', hide, true);
  }, [at]);
  return (
    <>
      <button
        type="button"
        ref={icon}
        className={at ? 'cfg-info on' : 'cfg-info'}
        aria-label={t.config.info}
        aria-describedby={id}
        onPointerEnter={show}
        onPointerLeave={() => setAt(null)}
        onFocus={show}
        onBlur={() => setAt(null)}
        onClick={(e) => (e.preventDefault(), show())}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="8" cy="5" r=".95" fill="currentColor" />
          <path d="M8 7.3v4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <span id={id} className="cfg-tip" role="tooltip" hidden={!at} style={at ?? undefined}>
        {text}
      </span>
    </>
  );
}

const TIP_WIDTH = 340;

interface CanvasesProps {
  view: ConfigView;
  draft: CanvasConfig[];
  origin: (string | null)[];
  /** The canvas shown, by its place in the draft. */
  n: number;
  /** Its key, which goes with it when it moves: what is open in it stays with it. */
  canvasKey: number | undefined;
  checked: Checked | null;
  changed: boolean;
  busy: boolean;
  focus: ConfigFocus | null;
  onAsk: Ask;
  onRecheck: () => void;
  /** Changes the canvas at `i`, or removes it (`null`). */
  onCanvas: (i: number, c: CanvasConfig | null) => void;
  /** Moves the canvas at `from` to `to`: the order every list of canvases shows (the switcher, the phone). */
  onMove: (from: number, to: number) => void;
  /** Saves the draft; says whether it was saved and applies without a restart. */
  onSave: () => Promise<boolean>;
  onReset: () => void;
  /** Reads the saved configuration again: the server changed it (settings taken over for everyone). */
  onReload: () => Promise<void>;
  status: string;
  json: boolean;
  onJson: () => void;
}

/** One canvas of the configuration with its repositories; all canvases are saved together, with the bar at the bottom. */
function Canvases({ view, draft, origin, n, canvasKey, checked, changed, busy, focus, onAsk, onRecheck, onCanvas, onMove, onSave, onReset, onReload, status, json, onJson }: CanvasesProps) {
  const c = t.config;
  const problems = checked?.problems ?? [];
  // „Für alle“ takes over what is saved: with changes in the dialog it saves them first, where that applies without a restart
  const prepare = changed && view.source === 'file' && !view.restarting && !problems.some(blocksSaving) ? onSave : undefined;
  // a canvas with a problem has no id yet: which running canvas goes is only known once all resolve
  const resolved = checked?.resolved ?? [];
  const gone = resolved.every(Boolean) ? view.running.filter((id) => !resolved.some((r) => r?.id === id)) : [];
  const file =
    view.source === 'file' ? (
      <>
        {c.fromFile} <code>{view.file}</code>
      </>
    ) : (
      c.fromArgs(view.file)
    );
  const x = draft[n];
  return (
    <>
      {x ? (
        <CanvasBlock
          key={canvasKey}
          n={n}
          {...(draft.length > 1 ? { onMove: (earlier: boolean) => onMove(n, earlier ? n - 1 : n + 1), last: n === draft.length - 1 } : {})}
          canvas={x}
          file={file}
          checking={!checked}
          resolved={checked?.resolved[n] ?? null}
          running={view.running}
          pin={origin[n] && view.running.includes(origin[n]) ? origin[n] : undefined}
          saved={!changed}
          problems={problems.filter((p) => p.canvas === n)}
          focus={focus}
          ask={changed ? undefined : onAsk}
          onRecheck={onRecheck}
          onReload={onReload}
          {...(prepare ? { prepare } : {})}
          onChange={(y) => onCanvas(n, y)}
        />
      ) : (
        <Head title={c.sections.canvases} hint={file} />
      )}
      {problems
        .filter((p) => p.canvas === undefined)
        .map((p, k) => (
          <Problem key={k} problem={p} where="" ask={changed ? undefined : onAsk} />
        ))}
      {changed && gone.length > 0 && <p className="hint warn">{c.gone(gone.join(', '))}</p>}
      {json && <pre className="c-json">{JSON.stringify(draft, null, 2)}</pre>}
      <div className="cfg-actions">
        <button className="btn primary" disabled={!changed || busy || problems.some(blocksSaving)} onClick={() => void onSave()}>
          {/* a configuration from the file applies while Obeya runs; one from the command line becomes the file with a restart */}
          {view.server.restarts && (view.source === 'args' || view.restarting) ? c.save : c.saveOnly}
        </button>
        {changed && (
          <button className="btn" disabled={busy} onClick={onReset}>
            {c.reset}
          </button>
        )}
        {status ? <span className="hint c-status">{status}</span> : changed && draft.length > 1 && <span className="hint c-status">{c.savesAll}</span>}
        <button className={json ? 'btn small cfg-json on' : 'btn small cfg-json'} onClick={onJson}>
          {c.json}
        </button>
      </div>
    </>
  );
}

/** The server's own settings, from its command line: shown, not changed here. */
function ServerBlock({ server }: { server: ConfigView['server'] }) {
  const c = t.config;
  return (
    <>
      <Head sub title={c.server} />
      <Field label={c.version}>
        {server.version}
        {server.commit && <> · {c.checkout(server.commit.slice(0, 7))}</>}
      </Field>
      <Field label={c.port}>{server.port}</Field>
      <Field label={c.dataDir}>
        <code>{server.home}</code>
      </Field>
      <Field label={c.permissionMode}>
        <code>{server.permissionMode}</code>
      </Field>
      <Field label={c.restarts}>{!server.restarts ? c.no : server.commit ? c.yes : c.noCheckout}</Field>
      {/* from a checkout, in a browser: how to have the app instead (scripts/app.ts) */}
      {server.commit && !window.obeyaApp && (
        <Field label={c.asApp} hint={c.asAppHint}>
          <code>bun run app install</code>
        </Field>
      )}
      {window.obeyaApp?.built && (
        <Field label={c.app} hint={c.appBuiltHint}>
          {c.checkout(window.obeyaApp.built.slice(0, 7))}
        </Field>
      )}
      {/* in the app's window (app/src/main.rs), which opens a new window in the default browser */}
      {window.obeyaApp && (
        <button className="btn small" title={c.openInBrowserHint} onClick={() => window.open(location.href, '_blank')}>
          {c.openInBrowser}
        </button>
      )}
    </>
  );
}

/** Voices grouped as the settings sheet offers them; `say` only on a Mac. */
const VOICE_GROUPS: { group: 'local' | 'service' | 'own'; voices: VoiceKind[] }[] = [
  { group: 'local', voices: ['piper', 'qwen3', 'say'] },
  { group: 'service', voices: ['gemini', 'openai', 'elevenlabs', 'azure'] },
  { group: 'own', voices: ['command', 'http'] },
];
/** The fields each voice reads, in the order the sheet shows them. */
const VOICE_FIELDS: Record<VoiceKind, ('voiceName' | 'command' | 'url' | 'keyFile')[]> = {
  piper: ['voiceName'],
  qwen3: ['voiceName'],
  say: ['voiceName'],
  command: ['command'],
  http: ['url', 'keyFile'],
  gemini: ['voiceName', 'keyFile'],
  openai: ['voiceName', 'url', 'keyFile'],
  elevenlabs: ['voiceName', 'keyFile'],
  azure: ['url', 'voiceName', 'keyFile'],
};
/** A stock voice of a model or service is nobody's own. */
const STOCK_ONLY: VoiceKind[] = ['piper', 'say'];
/** Where demos go when the settings name no directory (`DEFAULT_DEMO_DIRECTORY` of the demo skill, which the page cannot import). */
const DEFAULT_DEMO_DIRECTORY = '~/demos';

/**
 * The interface language, saved on its own, the page loading again in it; and the conversation
 * language, which agents write the owner in, saved on its own and taking effect with their next words.
 */
function LanguageBlock({ on }: { on: boolean }) {
  const [view, setView] = useState<LanguageView | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (on) api.language().then(setView, console.error);
  }, [on]);
  if (!view) return null;
  const l = t.config.language;
  const choose = async (language: Language | null) => {
    setBusy(true);
    setStatus('');
    try {
      const v = await api.saveLanguage(language);
      setView(v);
      // the strings are set before the first render: the page loads again, keeping what is open
      reload();
    } catch (e) {
      setStatus(failText(e));
      setBusy(false);
    }
  };
  const converse = async (conversation: Language | null) => {
    setStatus('');
    try {
      setView(await api.saveConversationLanguage(conversation));
    } catch (e) {
      setStatus(failText(e));
    }
  };
  return (
    <>
      <Head sub title={l.heading} file={view.file} />
      <Field label={l.title} hint={l.hint}>
        <select aria-label={l.title} value={view.chosen ?? ''} disabled={busy} onChange={(e) => choose((e.target.value || null) as Language | null)}>
          <option value="">{l.system(l.names[view.system])}</option>
          {LANGUAGES.map((x) => (
            <option key={x} value={x}>
              {l.names[x]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={l.conversation} hint={l.conversationHint}>
        <select aria-label={l.conversation} value={view.conversationChosen ?? ''} disabled={busy} onChange={(e) => converse((e.target.value || null) as Language | null)}>
          <option value="">{l.asInterface(l.names[view.language])}</option>
          {LANGUAGES.map((x) => (
            <option key={x} value={x}>
              {l.names[x]}
            </option>
          ))}
        </select>
      </Field>
      {status && <p className="hint c-status">{status}</p>}
    </>
  );
}

/** Light or dark, or as the system: saved on its own, and the page takes it at once. */
function ThemeBlock({ on }: { on: boolean }) {
  const [view, setView] = useState<ThemeView | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (on) api.theme().then(setView, console.error);
  }, [on]);
  if (!view) return null;
  const l = t.config.theme;
  const choose = async (theme: Theme | null) => {
    const before = view;
    setView({ ...view, chosen: theme });
    applyTheme(theme);
    setStatus('');
    try {
      setView(await api.saveTheme(theme));
    } catch (e) {
      setView(before);
      applyTheme(before.chosen);
      setStatus(failText(e));
    }
  };
  return (
    <>
      <Head sub title={l.title} hint={l.hint} file={view.file} />
      <Field label={l.title}>
        <div className="seg" role="radiogroup" aria-label={l.title}>
          {[null, ...THEMES].map((x) => (
            <button key={x ?? 'system'} type="button" role="radio" aria-checked={view.chosen === x} className={view.chosen === x ? 'on' : undefined} onClick={() => choose(x)}>
              {x ? l.names[x] : l.system}
            </button>
          ))}
        </div>
      </Field>
      {status && <p className="hint c-status">{status}</p>}
    </>
  );
}

/** Whether the bar shows the plan's usage limits: saved on its own, and the bar follows at once. */
function UsageBlock({ on }: { on: boolean }) {
  const [view, setView] = useState<UsageMeterView | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (on) api.usageMeter().then(setView, console.error);
  }, [on]);
  if (!view) return null;
  const l = t.usage.setting;
  const choose = async (shown: boolean) => {
    setStatus('');
    try {
      setView(await api.saveUsageMeter(shown));
    } catch (e) {
      setStatus(failText(e));
    }
  };
  return (
    <>
      <Head sub title={l.title} hint={l.hint} file={view.file} />
      <Field label={l.title}>
        <label className="c-check">
          <input type="checkbox" checked={view.on} onChange={(e) => choose(e.target.checked)} />
          {l.label}
        </label>
      </Field>
      {status && <p className="hint c-status">{status}</p>}
    </>
  );
}

/** The model and effort of each group of agents: saved on each change, taken by the next agent that starts. */
function AgentsBlock({ on }: { on: boolean }) {
  const [view, setView] = useState<AgentsView | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (on) api.agents().then(setView, console.error);
  }, [on]);
  if (!view) return null;
  const a = t.config.agents;
  const choose = async (role: AgentRole, choice: Partial<AgentSetting>) => {
    setBusy(true);
    setStatus('');
    try {
      setView(await api.saveAgents(role, choice));
    } catch (e) {
      setStatus(failText(e));
    }
    setBusy(false);
  };
  return (
    <>
      <Head title={a.title} hint={a.hint} file={view.file} />
      <div className="cfg-agents">
        <span />
        <span className="hint">{a.model}</span>
        <span className="hint">{a.effort}</span>
        {AGENT_ROLES.map((role) => {
          const setting = view.agents[role];
          return (
            <Fragment key={role}>
              <div className="cfg-agent">
                {a.roles[role].name}
                <span className="hint">{a.roles[role].hint}</span>
              </div>
              <select aria-label={`${a.roles[role].name}: ${a.model}`} value={setting.model} disabled={busy} onChange={(e) => choose(role, { model: e.target.value as AgentModel })}>
                {AGENT_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {a.models[m]}
                  </option>
                ))}
              </select>
              <select aria-label={`${a.roles[role].name}: ${a.effort}`} value={setting.effort} disabled={busy} onChange={(e) => choose(role, { effort: e.target.value as AgentEffort })}>
                {AGENT_EFFORTS.map((x) => (
                  <option key={x} value={x}>
                    {a.efforts[x]}
                  </option>
                ))}
              </select>
            </Fragment>
          );
        })}
      </div>
      {status && <p className="hint c-status">{status}</p>}
    </>
  );
}

/** How demos are narrated: saved on their own, read by the next render, so nothing restarts. */
function DemoBlock({ on }: { on: boolean }) {
  const [view, setView] = useState<DemoSettingsView | null>(null);
  const [draft, setDraft] = useState<DemoSettings | null>(null);
  const [check, setCheck] = useState<DemoVoiceCheck | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [sampling, setSampling] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!on) return;
    api.demoSettings().then((v) => {
      setView(v);
      setDraft(keptConfigDraft<DemoSettings>(sessionStorage, 'demo', v.settings) ?? v.settings);
      setStatus('');
    }, console.error);
  }, [on]);
  // a draft not saved yet is written down as it changes: closing the dialog or a reload brings it back
  useEffect(() => {
    if (view && draft) keepConfigDraft(sessionStorage, 'demo', draft, view.settings);
  }, [draft, view]);
  const installing = !!view?.job?.running;
  // the voice as it is being chosen: its problems, what it still needs installed
  useEffect(() => {
    if (!draft) return;
    let live = true;
    api.checkDemoVoice(draft).then((c) => live && setCheck(c), console.error);
    return () => {
      live = false;
    };
  }, [draft, installing]);
  // an installation runs on the server, or it counts the demos' space: follow it until it ends
  const counting = !!view?.space?.busy;
  useEffect(() => {
    if (!on || !(installing || counting)) return;
    const timer = setInterval(() => api.demoSettings().then(setView, console.error), 1500);
    return () => clearInterval(timer);
  }, [on, installing, counting]);
  useEffect(() => () => audio.current?.pause(), []);
  if (!view || !draft) return null;
  const d = t.config.demo;
  const changed = JSON.stringify(draft) !== JSON.stringify(view.settings);
  const set = <K extends keyof DemoSettings>(k: K, v: DemoSettings[K]) => setDraft({ ...draft, [k]: v });
  const shown = check ?? view.check;
  const job = view.job?.voice === draft.voice ? view.job : undefined;
  const failed = (e: unknown) => setStatus(failText(e, { detail: ['voiceSample'] }));
  const save = async () => {
    setBusy(true);
    try {
      const v = await api.saveDemoSettings(draft);
      setView(v);
      setDraft(v.settings);
      setStatus(d.saved);
    } catch (e) {
      failed(e);
    }
    setBusy(false);
  };
  const install = async () => {
    setStatus('');
    try {
      setView(await api.installDemoVoice(draft));
    } catch (e) {
      failed(e);
    }
  };
  const listen = async () => {
    setSampling(true);
    setStatus('');
    try {
      const wav = await api.demoVoiceSample(draft);
      audio.current?.pause();
      audio.current = new Audio(URL.createObjectURL(wav));
      await audio.current.play();
    } catch (e) {
      failed(e);
    }
    setSampling(false);
  };
  const field = (k: (typeof VOICE_FIELDS)[VoiceKind][number]) => (
    <Field key={k} label={d.field[k](draft.voice)}>
      <input
        className="c-path"
        aria-label={d.field[k](draft.voice)}
        spellCheck={false}
        placeholder={d.placeholder[k](draft.voice)}
        value={draft[k] ?? ''}
        onChange={(e) => set(k, e.target.value || undefined)}
      />
    </Field>
  );
  return (
    <>
      <Head title={d.title} hint={d.hint} file={view.file} />
      <div className="cfg-cols">
        <div>
          <Field label={d.directory} hint={d.directoryHint(shown.directory)}>
            <input
              className="c-path"
              aria-label={d.directory}
              spellCheck={false}
              placeholder={DEFAULT_DEMO_DIRECTORY}
              value={draft.directory ?? ''}
              onChange={(e) => set('directory', e.target.value || undefined)}
            />
            {shown.directoryRelative && <p className="p-error">{d.directoryRelative}</p>}
          </Field>
          {view.space && <KeepFrames space={view.space} value={draft.keepFrames} onChange={(v) => set('keepFrames', v)} />}
          <Field label={d.language} hint={d.languageHint}>
            <select aria-label={d.language} value={draft.language} onChange={(e) => set('language', e.target.value as NarrationLanguage)}>
              {(Object.keys(d.languages) as NarrationLanguage[]).map((l) => (
                <option key={l} value={l}>
                  {d.languages[l]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={d.voice} hint={d.about[draft.voice]}>
            <select
              aria-label={d.voice}
              value={draft.voice}
              // another voice starts with its own fields, and is nobody's own until ticked; directory and frames stay
              onChange={(e) =>
                setDraft({ language: draft.language, voice: e.target.value as VoiceKind, ...(draft.directory ? { directory: draft.directory } : {}), ...(draft.keepFrames ? { keepFrames: draft.keepFrames } : {}) })
              }
            >
              {VOICE_GROUPS.map(({ group, voices }) => (
                <optgroup key={group} label={d.groups[group]}>
                  {voices
                    .filter((v) => v !== 'say' || view.platform === 'darwin' || draft.voice === 'say')
                    .map((v) => (
                      <option key={v} value={v}>
                        {d.voices[v]}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
          {VOICE_FIELDS[draft.voice].map(field)}
          {draft.voice === 'qwen3' &&
            LANGUAGES.map((l) => (
              <Field key={l} label={d.field.reference(d.languages[l])}>
                <input
                  className="c-path"
                  aria-label={d.field.reference(d.languages[l])}
                  spellCheck={false}
                  placeholder={d.placeholder.reference()}
                  value={draft.references?.[l] ?? ''}
                  onChange={(e) => {
                    const { [l]: _, ...others } = draft.references ?? {};
                    const references = { ...others, ...(e.target.value ? { [l]: e.target.value } : {}) };
                    set('references', Object.keys(references).length ? references : undefined);
                  }}
                />
                {shown.clips[l] && <p className="p-error">{d.clip[shown.clips[l]]}</p>}
              </Field>
            ))}
          <Field label="" hint={d.person[shown.person]}>
            {!STOCK_ONLY.includes(draft.voice) && (
              <label className="c-check">
                <input type="checkbox" checked={!!draft.ownVoice} onChange={(e) => set('ownVoice', e.target.checked || undefined)} />
                {d.ownVoice}
              </label>
            )}
          </Field>
          <Field label="">
            {job?.running ? (
              <p className="hint c-install">
                <span className="c-step">{d.installing}</span> <code>{job.line}</code>
              </p>
            ) : (
              !shown.install.installed && (
                <div className="c-install">
                  <p className="hint">{d.notInstalled(shown.install.missing.join(', '), fileSize(shown.install.mb * 1e6))}</p>
                  <button className="btn small" disabled={installing} onClick={install}>
                    {d.install(fileSize(shown.install.mb * 1e6))}
                  </button>
                </div>
              )
            )}
            {job?.error && !job.running && <p className="p-error">{d.installFailed(job.error.split('\n').at(-1) ?? '')}</p>}
            {shown.problems.map((p) => (
              <p key={p} className="p-error">
                {d.problem[p]}
              </p>
            ))}
            <button className="btn small" disabled={sampling || !shown.install.installed || !!shown.problems.length || !!shown.clips[draft.language]} onClick={listen}>
              {sampling ? d.sampling : d.listen}
            </button>
          </Field>
          <div className="cfg-actions">
            <button className="btn primary" disabled={!changed || busy} onClick={save}>
              {d.save}
            </button>
            {changed && (
              <button className="btn" disabled={busy} onClick={() => setDraft(view.settings)}>
                {t.config.reset}
              </button>
            )}
            {status && <span className="hint c-status">{status}</span>}
          </div>
        </div>
        <SetupBlock draft={draft} installing={installing} />
      </div>
    </>
  );
}

/** Which Cloudflare account a new site goes into: that of a site this machine deploys to (its name), this machine's login (''), or another account by its API token ('token'). */
interface CloudflareWay {
  account: string;
  token: string;
  accountId: string;
}

/** The choice as the server takes it. */
const cloudflareHow = (w: CloudflareWay): SiteHow => (w.account === 'token' ? { token: w.token, ...(w.accountId.trim() ? { accountId: w.accountId.trim() } : {}) } : w.account ? { account: w.account } : {});

/** Where Cloudflare's API tokens are made. */
const CLOUDFLARE_TOKENS = 'https://dash.cloudflare.com/profile/api-tokens';

/**
 * The Cloudflare account a new site goes into: that of a site this machine deploys to already
 * (`accounts`, by site), this machine's own login (logging in in the browser where there is none),
 * or another account, by an API token pasted here, which leaves the machine's login as it is.
 */
function CloudflareAccount({ accounts, way, onChange, disabled }: { accounts: string[]; way: CloudflareWay; onChange: (way: CloudflareWay) => void; disabled?: boolean }) {
  const a = t.config.personal;
  return (
    <div className="site-account">
      <label>
        <span className="hint">{a.account}</span>
        <select aria-label={a.account} value={way.account} disabled={disabled} onChange={(e) => onChange({ ...way, account: e.target.value })}>
          {accounts.map((x) => (
            <option key={x} value={x}>
              {a.accountOf(x)}
            </option>
          ))}
          <option value="">{a.accountLogin}</option>
          <option value="token">{a.accountToken}</option>
        </select>
      </label>
      {way.account === 'token' && (
        <>
          <label>
            <span className="hint">
              {a.tokenLabel}{' '}
              <a href={CLOUDFLARE_TOKENS} target="_blank" rel="noreferrer">
                {a.tokenLink}
              </a>
            </span>
            <input className="c-path" type="password" autoComplete="off" spellCheck={false} aria-label={a.tokenLabel} value={way.token} disabled={disabled} onChange={(e) => onChange({ ...way, token: e.target.value })} />
          </label>
          <label>
            <span className="hint">{a.accountIdLabel}</span>
            <input className="c-path" spellCheck={false} aria-label={a.accountIdLabel} value={way.accountId} disabled={disabled} onChange={(e) => onChange({ ...way, accountId: e.target.value })} />
          </label>
        </>
      )}
    </div>
  );
}

/** The hosts the personal site may be set up at, in the switcher's order: a public GitHub repository works with any account. */
type PersonalHost = 'github-public' | 'github' | 'cloudflare';
const PERSONAL_HOSTS: PersonalHost[] = ['github-public', 'github', 'cloudflare'];

/** The host chosen for a new site, and a connection code pasted but not sent yet: they survive closing the dialog. */
const PERSONAL_HOST_KEY = 'obeya-personal-host';
const PERSONAL_CODE_KEY = 'obeya-personal-code';

/**
 * The owner's personal demo site: set up at Cloudflare Pages or GitHub Pages with one button, or
 * connected with another machine's code; once there, its address, the code for another machine, the
 * private repositories ticked for it, and removing it from this machine.
 */
function PersonalSiteBlock({ on }: { on: boolean }) {
  const [view, setView] = useState<PersonalSiteView | null>(null);
  const [host, setHost] = useState<PersonalHost>(() => PERSONAL_HOSTS.find((h) => h === sessionStorage.getItem(PERSONAL_HOST_KEY)) ?? PERSONAL_HOSTS[0]!);
  const [way, setWay] = useState<CloudflareWay | null>(null);
  const [code, setCode] = useState(() => sessionStorage.getItem(PERSONAL_CODE_KEY) ?? '');
  const [connecting, setConnecting] = useState(() => !!sessionStorage.getItem(PERSONAL_CODE_KEY));
  const [copied, copy] = useCopy(1500);
  // the connection code, at hand before the click: the clipboard takes it within the click
  const [connection, setConnection] = useState('');
  const [removing, setRemoving] = useState(false);
  const [status, setStatus] = useState('');
  const p = t.config.personal;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (on) api.personalSite().then(setView, console.error);
  }, [on]);
  // opened from a card's hint: it comes into view
  useEffect(() => {
    if (!on || !view || !sessionStorage.getItem(PERSONAL_SHOW_KEY)) return;
    sessionStorage.removeItem(PERSONAL_SHOW_KEY);
    // the demo settings above load meanwhile and push it down: scrolled once they stand
    const at = setTimeout(() => box.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 400);
    return () => clearTimeout(at);
  }, [on, !!view]);
  const running = !!view?.job?.running;
  // a setup runs on the server, with a login in the browser maybe: follow it until it ends
  useEffect(() => {
    if (!on || !running) return;
    const timer = setInterval(() => api.personalSite().then(setView, console.error), 1000);
    return () => clearInterval(timer);
  }, [on, running]);
  useEffect(() => {
    if (view?.site) api.personalSiteCode().then((c) => setConnection(c.code), console.error);
  }, [view?.site?.url]);
  useEffect(() => sessionStorage.setItem(PERSONAL_HOST_KEY, host), [host]);
  useEffect(() => (code ? sessionStorage.setItem(PERSONAL_CODE_KEY, code) : sessionStorage.removeItem(PERSONAL_CODE_KEY)), [code]);
  if (!view) return null;
  const act = async (fn: () => Promise<PersonalSiteView>) => {
    setStatus('');
    try {
      setView(await fn());
      return true;
    } catch (e) {
      setStatus(failText(e));
      return false;
    }
  };
  // the first site's account, until the owner chooses
  const chosen: CloudflareWay = way ?? { account: view.cloudflareAccounts[0] ?? '', token: '', accountId: '' };
  const setUp = (h: PersonalHost) => {
    setHost(h);
    void act(() => (h === 'cloudflare' ? api.setUpPersonalSite('cloudflare', cloudflareHow(chosen)) : api.setUpPersonalSite('github', h === 'github-public' ? { public: true } : {})));
  };
  const job = view.job;
  const site = view.site;
  return (
    <div className="personal-site" ref={box}>
      <Head title={p.title} hint={p.hint} />
      {!site ? (
        <div className="cfg-narrow">
          <div className="seg" role="radiogroup" aria-label={p.title}>
            {PERSONAL_HOSTS.map((h) => (
              <button key={h} type="button" role="radio" aria-checked={host === h} className={host === h ? 'on' : undefined} disabled={running} onClick={() => setHost(h)}>
                {p.hosts[h]}
              </button>
            ))}
          </div>
          <p className="hint">{p.notes[host]}</p>
          {host === 'cloudflare' && <CloudflareAccount accounts={view.cloudflareAccounts} way={chosen} onChange={setWay} disabled={running} />}
          <button className="btn primary" disabled={running || (host === 'cloudflare' && chosen.account === 'token' && !chosen.token.trim())} onClick={() => setUp(host)}>
            {running ? p.settingUp : p.setup}
          </button>
          {job && (job.running || !job.error) && job.lines.length > 0 && <p className="hint c-install">{job.lines.at(-1)}</p>}
          {job?.error && !job.running && (
            <p className="p-error">
              {p.failed} {job.error}
            </p>
          )}
          {job?.error && !job.running && job.offer === 'cloudflare' && (
            <button className="btn small" onClick={() => setUp('cloudflare')}>
              {p.tryCloudflare}
            </button>
          )}
          {host !== 'github-public' && <p className="hint">{p.unlistedNote}</p>}
          {!connecting ? (
            <p className="hint personal-connect">
              <button className="link" onClick={() => setConnecting(true)}>
                {p.connect}
              </button>{' '}
              · {p.connectIntro}
            </p>
          ) : (
            <Field label={p.connect} hint={p.connectHint}>
              <textarea className="c-path" rows={3} spellCheck={false} placeholder="obeya-site:…" aria-label={p.connect} value={code} onChange={(e) => setCode(e.target.value)} />
              <div className="personal-actions">
                <button
                  className="btn"
                  disabled={!code.trim()}
                  onClick={async () => {
                    if (await act(() => api.connectPersonalSite(code))) {
                      setCode('');
                      setConnecting(false);
                    }
                  }}
                >
                  {p.connectGo}
                </button>
              </div>
            </Field>
          )}
        </div>
      ) : (
        <div className="cfg-narrow">
          <p className="personal-url">
            <a href={site.url} target="_blank" rel="noreferrer">
              {site.url.replace(/^https:\/\//, '').replace(/\/$/, '')}
            </a>
            <span className="hint"> · {p.at(p.hostNames[site.host], site.project)}</span>
          </p>
          <p className="hint">
            {p.example} <code>{site.example.replace(/^https:\/\//, '')}</code>
          </p>
          {site.needs && <p className="p-error">{p.needs(site.needs)}</p>}
          {!site.listed && <p className="hint">{p.unlistedNote}</p>}
          <Field label={p.privateRepos} hint={p.privateHint}>
            {view.privateRepos.length ? (
              <div className="personal-private">
                {view.privateRepos.map((r) => (
                  <label key={r.path} className="c-check" title={r.path}>
                    <input type="checkbox" checked={r.allowed} aria-label={p.privateAllow(r.name)} onChange={(e) => void act(() => api.allowPrivateRepo(r.path, e.target.checked))} />
                    {r.name}
                    {r.ownSite && <span className="hint"> · {p.ownSite}</span>}
                  </label>
                ))}
              </div>
            ) : (
              <p className="hint">{p.privateNone}</p>
            )}
          </Field>
          <Field label={p.approvedRepos} hint={p.approvedHint}>
            {view.approvedRepos.length ? (
              <div className="personal-private">
                {view.approvedRepos.map((r) => (
                  <label key={r.path} className="c-check" title={r.path}>
                    <input type="checkbox" checked={r.on} disabled={r.bySettings} aria-label={p.approvedOn(r.name)} onChange={(e) => void act(() => api.shareApprovedRepo(r.path, e.target.checked))} />
                    {r.name}
                    {r.bySettings && <span className="hint"> · {p.bySettings}</span>}
                  </label>
                ))}
              </div>
            ) : (
              <p className="hint">{p.approvedNone}</p>
            )}
          </Field>
          <Field label={p.codeLabel} hint={p.codeHint}>
            <div className="personal-actions">
              <button className="btn small" disabled={!connection} onClick={() => copy(connection)}>
                {copied ? p.copied : p.code}
              </button>
            </div>
          </Field>
          <div className="personal-actions">
            {!removing ? (
              <button className="btn small" title={p.removeHint} onClick={() => setRemoving(true)}>
                {p.remove}
              </button>
            ) : (
              <>
                <button
                  className="btn small danger"
                  onClick={async () => {
                    setRemoving(false);
                    await act(() => api.removePersonalSite());
                  }}
                >
                  {p.removeConfirm}
                </button>
                <button className="btn small" onClick={() => setRemoving(false)}>
                  {t.config.reset}
                </button>
              </>
            )}
          </div>
          {removing && <p className="hint">{p.removeWarning}</p>}
        </div>
      )}
      {status && <p className="p-error">{status}</p>}
    </div>
  );
}

/** The days choosable for keeping a demo's frames, besides one the settings name already. */
const KEEP_CHOICES = [7, 14, 30, 90, 'always'] as const;

/**
 * How long a demo's frames stay after its last render, and what the demos take on disk: counted on the
 * server, which the section follows while it counts. Choosing what applies anyway names nothing.
 */
function KeepFrames({ space, value, onChange }: { space: DemoSpaceView; value: DemoSettings['keepFrames']; onChange: (v: DemoSettings['keepFrames']) => void }) {
  const d = t.config.demo;
  const fallback = space.defaultDays ?? 'always';
  const shown = value ?? fallback;
  const choices = KEEP_CHOICES.some((c) => c === shown) ? KEEP_CHOICES : [...KEEP_CHOICES.slice(0, -1), shown, 'always' as const].sort((a, b) => (a === 'always' ? 1 : b === 'always' ? -1 : a - b));
  const label = (c: number | 'always') => (c === fallback ? d.keepDefault(d.keepFor(c)) : d.keepFor(c));
  const { used, freed, busy } = space;
  return (
    <Field label={<>{d.keepFrames} <Info text={d.keepFramesInfo} /></>}>
      <select
        aria-label={d.keepFrames}
        value={String(shown)}
        onChange={(e) => {
          const v = e.target.value === 'always' ? 'always' : Number(e.target.value);
          onChange(v === fallback ? undefined : v);
        }}
      >
        {choices.map((c) => (
          <option key={c} value={String(c)}>
            {label(c)}
          </option>
        ))}
      </select>
      <p className="hint">
        {used ? d.used(fileSize(used.bytes), fileSize(used.work)) : d.counting}
        {used && busy && ` ${d.recounting}`}
      </p>
      {freed && <p className="hint">{d.freed(snoozeWhen(freed.at), freed.demos, fileSize(freed.bytes))}</p>}
    </Field>
  );
}

/**
 * What a render needs on this machine besides the voice (that has its own lines above), each
 * missing piece with how to install it here. Checked again after an installation, and on request.
 */
function SetupBlock({ draft, installing }: { draft: DemoSettings; installing: boolean }) {
  const [setup, setSetup] = useState<SetupCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const s = t.config.setup;
  const recheck = () => {
    setChecking(true);
    return api
      .demoSetup(draft)
      .then(setSetup, console.error)
      .finally(() => setChecking(false));
  };
  useEffect(() => {
    if (!installing) recheck();
  }, [installing]);
  if (!setup) return null;
  const items = setup.items.filter((i) => i.id !== 'voice');
  return (
    <div className="c-setup">
      <Head sub title={s.title} hint={s.hint(platformName(setup))} />
      <SetupList items={items} name={(i) => s.names[i.id]} state={demoState} />
      {!items.some((i) => i.state === 'missing') && <p className="hint">{s.ready}</p>}
      <p className="hint">
        {s.guide} <code>docs/demo-setup.md</code>
      </p>
      <button className="btn small" disabled={checking} onClick={recheck}>
        {checking ? s.checking : s.recheck}
      </button>
    </div>
  );
}

/**
 * What the owner's voice input needs on this machine, with one button that loads the speech
 * recognition (fetching it the first time) and measures it, and a cloud service instead. Follows
 * an installation until it ends.
 */
function VoiceBlock({ on }: { on: boolean }) {
  const [view, setView] = useState<VoiceSetupView | null>(null);
  const [status, setStatus] = useState('');
  const [checking, setChecking] = useState(false);
  const recheck = () => {
    setChecking(true);
    return api
      .voiceSetup()
      .then(setView, console.error)
      .finally(() => setChecking(false));
  };
  useEffect(() => {
    if (on) recheck();
  }, [on]);
  const running = !!view?.job?.running;
  useEffect(() => {
    if (!on || !running) return;
    const timer = setInterval(() => api.voiceSetup().then(setView, console.error), 1500);
    return () => clearInterval(timer);
  }, [on, running]);
  if (!view) return null;
  const v = t.config.voice;
  const s = t.config.setup;
  const install = async () => {
    setStatus('');
    try {
      setView(await api.installVoice());
    } catch (e) {
      setStatus(failText(e));
    }
  };
  const blocked = view.items.some((i) => i.state === 'missing');
  return (
    <div className="c-setup">
      <Head title={v.title} hint={v.hint(platformName(view))} />
      <SetupList items={view.items} name={(i) => v.names[i.id]} state={voiceState} action={(i) => i.id === 'recognition' && <RecognitionDetail item={i} busy={running} changed={recheck} />} />
      {view.listen === 'faster' && <p className="hint">{v.faster}</p>}
      {view.job?.running ? (
        <p className="hint c-install">
          <span className="c-step">{v.step[view.job.step]}</span>
        </p>
      ) : view.fetch.mb ? (
        <div className="c-install">
          <button className="btn small" disabled={blocked} onClick={install}>
            {v.install(fileSize(view.fetch.mb * 1e6))}
          </button>
        </div>
      ) : (
        !blocked && <p className="hint">{v.ready}</p>
      )}
      {view.job?.error && !view.job.running && <p className="p-error">{v.failed(view.job.error.split('\n').at(-1) ?? '')}</p>}
      {status && <p className="hint c-status">{status}</p>}
      <button className="btn small" disabled={checking || running} onClick={recheck}>
        {checking ? s.checking : s.recheck}
      </button>
    </div>
  );
}

interface CanvasProps {
  n: number;
  canvas: CanvasConfig;
  /** Where the canvases are saved, under its title. */
  file: ReactNode;
  /** The repositories are being checked: their ids and settings are still to come. */
  checking: boolean;
  resolved: ConfigChecked['resolved'][number];
  running: string[];
  /** The id of the running canvas this one is: a new name keeps it. */
  pin?: string;
  /** The configuration shown is the one saved: a running canvas is the one shown. */
  saved: boolean;
  problems: ConfigProblem[];
  focus: ConfigFocus | null;
  /** Has the Koordinator create a task that fixes a problem; only for the configuration as saved, which is what it reads. */
  ask?: Ask;
  onRecheck: () => void;
  onReload: () => Promise<void>;
  /** Saves the dialog's changes before settings are taken over for everyone; none where saving restarts Obeya. */
  prepare?: () => Promise<boolean>;
  onChange: (c: CanvasConfig | null) => void;
  /** Moves it one place up or down; none while it is the only canvas. */
  onMove?: (earlier: boolean) => void;
  /** It is the last canvas: it cannot move down. */
  last?: boolean;
}

/** A canvas as its own page: its title with id, order and removal, its name, then each repository with its settings. */
function CanvasBlock({ n, canvas, file, checking, resolved, running, pin, saved, problems, focus, ask, onRecheck, onReload, prepare, onChange, onMove, last }: CanvasProps) {
  const fresh = resolved && !running.includes(resolved.id);
  // the Koordinator of the canvas with the problem, where it runs: a card for it goes there
  const askHere = ask && ((text: string) => ask(text, resolved && running.includes(resolved.id) ? resolved.id : undefined));
  const here = t.config.canvas(n + 1);
  const setRepo = (i: number, r: RepoConfig | null) => onChange({ ...canvas, repos: r ? canvas.repos.map((x, j) => (j === i ? r : x)) : canvas.repos.filter((_, j) => j !== i) });
  // the repository shown: the home one, or the one with the field to show
  const [tab, setAt] = useState(0);
  useEffect(() => {
    const i = focus && resolved?.id === focus.canvas ? resolved.repos.findIndex((r) => r?.id === focus.repo) : -1;
    if (i >= 0) setAt(i);
  }, [focus, resolved?.id]);
  const at = Math.min(tab, canvas.repos.length - 1);
  const repo = canvas.repos[at];
  return (
    <div className="cfg-canvas">
      <header className="cfg-head">
        <div className="cfg-canvas-head">
          <h3>{canvas.name?.trim() || resolved?.name || here}</h3>
          {resolved && (
            <span className={fresh ? 'c-id fresh' : 'c-id'}>
              {canvasPath(resolved.id)} · {fresh ? t.config.fresh : t.config.runs}
            </span>
          )}
          {onMove && (
            <span className="qmoves">
              {[true, false].map((earlier) => {
                const label = earlier ? t.config.moveUp : t.config.moveDown;
                return (
                  <button key={label} className="btn qmove" disabled={earlier ? n === 0 : last} title={label} aria-label={label} onClick={() => onMove(earlier)}>
                    {earlier ? '↑' : '↓'}
                  </button>
                );
              })}
            </span>
          )}
          <RemoveButton label={t.config.removeCanvas} onClick={() => onChange(null)} />
        </div>
        <p className="hint cfg-file">{file}</p>
        <p className="hint">{t.config.settings.hint}</p>
      </header>
      {checking && <p className="hint">{t.config.checking}</p>}
      <Field label={t.config.name} hint={fresh ? t.config.freshHint : undefined}>
        <input
          className="cfg-name"
          aria-label={t.config.name}
          value={canvas.name ?? ''}
          placeholder={resolved && !canvas.name ? t.config.nameAuto(resolved.name) : t.config.name}
          onChange={(e) => {
            const { name: _, ...rest } = canvas;
            const kept = pin && !rest.id ? { ...rest, id: pin } : rest;
            onChange(e.target.value ? { ...kept, name: e.target.value } : kept);
          }}
        />
      </Field>
      {problems
        .filter((p) => p.repo === undefined)
        .map((p, k) => (
          <Problem key={k} problem={p} where={here} ask={askHere} retried={askHere && onRecheck} />
        ))}
      {/* its repositories as tabs, one shown at a time, with the problems of each counted on it */}
      <Field label={t.config.repos}>
        <div className="cfg-repo-tabs">
          <div className="seg" role="tablist" aria-label={t.config.repos}>
            {canvas.repos.map((r, i) => {
              const k = problems.filter((p) => p.repo === i).length;
              return (
                <button key={i} type="button" role="tab" aria-selected={i === at} className={i === at ? 'on' : undefined} onClick={() => setAt(i)}>
                  {repoName(r, resolved?.repos[i])}
                  {k > 0 && <span className="n err">{k}</span>}
                </button>
              );
            })}
          </div>
          <button
            className="btn small"
            onClick={() => {
              onChange({ ...canvas, repos: [...canvas.repos, { path: '' }] });
              setAt(canvas.repos.length);
            }}
          >
            {t.config.addRepo}
          </button>
        </div>
      </Field>
      {repo && (
        <RepoRow
          key={at}
          repo={repo}
          home={at === 0}
          resolved={resolved?.repos[at]}
          {...(resolved ? { canvasId: resolved.id } : {})}
          problems={problems.filter((p) => p.repo === at)}
          {...(focus && resolved?.id === focus.canvas && resolved.repos[at]?.id === focus.repo ? { focus } : {})}
          where={`${here}, ${t.config.repoAt(repo.path)}`}
          ask={askHere}
          onRecheck={onRecheck}
          takeover={{ saved, onReload, ...(prepare ? { prepare } : {}) }}
          onChange={(x) => {
            setRepo(at, x);
            if (!x) setAt(Math.max(0, at - 1));
          }}
        />
      )}
    </div>
  );
}

interface RepoProps {
  repo: RepoConfig;
  home: boolean;
  resolved?: ResolvedCanvas['repos'][number];
  /** The canvas the repository is on, as checked: where a card for it goes, once the dialog's changes are saved. */
  canvasId?: string;
  problems: ConfigProblem[];
  /** Its clone count or slots to scroll to and focus: the dialog was opened from a card waiting for a free clone or slot. */
  focus?: ConfigFocus;
  /** Where it is, for a request to the Koordinator. */
  where: string;
  ask?: (text: string) => void;
  /** Checks the configuration again: git was set up in the repository's folder. */
  onRecheck: () => void;
  takeover: Takeover;
  onChange: (r: RepoConfig | null) => void;
}

/** A repository's name on its tab: its id once checked, else its folder's name. */
const repoName = (repo: RepoConfig, resolved: ResolvedCanvas['repos'][number] | undefined) => resolved?.id ?? (repo.path.trim().split(/[\\/]/).filter(Boolean).pop() || t.config.newRepo);

/** What „Für alle“ needs of the dialog: whether the canvases are as saved (what is taken over), how to read them again, how to save them first. */
interface Takeover {
  saved: boolean;
  /** Reads the saved configuration again: the server changed it. */
  onReload: () => Promise<void>;
  /** Saves the dialog's changes; none where saving restarts Obeya. Says whether they were saved. */
  prepare?: () => Promise<boolean>;
}

function RepoRow({ repo, home, resolved, canvasId, problems, focus, where, ask, onRecheck, takeover, onChange }: RepoProps) {
  const clonesBox = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const box = clonesBox.current;
    if (!focus || focus.field === 'settings' || !box) return;
    box.scrollIntoView({ block: 'center' });
    box.querySelector<HTMLInputElement>(focus.field === 'slots' ? '.cfg-slots input' : '.cfg-clone-count input')?.focus({ preventScroll: true });
    setFlash(true);
    const h = setTimeout(() => setFlash(false), 2400);
    return () => clearTimeout(h);
  }, [focus]);
  // a path without a repository that is a folder: git can be set up there
  const noGit = useFolderWithoutGit(problems.some((p) => p.code === 'notRepo') ? repo.path.trim() : '');
  // a folder without git has neither clones nor slots: every card works in the folder itself
  const folder = repo.git === false;
  // where work lands on the repository's main, its own folder listed as a clone is none: work lands there (as the server has it)
  const landsHere = (repo.settings?.land ?? resolved?.values.land.value) === 'main';
  const itself = (w: string) => landsHere && w.trim().replace(/\/+$/, '') === repo.path.trim().replace(/\/+$/, '');
  // clones the configuration names (to make, existing ones, on hosts) put the repository in clones whatever its settings say
  const named = !!repo.clones || (repo.workspaces ?? []).some((w) => w.trim() && !itself(w)) || !!repo.hosts?.length;
  const base = resolved?.values.workspaces;
  // what the repository's settings say without this machine's, where the check could tell it apart from the clones named
  const known = base && base.source !== 'clones' ? base.value : undefined;
  const own = repo.settings?.workspaces;
  const workIn = named ? 'clones' : (own ?? known ?? resolved?.workspaces ?? 'worktrees');
  const clones = !folder && workIn === 'clones';
  const existing = useRef<HTMLTextAreaElement>(null);
  const existingText = (repo.workspaces ?? []).join('\n');
  useFitHeight(existing, existingText, clones);
  // the clones named, put aside while the owner switches to worktrees, back with a switch to clones
  const parked = useRef<Pick<RepoConfig, 'clones' | 'workspaces' | 'hosts'>>({});
  const without = <K extends keyof RepoConfig>(k: K, v: RepoConfig[K] | undefined, from: RepoConfig = repo): RepoConfig => {
    const next = { ...from };
    if (v === undefined) delete next[k];
    else next[k] = v;
    return next;
  };
  // „Agenten arbeiten in“: this machine's setting where the repository's says otherwise; worktrees put the clones named aside
  const setWorkIn = (mode: 'clones' | 'worktrees') => {
    if (mode === workIn) return;
    const { workspaces: _, ...others } = repo.settings ?? {};
    const settings = known === mode ? others : { ...others, workspaces: mode };
    let next = without('settings', Object.keys(settings).length ? settings : undefined);
    if (mode === 'worktrees') {
      parked.current = { ...(repo.clones !== undefined ? { clones: repo.clones } : {}), ...(repo.workspaces ? { workspaces: repo.workspaces } : {}), ...(repo.hosts ? { hosts: repo.hosts } : {}) };
      next = without('hosts', undefined, without('workspaces', undefined, without('clones', undefined, next)));
    } else next = { ...next, ...parked.current };
    onChange(next);
  };
  const source = named ? t.config.settings.source.clones : own !== undefined ? t.config.settings.source.machine : base ? t.config.settings.source[base.source] : undefined;
  const listed = (repo.workspaces ?? []).filter((w) => w.trim() && !itself(w)).length;
  // what saving does to the clones registered now: those it no longer names leave the pool, a card's once it is done
  const leaving = resolved?.leaving?.length ? <p className="hint cfg-clone-leaving">{t.config.cloneLeaving(resolved.leaving.map((c) => (c.card ? { ...c, card: plain(c.card) } : c)))}</p> : null;
  const slots = (hint: string, placeholder: string) => (
    <Field className="cfg-slots" label={<>{t.config.slots} <Info text={hint} /></>}>
      <input type="number" min={0} max={20} aria-label={t.config.slots} placeholder={placeholder} value={repo.slots ?? ''} onChange={(e) => onChange(without('slots', slotsOf(e.target.value)))} />
      {leaving}
    </Field>
  );
  // a repository of the canvas: its path, what is wrong with it, then where its agents work and its settings, each group under a heading
  return (
    <section className="cfg-repo">
      <Field label={t.config.path} hint={home || folder ? [...(home ? [t.config.home] : []), ...(folder ? [t.config.folderMode] : [])].join(' · ') : undefined}>
        <div className="cfg-repo-path">
          <input className="c-path" aria-label={t.config.path} value={repo.path} placeholder={t.config.path} spellCheck={false} onChange={(e) => {
              // another folder: whether it goes without git is chosen for it anew
              const { git: _, ...rest } = repo;
              onChange({ ...rest, path: e.target.value });
            }} />
          <RemoveButton label={t.config.removeRepo} onClick={() => onChange(null)} />
        </div>
      </Field>
      {problems.map((p, k) => (
        <div key={k} className="cfg-repo-problem">
          <Problem problem={p} where={where} ask={ask} retried={ask && onRecheck} />
          {p.code === 'notRepo' && noGit && <GitSetup key={noGit} path={noGit} confirm={t.setup.git.confirm} onDone={onRecheck} onFolder={() => onChange({ path: repo.path, git: false, ...(repo.settings ? { settings: repo.settings } : {}) })} />}
          {p.code === 'untrusted' && resolved?.trust && <TrustCommands path={repo.path} trust={resolved.trust} onDone={onRecheck} />}
        </div>
      ))}
      {/* a repository without settings of its own, or with an adapter module that said them: a card on its canvas writes them, also before the canvas is saved */}
      {canvasId && resolved && !folder && (resolved.adapterGone || !fromRepository(resolved.values)) && <AdapterSetup canvas={canvasId} repo={resolved.id} takeover={takeover} />}
      {!folder && (resolved || clones) && (
        <div ref={clonesBox} className={flash ? 'cfg-group flash' : 'cfg-group'}>
          <h5 className="cfg-group-head">{t.config.groups.workspaces}</h5>
          <div className="cfg-field cfg-setting cfg-has-info">
            <div className="cfg-label">
              {t.config.settings.workspaces}
              {source && <span className={source === t.config.settings.source.machine ? 'cfg-source here' : 'cfg-source'}>{source}</span>}
              <Info text={t.config.settings.workspacesHint} />
            </div>
            <div className="cfg-control">
              <div className="seg" role="radiogroup" aria-label={t.config.settings.workspaces}>
                {(['worktrees', 'clones'] as const).map((x) => (
                  <button key={x} type="button" role="radio" aria-checked={workIn === x} className={workIn === x ? 'on' : undefined} onClick={() => setWorkIn(x)}>
                    {t.config.settings.workIn[x]}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {clones ? (
            <>
              <Field label={t.config.workspaces}>
                <textarea
                  ref={existing}
                  className="cfg-existing"
                  rows={2}
                  spellCheck={false}
                  aria-label={t.config.workspaces}
                  value={existingText}
                  onChange={(e) => {
                    const list = e.target.value.split('\n');
                    onChange(without('workspaces', list.some((w) => w.trim()) ? list : undefined));
                  }}
                />
                {(repo.workspaces ?? []).some(itself) && <p className="hint">{t.config.cloneIsRepo}</p>}
              </Field>
              <Field className="cfg-clone-count" label={<>{t.config.clones} <Info text={t.config.clonesHint} /></>}>
                <input type="number" min={0} max={20} aria-label={t.config.clones} placeholder="0" value={repo.clones ?? ''} onChange={(e) => onChange(without('clones', Number(e.target.value) || undefined))} />
                {listed + (repo.clones ?? 0) + (repo.hosts ?? []).reduce((n, h) => n + h.clones, 0) === 0 ? (
                  <p className="hint warn">{t.config.noClones}</p>
                ) : (
                  <p className="hint">{t.config.cloneTotal(listed, repo.clones ?? 0)}</p>
                )}
              </Field>
              {slots(t.config.slotsHint, t.config.slotsAll)}
              <Field className="cfg-wide" label={<>{t.config.hosts} <Info text={t.config.hostsHint} /></>}>
                <Hosts hosts={repo.hosts ?? []} onChange={(hosts) => onChange(without('hosts', hosts.length ? hosts : undefined))} />
              </Field>
            </>
          ) : (
            slots(t.config.slotsWorktreesHint, t.config.slotsAny)
          )}
        </div>
      )}
      {resolved && (
        <RepoSettingsBlock
          show={focus?.field === 'settings' ? focus : undefined}
          folder={folder}
          repo={repo}
          values={resolved.values}
          shareTo={resolved.shareTo}
          shareDirect={!!resolved.shareDirect}
          takeover={takeover}
          onChange={(settings) => onChange(without('settings', settings))}
        />
      )}
    </section>
  );
}

/**
 * The settings of a repository, set on this machine (`RepoSettings`); those of `app` and `demo` each
 * on its own, `demo.language` as `demoLanguage` beside the repository's own `language`.
 */
type SettingKey = Exclude<keyof RepoSettings, NestedSetting> | 'run' | 'stop' | 'keep' | 'site' | 'demoLanguage';

/** The setting of `app` or `demo` that holds `k`, and its field there, if one does. */
function nestedOf(k: SettingKey): [NestedSetting, string] | undefined {
  if (k === 'demoLanguage') return ['demo', 'language'];
  if (k === 'language') return undefined;
  const n = (Object.keys(NESTED_SETTINGS) as NestedSetting[]).find((n) => (NESTED_SETTINGS[n] as readonly string[]).includes(k));
  return n && [n, k];
}

/**
 * A repository's settings for this machine, below where its agents work, in groups under a heading
 * each (branch and landing, app and checks, plans and language, demos): each shows the value that
 * applies and where it comes from; changing one sets it on this machine, „Zurücksetzen“
 * takes it back to its source. Saved with the configuration; they apply at once.
 */
function RepoSettingsBlock({
  show,
  folder,
  repo,
  values,
  shareTo,
  shareDirect,
  takeover,
  onChange,
}: {
  /** The setting to scroll to and mark: the dialog was opened from a proposal for it. */
  show: ConfigFocus | undefined;
  /** A folder without git: what is about branches, landing and workspaces does not apply. */
  folder: boolean;
  repo: RepoConfig;
  values: RepoValues;
  shareTo: 'main' | 'pr';
  shareDirect: boolean;
  takeover: Takeover;
  onChange: (s: RepoSettings | undefined) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!show) return;
    setShown(show.setting ?? null);
    const h = setTimeout(() => setShown(null), 2400);
    return () => clearTimeout(h);
  }, [show]);
  useEffect(() => {
    if (shown) box.current?.querySelector(`[data-setting="${shown}"]`)?.scrollIntoView({ block: 'center' });
  }, [shown]);
  const c = t.config.settings;
  const s = repo.settings ?? {};
  const { app: _, demo: __, ...flat } = values;
  const base: Record<SettingKey, SettingValue<unknown>> = { ...flat, ...values.app, site: values.demo.site, demoLanguage: values.demo.language };
  const own = (k: SettingKey): unknown => {
    const n = nestedOf(k);
    return n ? (s[n[0]] as Record<string, unknown> | undefined)?.[n[1]] : s[k as keyof RepoSettings];
  };
  const value = <T,>(k: SettingKey) => (own(k) ?? base[k].value) as T;
  const set = (k: SettingKey, v: unknown) => {
    const next: Record<string, unknown> = { ...s };
    const n = nestedOf(k);
    const at: Record<string, unknown> = n ? { ...s[n[0]] } : next;
    const field = n?.[1] ?? k;
    if (v === undefined) delete at[field];
    else at[field] = v;
    if (n) {
      if (Object.keys(at).length) next[n[0]] = at;
      else delete next[n[0]];
    }
    onChange(Object.keys(next).length ? (next as RepoSettings) : undefined);
  };
  const lines = (k: SettingKey) => value<string[]>(k).join('\n');
  // a setting: its label with where its value comes from (and „Zurücksetzen“ where it is set here), its control and what to know about it
  const field = (key: string, label: string, here: boolean, from: string, reset: () => void, control: ReactNode, hint?: string) => (
    <div className={shown === key ? 'cfg-field cfg-setting flash' : 'cfg-field cfg-setting'} key={key} data-setting={key}>
      <div className="cfg-label">
        {label}
        <span className={here ? 'cfg-source here' : 'cfg-source'}>{here ? c.source.machine : from}</span>
        {here && (
          <button type="button" className="cfg-reset" title={c.resetHint} onClick={reset}>
            {c.reset}
          </button>
        )}
      </div>
      <div className="cfg-control">
        {control}
        {hint && <p className="hint">{hint}</p>}
      </div>
    </div>
  );
  const row = (k: SettingKey, label: string, control: ReactNode, hint?: string) => {
    const from = base[k].source;
    return field(k, label, own(k) !== undefined, base[k].held ? c.held : c.source[from], () => set(k, undefined), control, hint);
  };
  const land = value<'main' | 'pr'>('land');
  const planDocs = value<{ dir: string; exclude: string[] }>('planDocs');
  const language = value<Language>('language');
  const demoLanguage = value<NarrationLanguage | null>('demoLanguage');
  const site = value<DemoSite | null>('site') ?? { title: '', url: '', deploy: '' };
  const setSite = (patch: Partial<DemoSite>) => set('site', { ...site, ...patch });
  // a repository without a site: Obeya sets one up; the fields are for another host, entered by hand
  const [manualSite, setManualSite] = useState(false);
  const siteFields = manualSite || folder || !!(site.url.trim() || site.title.trim() || site.deploy.trim());
  // a part of a setting with several fields: its label above it; a wide one takes the whole row
  const sub = (label: string, control: ReactNode, wide = false) => (
    <label className={wide ? 'wide' : undefined}>
      <span className="hint">{label}</span>
      {control}
    </label>
  );
  return (
    <div className="cfg-settings" ref={box}>
      {!folder && (
        <div className="cfg-group">
          <h5 className="cfg-group-head">{t.config.groups.landing}</h5>
          {row('branch', c.branch, <input className="c-path" aria-label={c.branch} spellCheck={false} value={value<string>('branch')} onChange={(e) => set('branch', e.target.value)} />, c.branchHint)}
          {row(
            'land',
            c.land,
            <div className="seg" role="radiogroup" aria-label={c.land}>
              {(['main', 'pr'] as const).map((x) => (
                <button key={x} type="button" role="radio" aria-checked={land === x} className={land === x ? 'on' : undefined} onClick={() => set('land', x)}>
                  {c.lands[x]}
                </button>
              ))}
            </div>,
            c.landHint,
          )}
          {land === 'pr' &&
            row(
              'direct',
              c.direct,
              <label className="c-check">
                <input type="checkbox" checked={value<boolean>('direct')} onChange={(e) => set('direct', e.target.checked)} />
                {c.directLabel}
              </label>,
            )}
          {land === 'pr' &&
            row(
              'autoMerge',
              c.autoMerge,
              <label className="c-check">
                <input type="checkbox" checked={value<boolean>('autoMerge')} onChange={(e) => set('autoMerge', e.target.checked)} />
                {c.autoMergeLabel}
              </label>,
              c.autoMergeHint,
            )}
          {land === 'pr' && row('prNoise', c.prNoise, <textarea rows={2} spellCheck={false} aria-label={c.prNoise} value={lines('prNoise')} onChange={(e) => set('prNoise', e.target.value.split('\n'))} />, c.prNoiseHint)}
          {row('softPaths', c.softPaths, <textarea rows={Math.max(2, value<string[]>('softPaths').length + 1)} spellCheck={false} aria-label={c.softPaths} value={lines('softPaths')} onChange={(e) => set('softPaths', e.target.value.split('\n'))} />, c.softPathsHint)}
        </div>
      )}
      <div className="cfg-group">
        <h5 className="cfg-group-head">{t.config.groups.app}</h5>
        {row('setup', c.setup, <input className="c-path" aria-label={c.setup} spellCheck={false} value={value<string>('setup')} onChange={(e) => set('setup', e.target.value)} />, c.setupHint)}
        {row('checks', c.checks, <textarea rows={Math.max(2, value<string[]>('checks').length + 1)} spellCheck={false} aria-label={c.checks} value={lines('checks')} onChange={(e) => set('checks', e.target.value.split('\n'))} />, c.checksHint)}
        {row('run', c.run, <textarea rows={Math.max(6, Math.ceil(value<string>('run').length / 70) + 1)} aria-label={c.run} placeholder={c.runPlaceholder} value={value<string>('run')} onChange={(e) => set('run', e.target.value)} />, c.runHint)}
        {row('stop', c.stop, <input className="c-path" aria-label={c.stop} placeholder="docker compose down" spellCheck={false} value={value<string>('stop')} onChange={(e) => set('stop', e.target.value)} />, c.stopHint)}
        {!!value<string>('stop').trim() &&
          row('keep', c.keep, <input className="c-path" aria-label={c.keep} placeholder="grep -q PERSIST=1 .env" spellCheck={false} value={value<string>('keep')} onChange={(e) => set('keep', e.target.value)} />, c.keepHint)}
      </div>
      <div className="cfg-group">
        <h5 className="cfg-group-head">{t.config.groups.plans}</h5>
        {row(
          'planDocs',
          c.planDocs,
          <div className="cfg-plan">
            <input className="c-path" aria-label={c.planDir} placeholder={c.planDir} spellCheck={false} value={planDocs.dir} onChange={(e) => set('planDocs', { ...planDocs, dir: e.target.value })} />
            <input className="c-path" aria-label={c.planExclude} placeholder={c.planExclude} spellCheck={false} value={planDocs.exclude.join(', ')} onChange={(e) => set('planDocs', { ...planDocs, exclude: e.target.value.split(/,\s*/) })} />
          </div>,
          c.planDocsHint,
        )}
        {row(
          'language',
          c.language,
          <div className="seg" role="radiogroup" aria-label={c.language}>
            {LANGUAGES.map((x) => (
              <button key={x} type="button" role="radio" aria-checked={language === x} className={language === x ? 'on' : undefined} onClick={() => set('language', x)}>
                {c.languages[x]}
              </button>
            ))}
          </div>,
          c.languageHint,
        )}
      </div>
      <div className="cfg-group">
        <h5 className="cfg-group-head">{t.config.groups.demos}</h5>
        {row(
          'demoLanguage',
          c.demoLanguage,
          <div className="seg" role="radiogroup" aria-label={c.demoLanguage}>
            {LANGUAGES.map((x) => (
              <button key={x} type="button" role="radio" aria-checked={demoLanguage === x} className={demoLanguage === x ? 'on' : undefined} onClick={() => set('demoLanguage', x)}>
                {c.languages[x]}
              </button>
            ))}
          </div>,
          c.demoLanguageHint,
        )}
        {row(
          'site',
          c.site,
          <div className="cfg-sub">
            {!folder && <SiteSetupRow path={repo.path} name={repo.path.trim().split(/[\\/]/).filter(Boolean).pop() ?? ''} empty={!site.url.trim()} onSite={(made) => set('site', made)} />}
            {!siteFields ? (
              <button type="button" className="link wide site-manual" onClick={() => setManualSite(true)}>
                {c.siteManual}
              </button>
            ) : (
              <>
            {sub(c.siteTitle, <input className="c-path" aria-label={c.siteTitle} spellCheck={false} value={site.title} onChange={(e) => setSite({ title: e.target.value })} />)}
            {sub(c.siteUrl, <input className="c-path" aria-label={c.siteUrl} placeholder="https://demos.example.com" spellCheck={false} value={site.url} onChange={(e) => setSite({ url: e.target.value })} />)}
            {sub(c.siteDeploy, <input className="c-path" aria-label={c.siteDeploy} placeholder="bunx wrangler@4 pages deploy {dir} --project-name demos" spellCheck={false} value={site.deploy} onChange={(e) => setSite({ deploy: e.target.value })} />, true)}
            {sub(c.siteEnv, <input className="c-path" aria-label={c.siteEnv} placeholder="sites/demos/deploy.env" spellCheck={false} value={site.env ?? ''} onChange={(e) => setSite({ env: e.target.value })} />, true)}
            {sub(
              c.siteHeaders,
              <textarea
                rows={Math.max(2, Object.keys(site.headers ?? {}).length + 1)}
                spellCheck={false}
                aria-label={c.siteHeaders}
                placeholder={'CF-Access-Client-Id: ${CF_ID}'}
                value={Object.entries(site.headers ?? {})
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')}
                onChange={(e) => setSite({ headers: headerLines(e.target.value) })}
              />,
              true,
            )}
            {sub(
              c.siteMaxFile,
              <input
                className="c-path"
                type="number"
                min={1}
                aria-label={c.siteMaxFile}
                placeholder="25"
                value={site.maxFile ? Math.round(site.maxFile / MIB) : ''}
                onChange={(e) => setSite({ maxFile: Number(e.target.value) > 0 ? Math.round(Number(e.target.value) * MIB) : undefined })}
              />,
            )}
            {sub(c.siteTags, <TagLines tags={site.tags} placeholder={c.siteTagsPlaceholder} label={c.siteTags} onChange={(tags) => setSite({ tags })} />, true)}
            {/* not a label: a click on its words would press the first button */}
            <div className="wide">
              <span className="hint">{c.sitePublish}</span>
              <div className="seg" role="radiogroup" aria-label={c.sitePublish}>
                {(['click', 'approved'] as const).map((x) => {
                  const on = (site.publish ?? 'click') === x;
                  return (
                    <button key={x} type="button" role="radio" aria-checked={on} className={on ? 'on' : undefined} onClick={() => setSite({ publish: x === 'approved' ? x : undefined })}>
                      {c.sitePublishes[x]}
                    </button>
                  );
                })}
              </div>
            </div>
              </>
            )}
          </div>,
          c.siteHint,
        )}
      </div>
      {/* the folder's settings file is written there like any other file; there is no commit or pull request to make */}
      {!folder && <ShareSettings repo={repo} values={values} branch={value<string>('branch')} shareTo={shareTo} shareDirect={shareDirect} takeover={takeover} />}
    </div>
  );
}

/**
 * „Demo-Seite einrichten“ at a repository without a site: the host chosen, Obeya creates the site
 * there (in the background, with a login in the browser maybe) and fills in its fields, which
 * „Speichern“ then takes over. A setup that finished while the dialog was closed is taken in when it
 * opens again.
 */
function SiteSetupRow({ path, name, empty, onSite }: { path: string; name: string; empty: boolean; onSite: (site: DemoSite) => void }) {
  const [open, setOpen] = useState(false);
  // in the order of the personal site's hosts: GitHub first
  const [host, setHost] = useState<'cloudflare' | 'github'>('github');
  const [accounts, setAccounts] = useState<string[]>([]);
  const [way, setWay] = useState<CloudflareWay | null>(null);
  const [job, setJob] = useState<SiteSetupJob | null>(null);
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState('');
  const c = t.config.settings;
  const take = (j: SiteSetupJob | null) => {
    setJob(j);
    if (j && !j.running && j.site) {
      onSite(j.site);
      setDone(true);
      setOpen(false);
      void api.repoSiteTaken(path).catch(console.error);
    }
  };
  useEffect(() => {
    if (path.trim()) api.repoSiteSetup(path).then((r) => take(r.job), console.error);
  }, [path]);
  useEffect(() => {
    if (open) api.personalSite().then((v) => setAccounts(v.cloudflareAccounts), console.error);
  }, [open]);
  const chosen: CloudflareWay = way ?? { account: accounts[0] ?? '', token: '', accountId: '' };
  const running = !!job?.running;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => api.repoSiteSetup(path).then((r) => take(r.job), console.error), 1000);
    return () => clearInterval(timer);
  }, [running, path]);
  if (done) return <p className="hint wide">{c.siteSetupDone}</p>;
  if (!empty && !running) return null;
  return (
    <div className="wide site-setup">
      {!open && !running ? (
        <button type="button" className="btn small" title={c.siteSetupHint} onClick={() => setOpen(true)}>
          {c.siteSetup}
        </button>
      ) : (
        <>
          <p className="hint">{c.siteSetupHint}</p>
          <div className="seg" role="radiogroup" aria-label={c.siteSetup}>
            {(['github', 'cloudflare'] as const).map((h) => (
              <button key={h} type="button" role="radio" aria-checked={host === h} className={host === h ? 'on' : undefined} disabled={running} onClick={() => setHost(h)}>
                {c.siteSetupHosts[h]}
              </button>
            ))}
          </div>
          <p className="hint">{c.siteSetupNotes[host]}</p>
          {host === 'cloudflare' && <CloudflareAccount accounts={accounts} way={chosen} onChange={setWay} disabled={running} />}
          <button
            type="button"
            className="btn small primary"
            disabled={running}
            onClick={async () => {
              setStatus('');
              try {
                take((await api.setUpRepoSite(path, host, name, host === 'cloudflare' ? cloudflareHow(chosen) : {})).job);
              } catch (e) {
                setStatus(failText(e));
              }
            }}
          >
            {running ? c.siteSetupRunning : c.siteSetupGo}
          </button>
          {running && job!.lines.length > 0 && <p className="hint c-install">{job!.lines.at(-1)}</p>}
        </>
      )}
      {job?.error && !running && (
        <p className="p-error">
          {c.siteSetupFailed} {job.error}
        </p>
      )}
      {status && <p className="p-error">{status}</p>}
    </div>
  );
}

/** Whether the repository has settings for everyone (`.obeya/settings.json`): then it is set up. */
const fromRepository = (v: RepoValues) => SHARED_FIELDS.some((k) => (isNested(k) ? Object.values(v[k]).some((f) => f.source === 'repository') : v[k].source === 'repository'));

const MIB = 1024 * 1024;

/**
 * The site's vocabulary of tags, a dimension per line (`Area: Billing, Reports`): the text stays as
 * typed while the owner writes (a trailing comma, an empty line), and what it says goes to the setting.
 */
function TagLines({ tags, placeholder, label, onChange }: { tags: PageTags | undefined; placeholder: string; label: string; onChange: (tags: PageTags | undefined) => void }) {
  const [text, setText] = useState(() => tagLines(tags));
  // the setting changed elsewhere (another machine's file, a reset): its lines, unless they say the same
  useEffect(() => {
    if (JSON.stringify(parseTagLines(text)) !== JSON.stringify(tags)) setText(tagLines(tags));
  }, [JSON.stringify(tags)]);
  return (
    <textarea
      rows={Math.max(2, text.split('\n').length + 1)}
      spellCheck={false}
      aria-label={label}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseTagLines(e.target.value));
      }}
    />
  );
}

/** The headers of `Name: value` lines; none for lines without a name. */
function headerLines(text: string): Record<string, string> | undefined {
  const pairs = text
    .split('\n')
    .map((l) => l.match(/^([^:]+):\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m && !!m[1]!.trim())
    .map((m) => [m[1]!.trim(), m[2]!] as const);
  return pairs.length ? Object.fromEntries(pairs) : undefined;
}

/** The repository's `.obeya/settings.json` as the dialog shows it: what the file holds now (`values` from the repository) with this machine's settings in front, but the main branch. */
function sharedPreview(repo: RepoConfig, values: RepoValues): Record<string, unknown> {
  const file: Record<string, unknown> = {};
  for (const k of SHARED_FIELDS) {
    if (isNested(k)) {
      const fields = Object.entries(values[k] as Record<string, SettingValue<unknown>>).filter(([, f]) => f.source === 'repository');
      if (fields.length) file[k] = Object.fromEntries(fields.map(([f, v]) => [f, v.value]));
    } else if (values[k].source === 'repository') file[k] = values[k].value;
  }
  const { branch: _, ...mine } = repo.settings ?? {};
  const merged = layerSettings<Record<string, unknown>>(file, mine as Record<string, unknown>) ?? {};
  return Object.fromEntries(SHARED_FIELDS.filter((k) => merged[k] !== undefined).map((k) => [k, merged[k]]));
}

/**
 * „Für alle ins Repository übernehmen“ under a repository's settings: this machine's values (but
 * the main branch) go into its `.obeya/settings.json`, so that everyone who clones it gets them.
 * It first shows the file as it would be and where it goes (a commit on the main branch, or a pull
 * request), then does it at the owner's word. Only for the configuration as saved.
 */
function ShareSettings({ repo, values, branch, shareTo, shareDirect, takeover }: { repo: RepoConfig; values: RepoValues; branch: string; shareTo: 'main' | 'pr'; shareDirect: boolean; takeover: Takeover }) {
  const c = t.config.settings.share;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SettingsShared | null>(null);
  const [error, setError] = useState('');
  const { branch: _, ...mine } = repo.settings ?? {};
  const count = Object.keys(mine).length + (mine.demo ? Object.keys(mine.demo).length - 1 : 0);
  const { saved, onReload, prepare } = takeover;
  const go = async (direct = false) => {
    setBusy(true);
    setError('');
    try {
      // what is taken over is what is saved: the dialog's changes are saved first (why not, its status line says)
      if (!saved && !(await prepare?.())) return setBusy(false);
      const r = await api.shareSettings(repo.path, direct);
      setDone(r);
      setConfirming(false);
      if ('committed' in r) await onReload();
    } catch (e) {
      setError(failText(e, { detail: ['settingsShare'] }));
    }
    setBusy(false);
  };
  return (
    <div className="cfg-field cfg-setting cfg-share-settings">
      <div className="cfg-label">{c.label}</div>
      <div className="cfg-control">
        {done && 'committed' in done && <p className="hint ok">{c.committed(done.branch, done.committed.slice(0, 7))}</p>}
        {done && 'pr' in done && (
          <p className="hint ok">
            {c.opened}{' '}
            <a href={done.pr} target="_blank" rel="noreferrer">
              {done.pr}
            </a>
            {c.openedAfter}
          </p>
        )}
        {!done && !count && <p className="hint">{c.none}</p>}
        {!done && count > 0 && !confirming && (
          <>
            <button type="button" className="btn small" disabled={!saved && !prepare} onClick={() => setConfirming(true)}>
              {c.button(count)}
            </button>
            <p className="hint">{saved || prepare ? `${c.hint}${repo.settings?.branch ? ` ${c.hintBranch}` : ''}` : c.saveFirst}</p>
          </>
        )}
        {confirming && (
          <div className="cfg-share-confirm">
            {!saved && <p className="hint">{c.savesFirst}</p>}
            <p className="hint">{shareTo === 'main' ? c.toMain(branch) : shareDirect ? c.toPrOrDirect(branch) : c.toPr(branch)}</p>
            <pre className="c-json">
              <span className="hint">.obeya/settings.json</span>
              {'\n'}
              {JSON.stringify(sharedPreview(repo, values), null, 2)}
            </pre>
            <div className="cfg-share-actions">
              <button type="button" className="btn primary small" disabled={busy} onClick={() => go()}>
                {shareTo === 'main' ? c.commit : c.openPr}
              </button>
              {shareTo === 'pr' && shareDirect && (
                <button type="button" className="btn small" disabled={busy} onClick={() => go(true)}>
                  {c.pushDirect(branch)}
                </button>
              )}
              <button type="button" className="btn small" disabled={busy} onClick={() => setConfirming(false)}>
                {c.cancel}
              </button>
            </div>
          </div>
        )}
        {error && <p className="hint warn">{error}</p>}
      </div>
    </div>
  );
}

/** A slot count as typed: empty is none set (as many as there are clones, any number in worktrees), 0 takes no new cards. */
function slotsOf(value: string): number | undefined {
  return value.trim() === '' || !Number.isFinite(Number(value)) ? undefined : Math.max(0, Math.round(Number(value)));
}

/**
 * Removes an entry of the configuration (a canvas, a repository, a host): a waste bin, so that it
 * does not pass for the dialog's close button, shown while the pointer or focus is on its entry.
 */
function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="c-del c-remove" title={label} aria-label={label} onClick={onClick}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10.5 11v5.5M13.5 11v5.5" />
      </svg>
    </button>
  );
}

/** The machines over SSH a repository's workers also run on: a table, one row each. */
function Hosts({ hosts, onChange }: { hosts: HostConfig[]; onChange: (hosts: HostConfig[]) => void }) {
  const set = (i: number, h: HostConfig | null) => onChange(h ? hosts.map((x, k) => (k === i ? h : x)) : hosts.filter((_, k) => k !== i));
  return (
    <div className="cfg-hosts">
      {hosts.length > 0 && (
        <div className="cfg-host-rows">
          {hosts.map((h, i) => (
            <div key={i} className="cfg-host">
              <input aria-label={t.config.hostName} value={h.name} placeholder={t.config.hostName} spellCheck={false} onChange={(e) => set(i, { ...h, name: e.target.value })} />
              <input className="c-path" aria-label={t.config.hostSsh} value={h.ssh} placeholder={t.config.hostSsh} spellCheck={false} onChange={(e) => set(i, { ...h, ssh: e.target.value })} />
              <input className="c-path" aria-label={t.config.hostRoot} value={h.root} placeholder={t.config.hostRoot} spellCheck={false} onChange={(e) => set(i, { ...h, root: e.target.value })} />
              <label className="cfg-host-clones">
                <span className="hint">{t.config.hostClones}</span>
                <input type="number" min={0} max={20} value={h.clones} onChange={(e) => set(i, { ...h, clones: Number(e.target.value) || 0 })} />
              </label>
              <label className="cfg-host-clones cfg-has-info">
                <span className="hint">
                  {t.config.hostSlots} <Info text={t.config.slotsHint} />
                </span>
                <input
                  type="number"
                  min={0}
                  max={20}
                  aria-label={t.config.hostSlots}
                  placeholder={t.config.slotsAll}
                  value={h.slots ?? ''}
                  onChange={(e) => {
                    const { slots: _, ...rest } = h;
                    const slots = slotsOf(e.target.value);
                    set(i, slots === undefined ? rest : { ...rest, slots });
                  }}
                />
              </label>
              <RemoveButton label={t.config.removeHost} onClick={() => set(i, null)} />
            </div>
          ))}
        </div>
      )}
      <button className="btn small" onClick={() => onChange([...hosts, { name: '', ssh: '', root: '', clones: 2 }])}>
        {t.config.addHost}
      </button>
    </div>
  );
}

// problems whose detail says what to fix, in the repository's settings rather than here, or why something did not start
const DETAILED: ConfigProblem['code'][] = ['demoSite', 'adapterGone', 'repoSettings', 'hostName', ...START_FAILED];

/**
 * A problem of the configuration: what is wrong, the technical detail folded away where it says
 * what to fix, and a button that has the Koordinator create a task that fixes it (with the detail, which it reads).
 * What did not start as saved tries again with „Erneut versuchen“, where `retried` is given (called after it).
 */
export function Problem({ problem, where, ask, retried }: { problem: ConfigProblem; where: string; ask?: (text: string) => void; retried?: () => void }) {
  const [asked, setAsked] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const text = t.config.problem[problem.code];
  const retry = async () => {
    setRetrying(true);
    setError('');
    try {
      await api.retryStart();
      retried?.();
    } catch (e) {
      setError(failText(e));
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div className="p-error c-problem">
      {text}
      {DETAILED.includes(problem.code) && (
        <details>
          <summary>{t.config.details}</summary>
          <code>{problem.detail}</code>
        </details>
      )}
      {retried && START_FAILED.includes(problem.code) && (
        <button className="btn small" disabled={retrying} onClick={() => void retry()}>
          {t.config.retry}
        </button>
      )}
      {error && <p>{error}</p>}
      {/* commands to trust are the owner's to look at, not a task's to fix */}
      {ask && problem.code !== 'untrusted' && (
        <button
          className="btn small"
          disabled={asked}
          onClick={() => {
            setAsked(true);
            ask(t.config.fixRequest(where, text, problem.detail));
          }}
        >
          {t.config.askFix}
        </button>
      )}
    </div>
  );
}

/**
 * The commands of a repository that wait for the owner's trust (problem `untrusted`): each group
 * with what it does and its lines as last trusted against those on the main branch now, and the
 * button that trusts them; the dialog checks again after it.
 */
function TrustCommands({ path, trust, onDone }: { path: string; trust: RepoTrust; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const c = t.config.trust;
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await api.trustCommands(path, trust);
      onDone();
    } catch (e) {
      setError(failText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="c-trust">
      {trust.held.map((g) => (
        <div key={g} className="c-trust-group">
          <p className="hint">{c[g]}</p>
          <div className="d-lines">
            {lineDiff(commandLines(trust.before, g), commandLines(trust.now, g)).map((d, i) => (
              <div key={i} className={d.kind === '+' ? 'd-add' : d.kind === '-' ? 'd-del' : undefined}>
                <span className="d-no">{d.kind === ' ' ? '' : d.kind === '+' ? '+' : '−'}</span>
                <span className="d-text">{d.line}</span>
              </div>
            ))}
          </div>
          {g === 'claude' && blankOnly(trust).length > 0 && <p className="hint">{c.blankOnly(blankOnly(trust).join(', '))}</p>}
        </div>
      ))}
      <button className="btn small" disabled={busy} onClick={go}>
        {c.trust}
      </button>
      {error && <p className="p-error">{error}</p>}
    </div>
  );
}

/** The files of the Claude Code configuration whose change the diff cannot show: other contents, the same text but for space at its start or end. */
const blankOnly = (trust: RepoTrust) =>
  Object.entries(trust.now.claude ?? {}).flatMap(([file, f]) => {
    const was = trust.before?.claude?.[file];
    return was && was.id !== f.id && was.text === f.text ? [file] : [];
  });

/**
 * Creates the card that writes the repository's settings for everyone, and opens it on its canvas;
 * the dialog's changes are saved first, so the canvas runs with the repository on it.
 */
function AdapterSetup({ canvas, repo, takeover }: { canvas: string; repo: string; takeover: Takeover }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { saved, prepare } = takeover;
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      if (!saved && !(await prepare?.())) return setBusy(false);
      const card = await api.adapterSetup(canvas, repo);
      // the canvas loads with the card open, as after a restart
      keep(sessionStorage, canvas, { at: Date.now(), card: card.id, scroll: [], drafts: [] });
      location.assign(canvasPath(canvas));
    } catch (e) {
      setError(failText(e));
      setBusy(false);
    }
  };
  return (
    <div className="c-row">
      <span className="hint">
        {t.config.adapterSetupHint}
        {!saved && <> {prepare ? t.config.adapterSetupSaves : t.config.adapterSetupSaveFirst}</>}
      </span>
      <button className="btn small" disabled={busy || (!saved && !prepare)} onClick={go}>
        {t.config.adapterSetup}
      </button>
      {error && <p className="p-error">{error}</p>}
    </div>
  );
}
