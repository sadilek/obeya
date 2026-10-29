// The setup assistant: what Obeya needs on this machine in one list (Claude Code and its login, git,
// gh and its login, voice, demos), the needed parts apart from those that can wait, installed at a
// click where Obeya can, with the command for the rest and a terminal for the logins. On the first
// start (no canvas yet) it fills the page and ends with the first canvas, from a folder or a clone;
// later the settings open it over the canvas.

import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { CLOUD_PRESETS, CLOUD_VOICES, type CloudPreset, type GitSetupPreview, LARGE_FILE, type Language, type MachineItem, type MachineSection, type MachineView, type SetupItem, type VoiceSetupItem } from '../core/types';
import { LANGUAGES } from '../core/locale';
import { api, reload } from './api';
import { useCopy } from './copy';
import { Sign } from './logo';
import { failText, fileSize, t } from './strings';

const PLATFORMS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
/** The machine's system and processor, as the owner knows them: "macOS (arm64)". */
export const platformName = (v: { platform: string; arch: string }) => `${PLATFORMS[v.platform] ?? v.platform} (${v.arch})`;

/** A command to run in a terminal, with a button that copies it. */
function Command({ text }: { text: string }) {
  const [copied, copy] = useCopy(1500);
  return (
    <span className="c-cmd">
      <code>{text}</code>
      <button className="c-copy" onClick={() => copy(text)} title={t.setup.copy}>
        {copied ? t.setup.copied : t.setup.copy}
      </button>
    </span>
  );
}

