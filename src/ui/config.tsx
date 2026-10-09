// Obeya's configuration: the canvases it serves and their repositories, edited here and saved;
// Obeya then starts again with it. The server's own settings come from its command line and show
// read-only.

import { Fragment, useEffect, useRef, useState } from 'react';
import { AGENT_EFFORTS, AGENT_MODELS, AGENT_ROLES, type AgentEffort, type AgentModel, type AgentRole, type AgentSetting, type AgentsView, blocksSaving, type CanvasConfig, type ConfigProblem, type ConfigView, type DemoSettings, type DemoSettingsView, type DemoVoiceCheck, type Language, type LanguageView, type NarrationLanguage, type RepoConfig, type SetupCheck, type VoiceKind, type VoiceSetupView } from '../core/types';
import { LANGUAGES } from '../core/locale';
import { pushKeyFromEvent, type PushKeyView } from '../core/push-key';
import { api, ApiError, reload } from './api';
import { keep } from './keep';
import { demoState, megabytes, PLATFORMS, SetupList, voiceState } from './setup';
import { errorText, pushKeyLabel, t } from './strings';

declare global {
  interface Window {
    /** Set by the app (app/src/main.rs) in its window; absent in a browser. */
    obeyaApp?: { version: string; platform: string };
  }
}

type Checked = Pick<ConfigView, 'resolved' | 'problems'>;

/** Hands the Koordinator a request; to the one of `canvas` where given, else to this page's. */
type Ask = (text: string, canvas?: string) => void;

