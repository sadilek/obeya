import { useEffect, useState } from 'react';
import { api, failText } from './api';
import { useAsked } from './asked';
import { phoneView } from './phone';
import { t } from './strings';

/** Whether this browser runs on the machine Obeya runs on, asked once per page. */
let local: Promise<boolean> | undefined;
const onThisMachine = () => (local ??= api.access().then((v) => v.local, () => true));

/**
 * The same terminal login as Setup, offered where an agent's expired login interrupted a chat. A
 * session that signed in with a token (`token`: on another machine, or on CLAUDE_CODE_OAUTH_TOKEN)
 * gets a new one instead: `claude setup-token` in a terminal, its token pasted here for Obeya to keep.
 * The terminal opens on the machine Obeya runs on, so the phone view and another device get no
 * button, only where to go.
 */
export function Reauthenticate({ start = false, token = false }: { start?: boolean; token?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [command, setCommand] = useState('');
  const [pasted, setPasted] = useState('');
  const [saved, setSaved] = useState(false);
  const here = useAsked(!phoneView() && onThisMachine, !phoneView());
  const login = async () => {
    setBusy(true);
    setStatus('');
    try {
      const { opened, command } = await api.setupLogin('needed', 'claudeLogin', token);
      setCommand(command);
      setStatus(opened ? t.setup.terminalOpen : t.setup.noTerminal);
    } catch (e) {
      setStatus(failText(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.setupToken(pasted.trim());
      setPasted('');
      setSaved(true);
      setStatus('');
    } catch (e) {
      setStatus(failText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!here) return <div className="reauthenticate"><div className="hint">{t.setup.atComputer(token)}</div></div>;
  if (saved) return <div className="reauthenticate"><div className="hint" role="status">{t.setup.tokenSaved(start)}</div></div>;
  return (
    <div className="reauthenticate">
      {token && <div className="hint">{t.setup.tokenWhy}</div>}
      <button className="btn small" disabled={busy} onClick={() => void login()}>{token ? t.setup.newToken : t.setup.reauthenticate}</button>
      {status && <span className="hint" role="status">{status}</span>}
      {command && <div className="hint"><code>{command}</code></div>}
      {command && !token && <div className="hint">{start ? t.setup.startAfterReauthenticate : t.setup.afterReauthenticate}</div>}
      {command && token && (
        <form className="reauthenticate-token" onSubmit={(e) => (e.preventDefault(), void save())}>
          <label className="hint" htmlFor="reauthenticate-token">{t.setup.pasteToken}</label>
          <div className="c-row">
            <input id="reauthenticate-token" type="password" autoComplete="off" spellCheck={false} placeholder={t.setup.tokenPlaceholder} value={pasted} onChange={(e) => setPasted(e.target.value)} />
            <button className="btn small" type="submit" disabled={busy || !pasted.trim()}>{t.setup.saveToken}</button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Logs Codex in again where a card's session lost its login (`host`: the machine it ran on, null
 * for this one): ChatGPT's sign-in opens in a new tab, and the line says once it worked. The
 * sign-in returns to the machine Obeya runs on, so the phone view and another device get no
 * button, only where to go.
 */
export function CodexLogin({ host, start = false }: { host: string | null; start?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState('');
  const [done, setDone] = useState(false);
  const here = useAsked(!phoneView() && onThisMachine, !phoneView());
  const [following, setFollowing] = useState('');
  useEffect(() => {
    if (!following) return;
    let live = true;
    const look = async () => {
      if (!live) return;
      try {
        const s = await api.codexLoginState(following);
        if (!live) return;
        if (s.state === 'done') return setDone(true);
        if (s.state === 'failed') {
          setFollowing('');
          setPage('');
          return setStatus(t.setup.failed(s.error ?? ''));
        }
      } catch {}
      setTimeout(() => void look(), 1500);
    };
    void look();
    return () => void (live = false);
  }, [following]);
  const login = async () => {
    setBusy(true);
    setStatus('');
    // opened in the click, which the browser allows, and pointed at the page once Codex names it
    const tab = window.open('', '_blank');
    try {
      const { id, url } = await api.codexLogin(host);
      if (tab) tab.location.href = url;
      setPage(url);
      setFollowing(id);
    } catch (e) {
      tab?.close();
      setStatus(failText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!here) return <div className="reauthenticate"><div className="hint">{t.setup.codexAtComputer}</div></div>;
  if (done) return <div className="reauthenticate"><div className="hint" role="status">{t.setup.codexLoggedIn(start)}</div></div>;
  return (
    <div className="reauthenticate">
      <button className="btn small" disabled={busy} onClick={() => void login()}>{t.setup.codexLogin}</button>
      {page && <span className="hint" role="status">{t.setup.codexSigningIn(host)} <a href={page} target="_blank" rel="noreferrer">{t.setup.codexOpenPage}</a></span>}
      {status && <span className="hint" role="status">{status}</span>}
    </div>
  );
}
