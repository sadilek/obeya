import { useState } from 'react';
import { api } from './api';
import { failText, t } from './strings';

/** The same terminal login as Setup, offered where an agent's expired login interrupted a chat. */
export function Reauthenticate({ start = false }: { start?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [command, setCommand] = useState('');
  const login = async () => {
    setBusy(true);
    setStatus('');
    try {
      const { opened, command } = await api.setupLogin('needed', 'claudeLogin');
      setCommand(command);
      setStatus(opened ? t.setup.terminalOpen : t.setup.noTerminal);
    } catch (e) {
      setStatus(failText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="reauthenticate">
      <button className="btn small" disabled={busy} onClick={() => void login()}>{t.setup.reauthenticate}</button>
      {status && <span className="hint" role="status">{status}</span>}
      {command && <div className="hint"><code>{command}</code></div>}
      {command && <div className="hint">{start ? t.setup.startAfterReauthenticate : t.setup.afterReauthenticate}</div>}
    </div>
  );
}
