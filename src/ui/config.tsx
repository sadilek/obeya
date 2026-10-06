// Obeya's configuration: the canvases it serves and their repositories, edited here and saved;
// Obeya then starts again with it. The server's own settings come from its command line and show
// read-only.

import { useEffect, useRef, useState } from 'react';
import type { CanvasConfig, ConfigProblem, ConfigView, DemoSettings, DemoSettingsView, DemoVoiceCheck, Language, LanguageView, NarrationLanguage, RepoConfig, SetupCheck, SetupItem, VoiceKind, VoiceSetupItem, VoiceSetupView } from '../core/types';
import { LANGUAGES } from '../core/locale';
import { api, ApiError, reload } from './api';
import { errorText, t } from './strings';

type Checked = Pick<ConfigView, 'resolved' | 'problems'>;

export function ConfigSheet({ on }: { on: boolean }) {
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

      {draft.map((c, i) => (
        <CanvasBlock
          key={i}
          n={i}
          canvas={c}
          resolved={checked?.resolved[i] ?? null}
          running={view.running}
          pin={origin[i] && view.running.includes(origin[i]) ? origin[i] : undefined}
          adapters={view.adapters}
          problems={problems.filter((p) => p.canvas === i)}
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
          <p key={k} className="p-error">
            {t.config.problem[p.code]}
          </p>
        ))}
      {changed && gone.length > 0 && <p className="hint warn">{t.config.gone(gone.join(', '))}</p>}

      <div className="c-actions">
        <button className="btn primary" disabled={!changed || busy || problems.length > 0} onClick={save}>
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
      <VoiceBlock on={on} />
      <DemoBlock on={on} />

      <h4 className="p-h">{t.config.server}</h4>
      <dl className="c-server">
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
        <dd>{view.server.restarts ? t.config.yes : t.config.no}</dd>
      </dl>

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
const megabytes = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1).replace('.', ',')} GB` : `${mb} MB`);

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

const PLATFORMS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

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
  const state = (i: SetupItem) => {
    if (i.state === 'later') return s.later(megabytes(i.mb ?? 0));
    if (i.state === 'off') return s.off;
    if (i.state === 'missing') return i.found && i.need ? s.needs(i.found, i.need) : s.missing;
    // a browser by its program's name; the whole path is in the tooltip
    return (i.id === 'browser' ? i.found?.split(/[\\/]/).at(-1) : i.found) ?? s.there;
  };
  return (
    <>
      <h4 className="p-h">{s.title}</h4>
      <section className="c-canvas c-setup">
        <p className="hint">{s.hint(`${PLATFORMS[setup.platform] ?? setup.platform} (${setup.arch})`)}</p>
        <SetupList items={items} names={s.names} state={state} />
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

/** A setup check's pieces, each missing one with the commands that install it here. */
function SetupList<I extends SetupItem | VoiceSetupItem>({ items, names, state }: { items: I[]; names: Record<I['id'], string>; state: (i: I) => string }) {
  const s = t.config.setup;
  return (
    <ul>
      {items.map((i) => (
        <li key={i.id} className={i.state}>
          <span className="c-mark" aria-hidden>
            {{ ok: '✓', missing: '✗', later: '…', off: '–' }[i.state]}
          </span>
          <span className="c-name">{names[i.id as I['id']]}</span>
          <span className="hint" title={i.found}>
            {state(i)}
          </span>
          {i.state === 'missing' && i.install && (
            <div className="c-how">
              {!!i.install.commands.length && <span className="hint">{s.install}</span>}
              {i.install.commands.map((c) => (
                <code key={c}>{c}</code>
              ))}
              {i.install.url && (
                <a href={i.install.url} target="_blank" rel="noreferrer">
                  {s.more}
                </a>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * What the owner's voice commands and the spoken confirmations need on this machine, with one
 * button that installs Piper and loads Whisper (fetching it the first time). Follows an
 * installation until it ends.
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
  const state = (i: VoiceSetupItem) => {
    if (i.id === 'speech' && i.state === 'missing') return v.speechMissing(megabytes(i.mb ?? 0));
    if (i.state === 'later') return v.later(megabytes(i.mb ?? 0));
    if (i.state === 'missing') return i.found && i.need ? s.needs(i.found, i.need) : s.missing;
    return (i.found && v.found[i.found]) ?? i.found ?? s.there;
  };
  const install = async () => {
    setStatus('');
    try {
      setView(await api.installVoice());
    } catch (e) {
      setStatus(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  };
  const blocked = view.items.some((i) => i.state === 'missing' && i.id !== 'speech');
  return (
    <>
      <h4 className="p-h">{v.title}</h4>
      <section className="c-canvas c-setup c-voice">
        <p className="hint">{v.hint(`${PLATFORMS[view.platform] ?? view.platform} (${view.arch})`)}</p>
        <SetupList items={view.items} names={v.names} state={state} />
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
  adapters: string[];
  problems: ConfigProblem[];
  onChange: (c: CanvasConfig | null) => void;
}

function CanvasBlock({ n, canvas, resolved, running, pin, adapters, problems, onChange }: CanvasProps) {
  const fresh = resolved && !running.includes(resolved.id);
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
          adapters={adapters}
          problems={problems.filter((p) => p.repo === i)}
          onChange={(x) => setRepo(i, x)}
        />
      ))}
      {problems
        .filter((p) => p.repo === undefined)
        .map((p, k) => (
          <p key={k} className="p-error">
            {t.config.problem[p.code]}
          </p>
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
  adapters: string[];
  problems: ConfigProblem[];
  onChange: (r: RepoConfig | null) => void;
}

function RepoRow({ repo, home, resolved, adapters, problems, onChange }: RepoProps) {
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
        <p key={k} className="p-error">
          {t.config.problem[p.code]}
        </p>
      ))}
    </div>
  );
}