export function ConfigSheet({ on, onSetup, onAsk, onProblems }: { on: boolean; onSetup: () => void; onAsk: Ask; onProblems: (n: number) => void }) {
  const [view, setView] = useState<ConfigView | null>(null);
  const [draft, setDraft] = useState<CanvasConfig[]>([]);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [json, setJson] = useState(false);
  // the id each canvas of the draft had when loaded: renaming a running canvas keeps it, and its cards
  const [origin, setOrigin] = useState<(string | null)[]>([]);
  const load = (v: ConfigView) => {
    setDraft(v.canvases);
    setOrigin(v.resolved.map((r) => r?.id ?? null));
  };

  // read afresh whenever the sheet opens: the Koordinator or the file may have changed it
  useEffect(() => {
    if (!on) return;
    api.config().then((v) => {
      setView(v);
      load(v);
      setChecked(v);
      onProblems(v.problems.length);
      setStatus(v.restarting ? t.config.saved : '');
    }, console.error);
  }, [on]);

  const changed = !!view && JSON.stringify(draft) !== JSON.stringify(view.canvases);
  // the draft is checked as it is edited: paths, adapters, ids
  const seq = useRef(0);
  useEffect(() => {
    if (!view || !changed) return void (view && setChecked(view));
    const n = ++seq.current;
    const h = setTimeout(() => api.checkConfig(draft).then((c) => n === seq.current && setChecked(c), console.error), 300);
    return () => clearTimeout(h);
  }, [draft, view]);

  if (!view) {
    return (
      <aside id="csheet" className={on ? 'sheet on' : 'sheet'}>
        <div className="p-kind">{t.config.kind}</div>
        <h2>{t.config.title}</h2>
        <p className="hint">{t.config.loading}</p>
      </aside>
    );
  }

  const problems = checked?.problems ?? [];
  const setCanvas = (i: number, c: CanvasConfig | null) => {
    setDraft(c ? draft.map((x, j) => (j === i ? c : x)) : draft.filter((_, j) => j !== i));
    if (!c) setOrigin(origin.filter((_, j) => j !== i));
  };
  const save = async () => {
    setBusy(true);
    try {
      const { restarting } = await api.saveConfig(draft);
      setView({ ...view, canvases: draft, restarting });
      setStatus(restarting ? t.config.saved : t.config.savedOnly);
    } catch (e) {
      setStatus(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
    setBusy(false);
  };
  // a canvas with a problem has no id yet: which running canvas goes is only known once all resolve
  const resolved = checked?.resolved ?? [];
  const gone = resolved.every(Boolean) ? view.running.filter((id) => !resolved.some((r) => r?.id === id)) : [];

  return (
    <aside id="csheet" className={on ? 'sheet on' : 'sheet'}>
      <div className="p-kind">{t.config.kind}</div>
      <h2>{t.config.title}</h2>
      {view.source === 'file' ? (
        <p className="hint">
          {t.config.fromFile} <code>{view.file}</code>
        </p>
      ) : (
        <p className="hint">{t.config.fromArgs(view.file)}</p>
      )}
      <p className="hint">{t.config.koordinator}</p>
      <button className="btn small" onClick={onSetup}>
        {t.setup.check}
      </button>

      {draft.map((c, i) => (
        <CanvasBlock
          key={i}
          n={i}
          canvas={c}
          resolved={checked?.resolved[i] ?? null}
          running={view.running}
          pin={origin[i] && view.running.includes(origin[i]) ? origin[i] : undefined}
          saved={!changed}
          adapters={view.adapters}
          problems={problems.filter((p) => p.canvas === i)}
          ask={changed ? undefined : onAsk}
          onChange={(x) => setCanvas(i, x)}
        />
      ))}
      <button
        className="btn small"
        onClick={() => {
          setDraft([...draft, { repos: [{ path: '' }] }]);
          setOrigin([...origin, null]);
        }}
      >
        {t.config.addCanvas}
      </button>
      {problems
        .filter((p) => p.canvas === undefined)
        .map((p, k) => (
          <Problem key={k} problem={p} where="" ask={changed ? undefined : onAsk} />
        ))}
      {changed && gone.length > 0 && <p className="hint warn">{t.config.gone(gone.join(', '))}</p>}

      <div className="c-actions">
        <button className="btn primary" disabled={!changed || busy || problems.some(blocksSaving)} onClick={save}>
          {view.server.restarts ? t.config.save : t.config.saveOnly}
        </button>
        {changed && (
          <button className="btn" disabled={busy} onClick={() => load(view)}>
            {t.config.reset}
          </button>
        )}
      </div>
      {status && <p className="hint c-status">{status}</p>}

      <LanguageBlock on={on} />
      <AgentsBlock on={on} />
      <VoiceBlock on={on} />
      <PushKeyBlock on={on} />
      <DemoBlock on={on} />

      <h4 className="p-h">{t.config.server}</h4>
      <dl className="c-server">
        <dt>{t.config.version}</dt>
        <dd>
          {view.server.version}
          {view.server.commit && <> · {t.config.checkout(view.server.commit.slice(0, 7))}</>}
        </dd>
        <dt>{t.config.port}</dt>
        <dd>{view.server.port}</dd>
        <dt>{t.config.dataDir}</dt>
        <dd>
          <code>{view.server.home}</code>
        </dd>
        <dt>{t.config.permissionMode}</dt>
        <dd>
          <code>{view.server.permissionMode}</code>
        </dd>
        <dt>{t.config.restarts}</dt>
        <dd>{!view.server.restarts ? t.config.no : view.server.commit ? t.config.yes : t.config.noCheckout}</dd>
      </dl>
      {/* in the app's window (app/src/main.rs), which opens a new window in the default browser */}
      {window.obeyaApp && (
        <button className="btn small" title={t.config.openInBrowserHint} onClick={() => window.open(location.href, '_blank')}>
          {t.config.openInBrowser}
        </button>
      )}

      <button className="btn small" onClick={() => setJson(!json)}>
        {t.config.json}
      </button>
      {json && <pre className="c-json">{JSON.stringify(draft, null, 2)}</pre>}
    </aside>
  );
}

/** Voices grouped as the settings sheet offers them; `say` only on a Mac. */
const VOICE_GROUPS: { group: 'local' | 'service' | 'own'; voices: VoiceKind[] }[] = [
  { group: 'local', voices: ['piper', 'qwen3', 'say'] },
  { group: 'service', voices: ['gemini', 'openai', 'elevenlabs', 'azure'] },
  { group: 'own', voices: ['command', 'http'] },
];
/** The fields each voice reads, in the order the sheet shows them. */
const VOICE_FIELDS: Record<VoiceKind, ('voiceName' | 'reference' | 'command' | 'url' | 'keyFile')[]> = {
  piper: ['voiceName'],
  qwen3: ['voiceName', 'reference'],
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

/** The language Obeya speaks to the owner: saved on its own, and the page loads again in it. */
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
      setStatus(e instanceof ApiError ? errorText(e.code) : t.offlineError);
      setBusy(false);
    }
  };
  return (
    <>
      <h4 className="p-h">{l.title}</h4>
      <section className="c-canvas c-demo c-language">
        <p className="hint">
          {l.hint} <code>{view.file}</code>
        </p>
        <label className="c-row">
          <span className="hint">{l.title}</span>
          <select value={view.chosen ?? ''} disabled={busy} onChange={(e) => choose((e.target.value || null) as Language | null)}>
            <option value="">{l.system(l.names[view.system])}</option>
            {LANGUAGES.map((x) => (
              <option key={x} value={x}>
                {l.names[x]}
              </option>
            ))}
          </select>
        </label>
        {status && <p className="hint c-status">{status}</p>}
      </section>
    </>
  );
}