/** A setup check's pieces, each missing one with the commands that install it here, and what Obeya does about it at a click. */
export function SetupList<I extends SetupItem | VoiceSetupItem | MachineItem>({
  items,
  name,
  state,
  action,
}: {
  items: I[];
  name: (i: I) => string;
  state: (i: I) => string;
  action?: (i: I) => ReactNode;
}) {
  const s = t.config.setup;
  return (
    <ul>
      {items.map((i) => {
        const act = action?.(i);
        // the speech recognition, there but too slow on this machine
        const slow = 'speed' in i && typeof i.speed === 'object' && i.speed.slow && !i.cloud?.used;
        return (
          <li key={i.id} className={slow ? `${i.state} slow` : i.state}>
            <span className="c-mark" aria-hidden>
              {slow ? '!' : { ok: '✓', missing: '✗', later: '…' }[i.state]}
            </span>
            <span className="c-name">{name(i)}</span>
            <span className="hint" title={i.found}>
              {state(i)}
            </span>
            {act && <div className="c-act">{act}</div>}
            {i.state === 'missing' && i.install && (!!i.install.commands.length || i.install.url) && (
              <div className="c-how">
                {!!i.install.commands.length && <span className="hint">{act ? t.setup.byHand : s.install}</span>}
                {i.install.commands.map((c) => (
                  <Command key={c} text={c} />
                ))}
                {i.install.url && (
                  <a href={i.install.url} target="_blank" rel="noreferrer">
                    {s.more}
                  </a>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What the voice check's lines say, here and in the settings sheet. */
export function voiceState(i: VoiceSetupItem | MachineItem) {
  const v = t.config.voice;
  const s = t.config.setup;
  if (i.state === 'later') return (i.waits ? v.waits : v.later)(fileSize((i.mb ?? 0) * 1e6));
  if (i.state === 'missing') return i.found && i.need ? s.needs(i.found, i.need) : s.missing;
  if (i.id === 'recognition') {
    if (i.cloud?.used) return v.cloud.found(i.found ?? '');
    if (i.speed === 'measuring') return `${i.found} · ${v.measuring}`;
    if (i.speed) return i.speed.slow ? v.slow : v.fast(i.found ?? '', v.seconds(i.speed.seconds));
  }
  return (i.found && v.found[i.found]) ?? i.found ?? s.there;
}

/**
 * Under the speech recognition's line, in the setup assistant and the configuration dialog alike:
 * how long it took here for a short sentence, measured again at a click, and a cloud service
 * instead (open at once when it was too slow), tested with the same sentence before it is used.
 * `changed`: the view to check again, which this follows while a measurement runs.
 */
export function RecognitionDetail({ item, busy, changed }: { item: VoiceSetupItem | MachineItem; busy?: boolean; changed: () => unknown }) {
  const v = t.config.voice;
  const c = v.cloud;
  const { speed, cloud } = item;
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<CloudPreset>(cloud?.preset ?? 'groq');
  const [baseUrl, setBaseUrl] = useState(cloud?.preset === 'openai' ? cloud.baseUrl : '');
  const [model, setModel] = useState(cloud?.preset === 'openai' ? cloud.model : '');
  const [key, setKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState('');
  const measuring = speed === 'measuring';
  useEffect(() => {
    if (!measuring) return;
    // one check at a time: the setup assistant's takes a while
    let timer: ReturnType<typeof setTimeout>;
    let done = false;
    const tick = async () => {
      await changed();
      if (!done) timer = setTimeout(tick, 1500);
    };
    timer = setTimeout(tick, 1500);
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [measuring]);
  const failed = (e: unknown) => setStatus(failText(e, { detail: ['voiceCloud', 'invalid'] }));
  const act = async (call: () => Promise<unknown>) => {
    setStatus('');
    try {
      await call();
      changed();
    } catch (e) {
      failed(e);
    }
  };
  const test = async () => {
    setTesting(true);
    await act(() => api.useCloudVoice({ preset, ...(preset === 'openai' ? { baseUrl, model } : {}), ...(key.trim() ? { key: key.trim() } : {}) }));
    setKey('');
    setTesting(false);
  };
  if (cloud?.used)
    return (
      <div className="c-voice">
        <span className="hint">{c.used(item.found ?? '', v.seconds(cloud.tested?.seconds ?? 0))}</span>
        <button className="link" onClick={() => act(api.useLocalVoice)}>
          {c.back}
        </button>
        {status && <span className="p-error">{status}</span>}
      </div>
    );
  const slow = typeof speed === 'object' && speed.slow ? speed : null;
  const kept = cloud?.key && cloud.preset === preset;
  return (
    <div className="c-voice">
      {slow && <span className="hint warn">{v.slowDetail(v.seconds(slow.seconds))}</span>}
      {item.state === 'ok' && !measuring && (
        <button className="link" disabled={busy} onClick={() => act(api.measureVoice)}>
          {speed ? v.remeasure : v.measure}
        </button>
      )}
      {slow || open || cloud ? (
        <div className="c-cloud">
          <b>{c.offer}</b>
          <span className="c-row">
            <select aria-label={c.service} value={preset} onChange={(e) => setPreset(e.target.value as CloudPreset)}>
              {CLOUD_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {c.names[p]}
                </option>
              ))}
            </select>
          </span>
          <span className="hint">{c.about[preset]}</span>
          {preset === 'openai' && (
            <span className="c-row">
              <input aria-label={c.baseUrl} spellCheck={false} placeholder={CLOUD_VOICES.openai.baseUrl} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              <input aria-label={c.model} spellCheck={false} placeholder={CLOUD_VOICES.openai.model} value={model} onChange={(e) => setModel(e.target.value)} />
            </span>
          )}
          <input type="password" autoComplete="off" spellCheck={false} placeholder={kept ? c.keyKept : c.key} value={key} onChange={(e) => setKey(e.target.value)} />
          <span className="c-row c-cloud-go">
            <a href={CLOUD_VOICES[preset].keys} target="_blank" rel="noreferrer">
              {c.getKey}
            </a>
            <button className="btn small" disabled={testing || (!key.trim() && !kept)} onClick={test}>
              {testing ? c.testing : c.test}
            </button>
          </span>
        </div>
      ) : (
        <button className="link" onClick={() => setOpen(true)}>
          {c.open}
        </button>
      )}
      {status && <span className="p-error">{status}</span>}
    </div>
  );
}

/** What the demo check's lines say, here and in the settings sheet. */
export function demoState(i: SetupItem | MachineItem) {
  const s = t.config.setup;
  if (i.state === 'missing') return i.found && i.need ? s.needs(i.found, i.need) : s.missing;
  // a browser by its program's name; the whole path is in the tooltip
  return (i.id === 'browser' ? i.found?.split(/[\\/]/).at(-1) : i.found) ?? s.there;
}

const ready = (section: MachineSection | undefined) => !!section && section.items.every((i) => i.state !== 'missing');

export function Setup({ first, onClose }: { first?: boolean; onClose?: () => void }) {
  const [view, setView] = useState<MachineView | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState('');
  const [terminal, setTerminal] = useState<string | null>(null);
  const shown = useRef(false);
  shown.current = !!view;
  const failed = (e: unknown) => setStatus(failText(e, { detail: ['invalid', 'config'] }));
  const recheck = () => {
    setChecking(true);
    return api
      .setup()
      // a check that fails (the server starting again) keeps the list it had
      .then(setView, (e) => (shown.current ? console.error(e) : failed(e)))
      .finally(() => setChecking(false));
  };
  useEffect(() => {
    recheck();
    // back from a terminal or an installer: the list checks again
    const back = () => document.visibilityState === 'visible' && recheck();
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);
  const running = !!view?.job?.running;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => api.setup().then(setView, console.error), 1500);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!onClose) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const s = t.setup;
  const act = async (section: MachineSection, i: MachineItem) => {
    setStatus('');
    setTerminal(null);
    try {
      if (i.act === 'install') setView(await api.setupInstall(section.id, i.id));
      else if (i.act === 'login') {
        const { opened } = await api.setupLogin(section.id, i.id);
        setTerminal(opened ? i.id : null);
        if (!opened) setStatus(s.noTerminal);
      }
    } catch (e) {
      failed(e);
    }
  };
  const action = (section: MachineSection) => (i: MachineItem) => {
    const job = view?.job;
    if (job?.kind === 'install' && job.section === section.id && job.id === i.id) {
      if (job.running)
        return (
          <span className="hint c-install">
            <span className="c-step">{s.installing}</span> <code>{job.line}</code>
          </span>
        );
      if (job.error) return <span className="p-error">{s.failed(job.error.split('\n').at(-1) ?? '')}</span>;
    }
    if (i.act === 'identity') return <Identity onSaved={setView} onError={failed} />;
    const detail = section.id === 'voice' && i.id === 'recognition' && <RecognitionDetail item={i} busy={running} changed={recheck} />;
    if (!i.act) return detail || null;
    if (i.act === 'login')
      return (
        <>
          <button className="btn small" onClick={() => act(section, i)}>
            {s.login}
          </button>
          {terminal === i.id && <span className="hint">{s.terminalOpen}</span>}
        </>
      );
    return (
      <>
        <button className="btn small" disabled={running} onClick={() => act(section, i)}>
          {i.mb ? s.installSized(fileSize(i.mb * 1e6)) : s.install}
        </button>
        {detail}
      </>
    );
  };
  const name = (section: MachineSection) => (i: MachineItem) =>
    section.id === 'voice' ? t.config.voice.names[i.id as VoiceSetupItem['id']] : section.id === 'demos' ? t.config.setup.names[i.id as SetupItem['id']] : s.names[i.id as keyof typeof s.names];
  const state = (section: MachineSection) => (i: MachineItem) => {
    if (section.id === 'voice') return voiceState(i);
    if (section.id === 'demos') return demoState(i);
    if (i.state === 'ok') return i.id === 'claudeLogin' || i.id === 'ghLogin' ? (i.found ? s.loggedInAs(i.found) : s.loggedIn) : (i.found ?? t.config.setup.there);
    if (i.id === 'claudeLogin' && !i.act) return s.claudeFirst;
    if (i.id === 'ghLogin' && !i.act) return s.ghFirst;
    if (i.id === 'claudeLogin' || i.id === 'ghLogin') return s.loggedOut;
    if (i.id === 'gitUser') return s.noIdentity;
    return t.config.setup.missing;
  };

  const needed = view?.sections.find((x) => x.id === 'needed');
  const claude = needed?.items.find((i) => i.id === 'claude');
  return (
    <div className={first ? 'setup first' : 'setup over'} onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="setup-page">
        <header className="setup-head">
          {first && <Sign size={34} />}
          <div>
            <div className="p-kind">{s.kind}</div>
            <h2>{first ? s.titleFirst : s.title}</h2>
          </div>
          {first && <LanguagePick />}
          {onClose && (
            <button className="c-del setup-close" title={s.close} onClick={onClose}>
              ✕
            </button>
          )}
        </header>
        <div className="setup-body">
          <p className="hint setup-intro">{first ? s.introFirst : s.intro}</p>
          {!view ? (
            <p className="hint">{checking ? t.config.setup.checking : status}</p>
          ) : (
            <>
              <p className="hint">{s.platform(platformName(view))}</p>
              {view.sections.map((section) => (
                <section key={section.id} className={`c-canvas c-setup setup-${section.id}`}>
                  <div className="setup-sh">
                    <b>{s.sections[section.id].title}</b>
                    <span className={section.id === 'needed' ? 'setup-tag needed' : 'setup-tag'}>{section.id === 'needed' ? s.needed : s.optional}</span>
                    {section.mb > 0 && <span className="hint">{s.size(fileSize(section.mb * 1e6))}</span>}
                    <span className={ready(section) ? 'setup-ok on' : 'setup-ok'}>
                      {!ready(section) ? s.open(section.items.filter((i) => i.state === 'missing').length) : section.items.some((i) => i.state === 'later') ? s.readyLater : s.ready}
                    </span>
                  </div>
                  <p className="hint">{s.sections[section.id].hint}</p>
                  <SetupList items={section.items} name={name(section)} state={state(section)} action={action(section)} />
                  {section.id === 'needed' && claude?.state === 'ok' && claude.found && !claude.found.startsWith(view.checkedClaude) && (
                    <p className="hint">{s.checkedWith(view.checkedClaude)}</p>
                  )}
                </section>
              ))}
              {status && <p className="hint c-status">{status}</p>}
              <button className="btn small" disabled={checking || running} onClick={recheck}>
                {checking ? t.config.setup.checking : t.config.setup.recheck}
              </button>
              {first && <FirstCanvas view={view} ready={ready(needed)} onView={setView} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** git's name and e-mail for the agents' commits, set globally. */
function Identity({ onSaved, onError }: { onSaved: (v: MachineView) => void; onError: (e: unknown) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const s = t.setup;
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api.setupIdentity(name, email));
    } catch (e) {
      onError(e);
    }
    setBusy(false);
  };
  return (
    <span className="c-row setup-identity">
      <input placeholder={s.yourName} value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder={s.yourEmail} value={email} onChange={(e) => setEmail(e.target.value)} />
      <button className="btn small" disabled={busy || !name.trim() || !email.trim()} onClick={save}>
        {s.saveIdentity}
      </button>
    </span>
  );
}

/** The language of the page before there is a canvas whose settings could change it. */
function LanguagePick() {
  const [chosen, setChosen] = useState<Language | null>(null);
  useEffect(() => {
    api.language().then((l) => setChosen(l.language), console.error);
  }, []);
  if (!chosen) return null;
  return (
    <select
      className="setup-lang"
      aria-label={t.config.language.title}
      value={chosen}
      onChange={(e) => api.saveLanguage(e.target.value as Language).then(() => reload(), console.error)}
    >
      {LANGUAGES.map((l) => (
        <option key={l} value={l}>
          {t.config.language.names[l]}
        </option>
      ))}
    </select>
  );
}

/** The first canvas: a repository's folder on this machine, or a clone of one. Obeya then starts again with it, and the page opens it. */
function FirstCanvas({ view, ready, onView }: { view: MachineView; ready: boolean; onView: (v: MachineView) => void }) {
  const [mode, setMode] = useState<'folder' | 'clone'>('folder');
  const [path, setPath] = useState('');
  const [clone, setClone] = useState('');
  const [into, setInto] = useState(view.cloneInto);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [saved, setSaved] = useState<{ canvas: string; branch?: string; opens: boolean } | null>(null);
  // the main branch of the folder named, once Obeya looked at it; or that it is a folder without git
  const found = useFolder(mode === 'folder' ? path.trim() : '');
  const s = t.setup;
  const failed = (e: unknown) => setStatus(failText(e, { detail: ['invalid', 'config'] }));
  const job = view.job?.kind === 'clone' ? view.job : undefined;
  // a clone that ended as the first canvas
  useEffect(() => {
    if (job && !job.running && job.canvas) setSaved({ canvas: job.canvas, branch: job.branch, opens: !!job.opens });
  }, [job?.running, job?.canvas]);
  const branch = saved?.branch ?? found?.branch;
  const noGit = !!found?.noGit;
  // once Obeya runs with the canvas (by itself, or started again by the owner), the page opens it
  const opened = useRef(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setInterval(
      () =>
        api.canvases().then((list) => {
          if (opened.current || !list.some((c) => c.id === saved.canvas)) return;
          opened.current = true;
          location.href = `/?c=${encodeURIComponent(saved.canvas)}`;
        }, () => {}),
      1000,
    );
    return () => clearInterval(timer);
  }, [saved]);

  const pick = async () => {
    setStatus('');
    try {
      const { path } = await api.setupPick(s.pickPrompt);
      if (path) setPath(path);
    } catch (e) {
      failed(e);
    }
  };
  /** `withoutGit`: the folder stays without git, its cards working in it directly. */
  const create = async (withoutGit = false) => {
    setBusy(true);
    setStatus('');
    try {
      const out = await api.setupCanvas(mode === 'folder' ? { path, ...(withoutGit ? { git: false as const } : {}) } : { clone, into });
      if ('canvas' in out) setSaved(out);
      else onView(out);
    } catch (e) {
      failed(e);
    }
    setBusy(false);
  };
  const can = mode === 'folder' ? !!path.trim() : !!clone.trim();
  return (
    <section className="c-canvas setup-first">
      <div className="setup-sh">
        <b>{s.first.title}</b>
      </div>
      <p className="hint">{s.first.hint}</p>
      {!ready && <p className="hint warn">{s.first.notReady}</p>}
      {saved ? (
        <p className="hint setup-saved">
          {branch && `${s.first.branch(branch)} `}{saved.opens ? s.first.opens : s.first.startAgain}</p>
      ) : (
        <>
          <div className="setup-where" role="radiogroup" aria-labelledby="setup-where">
            <b id="setup-where">{s.first.where}</b>
            {(['folder', 'clone'] as const).map((m) => (
              <label key={m} className={mode === m ? 'setup-choice on' : 'setup-choice'}>
                <input type="radio" name="setup-where" checked={mode === m} onChange={() => setMode(m)} />
                <b>{s.first.modes[m].title}</b>
                <span className="hint">{s.first.modes[m].hint}</span>
              </label>
            ))}
          </div>
          {mode === 'folder' ? (
            <>
              <label>
                <span className="hint">{s.first.folder}</span>
                <span className="c-row">
                  <input className="c-path" spellCheck={false} placeholder={s.first.pathPlaceholder} value={path} onChange={(e) => setPath(e.target.value)} />
                  {view.picker && (
                    <button className="btn small setup-pick" onClick={pick}>
                      {s.first.pick}
                    </button>
                  )}
                </span>
              </label>
              {branch && <p className="hint setup-branch">{s.first.branch(branch)}</p>}
              {noGit && <GitSetup key={path.trim()} path={path.trim()} confirm={s.git.confirmCanvas} onDone={() => create()} onFolder={() => create(true)} />}
            </>
          ) : (
            <>
              <label>
                <span className="hint">{s.first.repo}</span>
                <input className="c-path" spellCheck={false} placeholder={s.first.repoPlaceholder} value={clone} onChange={(e) => setClone(e.target.value)} />
              </label>
              <label>
                <span className="hint">{s.first.into}</span>
                <input className="c-path" spellCheck={false} value={into} onChange={(e) => setInto(e.target.value)} />
              </label>
            </>
          )}
          {noGit ? null : job?.running ? (
            <p className="hint c-install">
              <span className="c-step">{s.first.cloning}</span> <code>{job.line}</code>
            </p>
          ) : (
            <div className="c-actions">
              <button className="btn primary" disabled={!can || busy} onClick={() => create()}>
                {mode === 'folder' ? s.first.create : s.first.cloneCreate}
              </button>
            </div>
          )}
          {job?.error && !job.running && <p className="p-error">{s.first.cloneFailed(job.error)}</p>}
        </>
      )}
      {status && <p className="p-error">{status}</p>}
    </section>
  );
}

/** What Obeya found at the folder `path` once it stopped changing for a moment: its main branch, or that it has no git; null until then. */
function useFolder(path: string): { branch?: string; noGit?: boolean } | null {
  const [found, setFound] = useState<{ path: string; branch?: string; noGit?: boolean } | null>(null);
  useEffect(() => {
    if (!path) return;
    const timer = setTimeout(() => api.setupFolder(path).then((f) => setFound({ path, branch: f.branch, noGit: f.folder }), () => setFound(null)), 300);
    return () => clearTimeout(timer);
  }, [path]);
  return found?.path === path ? found : null;
}

/** The path, once Obeya found a folder without git there (where git can be set up); else empty. */
export const useFolderWithoutGit = (path: string) => (useFolder(path)?.noGit ? path : '');

// what stays out, listed up to this many
const IGNORED_SHOWN = 12;

/**
 * A folder that has no git: the two ways on, each with what it means. Using it without git
 * (`onFolder`), or setting up git there: what the first commit holds (the folder's entries with
 * their sizes, large files marked, what stays out, the `.gitignore` Obeya writes), and only once the
 * owner confirms, the repository with its first commit. The first canvas and "+ Repository" in the
 * configuration both show it.
 */
export function GitSetup({ path, confirm, onDone, onFolder }: { path: string; confirm: string; onDone: (branch: string) => void; onFolder: () => void }) {
  const [preview, setPreview] = useState<GitSetupPreview | null>(null);
  const [busy, setBusy] = useState<'looking' | 'working' | null>(null);
  const [error, setError] = useState('');
  const s = t.setup.git;
  const failed = (e: unknown) => setError(failText(e, { detail: ['gitSetup', 'invalid'] }));
  const look = async () => {
    setBusy('looking');
    setError('');
    try {
      setPreview(await api.setupGitPreview(path));
    } catch (e) {
      failed(e);
    }
    setBusy(null);
  };
  const go = async () => {
    setBusy('working');
    setError('');
    try {
      const { branch } = await api.setupGit(path);
      onDone(branch);
    } catch (e) {
      failed(e);
    }
    setBusy(null);
  };
  const p = preview;
  return (
    <div className="git-setup">
      {!p ? (
        <>
          <p className="hint">{s.none}</p>
          <div className="git-choices">
            <button className="git-choice" disabled={!!busy} onClick={onFolder}>
              <b>{s.folder}</b>
              <span className="hint">{s.folderHint}</span>
            </button>
            <button className="git-choice" disabled={!!busy} onClick={look}>
              <b>{busy === 'looking' ? s.looking : s.offer}</b>
              <span className="hint">{s.offerHint}</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <b>{s.title}</b>
          <p className="hint">{s.summary(p.files, fileSize(p.bytes), p.branch)}</p>
          <ul className="git-entries">
            {p.entries.map((e) => (
              <li key={e.path} className={!e.dir && e.bytes >= LARGE_FILE ? 'large' : undefined}>
                <code>{e.path}</code>
                <span className="hint">{e.dir ? `${s.files(e.files)} · ${fileSize(e.bytes)}` : fileSize(e.bytes)}</span>
              </li>
            ))}
          </ul>
          {p.large.length > 0 && (
            <div className="git-large">
              <b>{s.large}</b> <span className="hint">{s.largeHint}</span>
              <ul className="git-entries">
                {p.large.map((f) => (
                  <li key={f.path} className="large">
                    <code>{f.path}</code>
                    <span className="hint">{fileSize(f.bytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.ignored.length > 0 && (
            <p className="git-ignored">
              <b>{s.ignored}:</b> {p.ignored.slice(0, IGNORED_SHOWN).map((f, i) => (
                <Fragment key={f}>
                  {i > 0 && ', '}
                  <code>{f}</code>
                </Fragment>
              ))}
              {p.ignored.length > IGNORED_SHOWN && ` ${s.more(p.ignored.length - IGNORED_SHOWN)}`}
            </p>
          )}
          {p.gitignore !== undefined && (
            <details className="git-ignore-file">
              <summary className="hint">
                {s.gitignore} <u>{s.gitignoreShow}</u>
              </summary>
              <pre>{p.gitignore}</pre>
            </details>
          )}
          <p className="hint">{s.change}</p>
          <div className="c-actions">
            <button className="btn primary" disabled={!!busy} onClick={go}>
              {busy === 'working' ? s.working : confirm}
            </button>
            <button className="btn small" disabled={!!busy} onClick={look}>
              {s.again}
            </button>
            <button className="btn small" disabled={!!busy} onClick={() => setPreview(null)}>
              {s.cancel}
            </button>
          </div>
        </>
      )}
      {error && <p className="p-error">{error}</p>}
    </div>
  );
}
