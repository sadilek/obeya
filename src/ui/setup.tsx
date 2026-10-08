// The setup assistant: what Obeya needs on this machine in one list (Claude Code and its login, git,
// gh and its login, voice, demos), the needed parts apart from those that can wait, installed at a
// click where Obeya can, with the command for the rest and a terminal for the logins. On the first
// start (no canvas yet) it fills the page and ends with the first canvas, from a folder or a clone;
// later the settings open it over the canvas.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Language, MachineItem, MachineSection, MachineView, SetupItem, VoiceSetupItem } from '../core/types';
import { LANGUAGES } from '../core/locale';
import { api, ApiError, reload } from './api';
import { Sign } from './logo';
import { errorText, pushKeyLabel, t } from './strings';

export const megabytes = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1).replace('.', ',')} GB` : `${mb} MB`);
export const PLATFORMS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** A command to run in a terminal, with a button that copies it. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, console.error);
  return (
    <span className="c-cmd">
      <code>{text}</code>
      <button className="c-copy" onClick={copy} title={t.setup.copy}>
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
        return (
          <li key={i.id} className={i.state}>
            <span className="c-mark" aria-hidden>
              {{ ok: '✓', missing: '✗', later: '…', off: '–' }[i.state]}
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
  // the app's key in another app: the key, or what is in the way (src/server/push-key.ts)
  if (i.id === 'globalKey') return i.state === 'ok' ? t.config.pushKey.on(pushKeyLabel(i.found ?? '')) : (t.config.pushKey.states[i.found ?? ''] ?? t.config.pushKey.states.error!);
  if (i.state === 'later') return v.later(megabytes(i.mb ?? 0));
  if (i.state === 'missing') return i.found && i.need ? s.needs(i.found, i.need) : s.missing;
  return (i.found && v.found[i.found]) ?? i.found ?? s.there;
}

/** What the demo check's lines say, here and in the settings sheet. */
export function demoState(i: SetupItem | MachineItem) {
  const s = t.config.setup;
  if (i.state === 'later') return s.later(megabytes(i.mb ?? 0));
  if (i.state === 'off') return s.off;
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
  const failed = (e: unknown) => setStatus(e instanceof ApiError ? `${errorText(e.code)}${e.code === 'invalid' || e.code === 'config' ? ` ${e.message}` : ''}` : t.offlineError);
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
    if (!i.act) return null;
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
      <button className="btn small" disabled={running} onClick={() => act(section, i)}>
        {i.mb ? s.installSized(megabytes(i.mb)) : s.install}
      </button>
    );
  };
  const name = (section: MachineSection) => (i: MachineItem) =>
    section.id === 'voice' ? t.config.voice.names[i.id as VoiceSetupItem['id'] | 'globalKey'] : section.id === 'demos' ? t.config.setup.names[i.id as SetupItem['id']] : s.names[i.id as keyof typeof s.names];
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
        <p className="hint setup-intro">{first ? s.introFirst : s.intro}</p>
        {!view ? (
          <p className="hint">{checking ? t.config.setup.checking : status}</p>
        ) : (
          <>
            <p className="hint">{s.platform(`${PLATFORMS[view.platform] ?? view.platform} (${view.arch})`)}</p>
            {view.sections.map((section) => (
              <section key={section.id} className={`c-canvas c-setup setup-${section.id}`}>
                <div className="setup-sh">
                  <b>{s.sections[section.id].title}</b>
                  <span className={section.id === 'needed' ? 'setup-tag needed' : 'setup-tag'}>{section.id === 'needed' ? s.needed : s.optional}</span>
                  {section.mb > 0 && <span className="hint">{s.size(megabytes(section.mb))}</span>}
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
  const [saved, setSaved] = useState<{ canvas: string; restarting: boolean } | null>(null);
  const s = t.setup;
  const failed = (e: unknown) => setStatus(e instanceof ApiError ? `${errorText(e.code)}${e.code === 'invalid' || e.code === 'config' ? ` ${e.message}` : ''}` : t.offlineError);
  const job = view.job?.kind === 'clone' ? view.job : undefined;
  // a clone that ended as the first canvas
  useEffect(() => {
    if (job && !job.running && job.canvas) setSaved({ canvas: job.canvas, restarting: view.restarts });
  }, [job?.running, job?.canvas]);
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
  const create = async () => {
    setBusy(true);
    setStatus('');
    try {
      const out = await api.setupCanvas(mode === 'folder' ? { path } : { clone, into });
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
        <p className="hint setup-saved">{saved.restarting ? s.first.restarting : s.first.startAgain}</p>
      ) : (
        <>
          <div className="setup-modes" role="tablist">
            {(['folder', 'clone'] as const).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'pill on' : 'pill'} onClick={() => setMode(m)}>
                {s.first.modes[m]}
              </button>
            ))}
          </div>
          {mode === 'folder' ? (
            <div className="c-row">
              <input className="c-path" spellCheck={false} placeholder={s.first.pathPlaceholder} value={path} onChange={(e) => setPath(e.target.value)} />
              {view.picker && (
                <button className="btn small setup-pick" onClick={pick}>
                  {s.first.pick}
                </button>
              )}
            </div>
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
          {job?.running ? (
            <p className="hint c-install">
              <span className="c-step">{s.first.cloning}</span> <code>{job.line}</code>
            </p>
          ) : (
            <div className="c-actions">
              <button className="btn primary" disabled={!can || busy} onClick={create}>
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