/**
 * The push-to-talk key in another app, heard by the app's shell: what it hears, and the key, chosen
 * by pressing it. A modifier alone counts once it is let go without another key; with another key it
 * starts a combination.
 */
function PushKeyBlock({ on }: { on: boolean }) {
  const [view, setView] = useState<PushKeyView | null>(null);
  const [status, setStatus] = useState('');
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!on) return;
    const load = () => api.pushKey().then(setView, console.error);
    void load();
    // the shell reports every two seconds: what it hears shows here as it changes (an allowed permission, say)
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [on]);
  const save = async (key: string | null) => {
    setStatus('');
    try {
      setView(await api.savePushKey(key));
    } catch (e) {
      setStatus(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  };
  useEffect(() => {
    if (!listening) return;
    let modifier: string | null = null;
    const down = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') return setListening(false);
      if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(e.code)) {
        modifier = e.code;
        return;
      }
      modifier = null;
      const key = pushKeyFromEvent(e);
      setListening(false);
      if (key) void save(key);
      else setStatus(t.config.pushKey.notAKey);
    };
    const up = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== modifier) return;
      setListening(false);
      void save(modifier);
    };
    addEventListener('keydown', down, true);
    addEventListener('keyup', up, true);
    return () => {
      removeEventListener('keydown', down, true);
      removeEventListener('keyup', up, true);
    };
  }, [listening]);
  if (!view) return null;
  const p = t.config.pushKey;
  const shell = view.shell;
  const state = !shell
    ? p.appOnly
    : shell.state === 'on'
      ? shell.detail
        ? p.bound(shell.detail)
        : p.on(pushKeyLabel(view.key))
      : shell.state === 'permission' && shell.detail === 'restart'
        ? p.states.restart
        : shell.state === 'error'
          ? `${p.states.error}: ${shell.detail ?? ''}`
          : p.states[shell.state];
  return (
    <>
      <h4 className="p-h">{p.title}</h4>
      <section className={`c-canvas c-demo c-push-key${listening ? ' listening' : ''}`}>
        <p className="hint">{p.hint}</p>
        <div className="c-row">
          <span className="hint">{p.key}</span>
          <span>
            <kbd>{listening ? p.press : pushKeyLabel(view.key)}</kbd>{' '}
            <button className="btn small" disabled={listening} onClick={() => (setStatus(''), setListening(true))}>
              {p.change}
            </button>{' '}
            {view.chosen && (
              <button className="btn small" onClick={() => save(null)}>
                {p.reset(pushKeyLabel(view.default))}
              </button>
            )}
          </span>
        </div>
        {listening && <p className="hint">{p.pressHint}</p>}
        <p className={`hint${shell && shell.state !== 'on' ? ' warn' : ''}`}>
          {state}{' '}
          {shell?.state === 'permission' && shell.detail !== 'restart' && (
            <button className="btn small" onClick={() => window.open(INPUT_MONITORING, '_blank')}>
              {p.openSettings}
            </button>
          )}
        </p>
        {status && <p className="hint c-status">{status}</p>}
      </section>
    </>
  );
}

