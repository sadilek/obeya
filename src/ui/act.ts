// What the settings sheets and the Coordinator's rows do around a call to the server: load a view
// when the sheet opens, run a call with its status line, follow a job on the server until it ends.

import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import { failText } from './api';
import { useLatest } from './latest';

/**
 * A call the owner makes: `act` runs one (clearing the status line as it starts) and says whether it
 * succeeded, `busy` while it runs, and `status`, the refusal of the last one, or what the form sets
 * there itself (`setStatus`: that it saved, say; `failed`: a refusal of something else, the folder
 * dialog's, say). A call made while another runs is the one that counts: the earlier one's refusal
 * is not shown, and the form is busy until the later one ends. `fail`: how a refusal reads (`failText`).
 */
export function useAct(fail?: Parameters<typeof failText>[1]) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const last = useRef(0);
  const failed = (e: unknown) => setStatus(failText(e, fail));
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    const n = ++last.current;
    setBusy(true);
    setStatus('');
    try {
      await fn();
      return true;
    } catch (e) {
      if (n === last.current) failed(e);
      return false;
    } finally {
      if (n === last.current) setBusy(false);
    }
  };
  return { status, setStatus, failed, busy, act };
}

/** What `load` brings each time `on` becomes true (the sheet opens), and its setter, for the answer to a call. */
export function useLoaded<T>(on: boolean, load: () => Promise<T>): [T | null, Dispatch<SetStateAction<T | null>>] {
  const [view, setView] = useState<T | null>(null);
  useEffect(() => {
    if (on) load().then(setView, console.error);
  }, [on]);
  return [view, setView];
}

/**
 * Calls `poll` every `ms` while `active` (a job runs on the server), the next one only once the last
 * answered, so a slow server is never asked twice at once.
 */
export function usePoll(active: boolean, poll: () => Promise<unknown>, ms: number) {
  const latest = useLatest(poll);
  useEffect(() => {
    if (!active) return;
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await latest.current().catch(console.error);
      if (!done) timer = setTimeout(tick, ms);
    };
    timer = setTimeout(tick, ms);
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [active, ms]);
}
