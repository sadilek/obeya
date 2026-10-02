// Obeya's configuration: the canvases it serves and their repositories, edited here and saved;
// Obeya then starts again with it. The server's own settings come from its command line and show
// read-only.

import { useEffect, useRef, useState } from 'react';
import type { CanvasConfig, ConfigProblem, ConfigView, DemoSettings, DemoSettingsView, NarrationLanguage, RepoConfig, VoiceKind } from '../core/types';
import { api, ApiError } from './api';
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

/** How demos are narrated: saved on their own, read by the next render, so nothing restarts. */
function DemoBlock({ on }: { on: boolean }) {
  const [view, setView] = useState<DemoSettingsView | null>(null);
  const [draft, setDraft] = useState<DemoSettings | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!on) return;
    api.demoSettings().then((v) => {
      setView(v);
      setDraft(v.settings);
      setStatus('');
    }, console.error);
  }, [on]);
  if (!view || !draft) return null;
  const d = t.config.demo;
  const changed = JSON.stringify(draft) !== JSON.stringify(view.settings);
  const set = <K extends keyof DemoSettings>(k: K, v: DemoSettings[K]) => setDraft({ ...draft, [k]: v });
  const save = async () => {
    setBusy(true);
    try {
      const v = await api.saveDemoSettings(draft);
      setView(v);
      setDraft(v.settings);
      setStatus(d.saved);
    } catch (e) {
      setStatus(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
    setBusy(false);
  };
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
          <select value={draft.voice} onChange={(e) => set('voice', e.target.value as VoiceKind)}>
            {(Object.keys(d.voices) as VoiceKind[]).map((v) => (
              <option key={v} value={v}>
                {d.voices[v]}
              </option>
            ))}
          </select>
        </label>
        <p className="hint c-person">{d.person[draft.voice === 'clone' ? 'first' : 'third']}</p>
        <label>
          <span className="hint">{d.voiceProject}</span>
          <input className="c-path" spellCheck={false} value={draft.voiceProject ?? ''} onChange={(e) => set('voiceProject', e.target.value || undefined)} />
        </label>
        {draft.voice === 'gemini' && (
          <label>
            <span className="hint">{d.geminiKeyFile}</span>
            <input className="c-path" spellCheck={false} value={draft.geminiKeyFile ?? ''} onChange={(e) => set('geminiKeyFile', e.target.value || undefined)} />
          </label>
        )}
        {!changed &&
          view.problems.map((p) => (
            <p key={p} className="p-error">
              {d.problem[p]}
            </p>
          ))}
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
          {adapters.map((a) => (
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