/** The macOS settings page where the app gets "Input Monitoring" (as src/server/push-key.ts). */
const INPUT_MONITORING = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';

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
      setStatus(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
    setBusy(false);
  };
  return (
    <>
      <h4 className="p-h">{a.title}</h4>
      <section className="c-canvas c-demo c-agents">
        <p className="hint">
          {a.hint} <code>{view.file}</code>
        </p>
        <div className="c-agents-grid">
          <span className="hint">{a.model}</span>
          <span className="hint">{a.effort}</span>
          {AGENT_ROLES.map((role) => {
            const setting = view.agents[role];
            return (
              <Fragment key={role}>
                <div className="c-agent-name">
                  {a.roles[role].name} <span className="hint">{a.roles[role].hint}</span>
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
      </section>
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
      setDraft(v.settings);
      setStatus('');
    }, console.error);
  }, [on]);
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
  // an installation runs on the server: follow it until it ends
  useEffect(() => {
    if (!on || !installing) return;
    const timer = setInterval(() => api.demoSettings().then(setView, console.error), 1500);
    return () => clearInterval(timer);
  }, [on, installing]);
  useEffect(() => () => audio.current?.pause(), []);
  if (!view || !draft) return null;
  const d = t.config.demo;
  const changed = JSON.stringify(draft) !== JSON.stringify(view.settings);
  const set = <K extends keyof DemoSettings>(k: K, v: DemoSettings[K]) => setDraft({ ...draft, [k]: v });
  const shown = check ?? view.check;
  const job = view.job?.voice === draft.voice ? view.job : undefined;
  const failed = (e: unknown) => setStatus(e instanceof ApiError ? errorText(e.code) + (e.code === 'voiceSample' ? ` ${e.message}` : '') : t.offlineError);
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
    <label key={k}>
      <span className="hint">{d.field[k](draft.voice)}</span>
      <input
        className="c-path"
        spellCheck={false}
        placeholder={d.placeholder[k](draft.voice)}
        value={draft[k] ?? ''}
        onChange={(e) => set(k, e.target.value || undefined)}
      />
    </label>
  );
  return (
    <>
      <h4 className="p-h">{d.title}</h4>
      <section className="c-canvas c-demo">
        <p className="hint">
          {d.hint} <code>{view.file}</code>
        </p>
        <label className="c-row">
          <span className="hint">{d.language}</span>
          <select value={draft.language} onChange={(e) => set('language', e.target.value as NarrationLanguage)}>
            {(Object.keys(d.languages) as NarrationLanguage[]).map((l) => (
              <option key={l} value={l}>
                {d.languages[l]}
              </option>
            ))}
          </select>
        </label>
        <label className="c-row">
          <span className="hint">{d.voice}</span>
          <select
            value={draft.voice}
            // another voice starts with its own fields, and is nobody's own until ticked
            onChange={(e) => setDraft({ language: draft.language, voice: e.target.value as VoiceKind, listenBack: draft.listenBack })}
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
        </label>
        <p className="hint c-about">{d.about[draft.voice]}</p>
        {VOICE_FIELDS[draft.voice].map(field)}
        {!STOCK_ONLY.includes(draft.voice) && (
          <label className="c-check">
            <input type="checkbox" checked={!!draft.ownVoice} onChange={(e) => set('ownVoice', e.target.checked || undefined)} />
            <span className="hint">{d.ownVoice}</span>
          </label>
        )}
        <p className="hint c-person">{d.person[shown.person]}</p>
        {job?.running ? (
          <p className="hint c-install">
            <span className="c-step">{d.installing}</span> <code>{job.line}</code>
          </p>
        ) : (
          !shown.install.installed && (
            <div className="c-install">
              <p className="hint">{d.notInstalled(shown.install.missing.join(', '), megabytes(shown.install.mb))}</p>
              <button className="btn small" disabled={installing} onClick={install}>
                {d.install(megabytes(shown.install.mb))}
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
        <div className="c-row">
          <button className="btn small" disabled={sampling || !shown.install.installed || !!shown.problems.length} onClick={listen}>
            {sampling ? d.sampling : d.listen}
          </button>
        </div>
        <label className="c-check">
          <input type="checkbox" checked={draft.listenBack !== false} onChange={(e) => set('listenBack', e.target.checked ? undefined : false)} />
          <span className="hint">{d.listenBack}</span>
        </label>
        <div className="c-actions">
          <button className="btn small primary" disabled={!changed || busy} onClick={save}>
            {d.save}
          </button>
          {changed && (
            <button className="btn small" disabled={busy} onClick={() => setDraft(view.settings)}>
              {t.config.reset}
            </button>
          )}
        </div>
        {status && <p className="hint c-status">{status}</p>}
      </section>
      <SetupBlock draft={draft} installing={installing} />
    </>
  );
}

/**
 * What a render needs on this machine besides the voice (that has its own lines above), each
 * missing piece with how to install it here. Checked again for the voice's listening back as it
 * is being chosen, after an installation, and on request.
 */
function SetupBlock({ draft, installing }: { draft: DemoSettings; installing: boolean }) {
  const [setup, setSetup] = useState<SetupCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const s = t.config.setup;
  const recheck = () => {
    setChecking(true);
    return api.demoSetup(draft).then(setSetup, console.error).finally(() => setChecking(false));
  };
  useEffect(() => {
    if (!installing) recheck();
  }, [draft.listenBack, installing]);
  if (!setup) return null;
  const items = setup.items.filter((i) => i.id !== 'voice');
  return (
    <>
      <h4 className="p-h">{s.title}</h4>
      <section className="c-canvas c-setup">
        <p className="hint">{s.hint(`${PLATFORMS[setup.platform] ?? setup.platform} (${setup.arch})`)}</p>
        <SetupList items={items} name={(i) => s.names[i.id]} state={demoState} />
        {!items.some((i) => i.state === 'missing') && <p className="hint">{s.ready}</p>}
        <p className="hint">
          {s.guide} <code>docs/demo-setup.md</code>
        </p>
        <button className="btn small" disabled={checking} onClick={recheck}>
          {checking ? s.checking : s.recheck}
        </button>
      </section>
    </>
  );
}

/**
 * What the owner's voice input needs on this machine, with one button that loads Whisper
 * (fetching it the first time). Follows an installation until it ends.
 */
function VoiceBlock({ on }: { on: boolean }) {
  const [view, setView] = useState<VoiceSetupView | null>(null);
  const [status, setStatus] = useState('');
  const [checking, setChecking] = useState(false);
  const recheck = () => {
    setChecking(true);
    return api.voiceSetup().then(setView, console.error).finally(() => setChecking(false));
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
      setStatus(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  };
  const blocked = view.items.some((i) => i.state === 'missing');
  return (
    <>
      <h4 className="p-h">{v.title}</h4>
      <section className="c-canvas c-setup c-voice">
        <p className="hint">{v.hint(`${PLATFORMS[view.platform] ?? view.platform} (${view.arch})`)}</p>
        <SetupList items={view.items} name={(i) => v.names[i.id]} state={voiceState} />
        {view.listen === 'faster' && <p className="hint">{v.faster}</p>}
        {view.job?.running ? (
          <p className="hint c-install">
            <span className="c-step">{v.step[view.job.step]}</span> <code>{view.job.line}</code>
          </p>
        ) : view.fetch.parts.length ? (
          <div className="c-install">
            <button className="btn small" disabled={blocked} onClick={install}>
              {v.install(megabytes(view.fetch.mb))}
            </button>
          </div>
        ) : (
          !view.items.some((i) => i.state === 'missing') && <p className="hint">{v.ready}</p>
        )}
        {view.job?.error && !view.job.running && <p className="p-error">{v.failed(view.job.error.split('\n').at(-1) ?? '')}</p>}
        {status && <p className="hint c-status">{status}</p>}
        <button className="btn small" disabled={checking || running} onClick={recheck}>
          {checking ? s.checking : s.recheck}
        </button>
      </section>
    </>
  );
}

interface CanvasProps {
  n: number;
  canvas: CanvasConfig;
  resolved: ConfigView['resolved'][number];
  running: string[];
  /** The id of the running canvas this one is: a new name keeps it. */
  pin?: string;
  /** The configuration shown is the one saved: a running canvas is the one shown. */
  saved: boolean;
  adapters: string[];
  problems: ConfigProblem[];
  /** Has the Koordinator create a task that fixes a problem; only for the configuration as saved, which is what it reads. */
  ask?: Ask;
  onChange: (c: CanvasConfig | null) => void;
}

function CanvasBlock({ n, canvas, resolved, running, pin, saved, adapters, problems, ask, onChange }: CanvasProps) {
  const fresh = resolved && !running.includes(resolved.id);
  // the Koordinator of the canvas with the problem, where it runs: a card for it goes there
  const askHere = ask && ((text: string) => ask(text, resolved && running.includes(resolved.id) ? resolved.id : undefined));
  const here = t.config.canvas(n + 1);
  const setRepo = (i: number, r: RepoConfig | null) =>
    onChange({ ...canvas, repos: r ? canvas.repos.map((x, j) => (j === i ? r : x)) : canvas.repos.filter((_, j) => j !== i) });
  return (
    <section className="c-canvas">
      <div className="c-head">
        <b>{t.config.canvas(n + 1)}</b>
        {resolved && (
          <span className={fresh ? 'c-id fresh' : 'c-id'} title={fresh ? t.config.freshHint : undefined}>
            ?c={resolved.id} · {fresh ? t.config.fresh : t.config.runs}
          </span>
        )}
        <button className="c-del" title={t.config.removeCanvas} onClick={() => onChange(null)}>
          ✕
        </button>
      </div>
      <label>
        <span className="hint">{t.config.name}</span>
        <input
          value={canvas.name ?? ''}
          placeholder={resolved && !canvas.name ? t.config.nameAuto(resolved.name) : ''}
          onChange={(e) => {
            const { name: _, ...rest } = canvas;
            const kept = pin && !rest.id ? { ...rest, id: pin } : rest;
            onChange(e.target.value ? { ...kept, name: e.target.value } : kept);
          }}
        />
      </label>
      {fresh && <p className="hint warn">{t.config.freshHint}</p>}
      {canvas.repos.map((r, i) => (
        <RepoRow
          key={i}
          repo={r}
          home={i === 0}
          resolved={resolved?.repos[i]}
          canvasId={saved && resolved && running.includes(resolved.id) ? resolved.id : undefined}
          adapters={adapters}
          problems={problems.filter((p) => p.repo === i)}
          where={`${here}, ${t.config.repoAt(r.path)}`}
          ask={askHere}
          onChange={(x) => setRepo(i, x)}
        />
      ))}
      {problems
        .filter((p) => p.repo === undefined)
        .map((p, k) => (
          <Problem key={k} problem={p} where={here} ask={askHere} />
        ))}
      <button className="btn small" onClick={() => onChange({ ...canvas, repos: [...canvas.repos, { path: '' }] })}>
        {t.config.addRepo}
      </button>
    </section>
  );
}

interface RepoProps {
  repo: RepoConfig;
  home: boolean;
  resolved?: { id: string; adapter: string; workspaces: 'clones' | 'worktrees'; adapterShares?: boolean };
  /** The running canvas the repository is on, as saved; where a card for it can go. */
  canvasId?: string;
  adapters: string[];
  problems: ConfigProblem[];
  /** Where it is, for a request to the Koordinator. */
  where: string;
  ask?: (text: string) => void;
  onChange: (r: RepoConfig | null) => void;
}

function RepoRow({ repo, home, resolved, canvasId, adapters, problems, where, ask, onChange }: RepoProps) {
  const clones = resolved?.workspaces === 'clones' || !!repo.clones || !!repo.workspaces?.length;
  const without = <K extends keyof RepoConfig>(k: K, v: RepoConfig[K] | undefined): RepoConfig => {
    const next = { ...repo };
    if (v === undefined) delete next[k];
    else next[k] = v;
    return next;
  };
  return (
    <div className="c-repo">
      <div className="c-row">
        <input className="c-path" value={repo.path} placeholder={t.config.path} spellCheck={false} onChange={(e) => onChange({ ...repo, path: e.target.value })} />
        <button className="c-del" title={t.config.removeRepo} onClick={() => onChange(null)}>
          ✕
        </button>
      </div>
      <div className="c-row">
        <select value={repo.adapter ?? ''} onChange={(e) => onChange(without('adapter', e.target.value || undefined))} title={t.config.adapter}>
          <option value="">{t.config.adapterAuto(repo.adapter ? undefined : resolved?.adapter)}</option>
          {/* a module's path from the file: kept as it is, the sheet offers only the built-in ones */}
          {(repo.adapter && !adapters.includes(repo.adapter) ? [...adapters, repo.adapter] : adapters).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <span className="hint">
          {resolved && `${resolved.id}${home ? ` · ${t.config.home}` : ''} · ${resolved.workspaces === 'clones' ? t.config.clonesMode : t.config.worktrees}`}
        </span>
      </div>
      {clones && (
        <>
          <label className="c-row">
            <span className="hint">{t.config.clones}</span>
            <input type="number" min={0} max={20} placeholder="0" value={repo.clones ?? ''} onChange={(e) => onChange(without('clones', Number(e.target.value) || undefined))} />
          </label>
          <label>
            <span className="hint">{t.config.workspaces}</span>
            <textarea
              rows={2}
              spellCheck={false}
              value={(repo.workspaces ?? []).join('\n')}
              onChange={(e) => {
                const list = e.target.value.split('\n');
                onChange(without('workspaces', list.some((w) => w.trim()) ? list : undefined));
              }}
            />
          </label>
        </>
      )}
      <label title={t.config.shareHint}>
        <span className="hint">{t.config.share}</span>
        <input
          className="c-path"
          value={repo.share ?? ''}
          placeholder={resolved?.adapterShares ? t.config.shareAdapter(resolved.adapter) : t.config.shareNone}
          spellCheck={false}
          onChange={(e) => onChange(without('share', e.target.value || undefined))}
        />
      </label>
      {problems.map((p, k) => (
        <Problem key={k} problem={p} where={where} ask={ask} />
      ))}
      {/* a repository without an adapter of its own (not one whose own does not load): a card on its canvas writes one */}
      {canvasId && resolved?.adapter === 'generic' && !repo.adapter && !problems.some((p) => p.code === 'adapterLoad') && <AdapterSetup canvas={canvasId} repo={resolved.id} />}
    </div>
  );
}

// problems whose detail says what to fix, in the repository's adapter rather than here
const DETAILED: ConfigProblem['code'][] = ['adapterField', 'adapterLoad', 'unknownAdapter'];

/**
 * A problem of the configuration: what is wrong, the technical detail folded away where it says
 * what to fix, and a button that has the Koordinator create a task that fixes it (with the detail, which it reads).
 */
function Problem({ problem, where, ask }: { problem: ConfigProblem; where: string; ask?: (text: string) => void }) {
  const [asked, setAsked] = useState(false);
  const text = t.config.problem[problem.code];
  return (
    <div className="p-error c-problem">
      {text}
      {DETAILED.includes(problem.code) && (
        <details>
          <summary>{t.config.details}</summary>
          <code>{problem.detail}</code>
        </details>
      )}
      {ask && (
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

/** Creates the card that writes the repository's adapter, and opens it on its canvas. */
function AdapterSetup({ canvas, repo }: { canvas: string; repo: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    try {
      const card = await api.adapterSetup(canvas, repo);
      // the canvas loads with the card open, as after a restart
      keep(sessionStorage, canvas, { at: Date.now(), card: card.id, scroll: [], drafts: [] });
      location.assign(`?c=${encodeURIComponent(canvas)}`);
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e.code) : t.offlineError);
      setBusy(false);
    }
  };
  return (
    <div className="c-row">
      <span className="hint">{t.config.adapterSetupHint}</span>
      <button className="btn small" disabled={busy} onClick={go}>
        {t.config.adapterSetup}
      </button>
      {error && <p className="p-error">{error}</p>}
    </div>
  );
}
