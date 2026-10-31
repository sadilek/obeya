import { useEffect, useState } from 'react';
import { api } from './api';
import { phoneView } from './phone';
import { failText, t } from './strings';

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
  const [here, setHere] = useState(() => !phoneView());
  useEffect(() => {
    let live = true;
    if (here) void onThisMachine().then((v) => live && setHere(v));
    return () => void (live = false);
  }, []);
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
