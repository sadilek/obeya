// The Koordinator's sheet: the conversation, with the height the sheet has, and below it sections
// that open and close: the rules it learned and proposes, and the owner's preferences; and shared
// demos to bring up to date at once.

import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Item, Preference, RepoRef, Reshare, Talk } from '../core/types';
import { api, ApiError } from './api';
import { plain } from './markdown';
import { Body, Msg } from './message';
import { errorText, t } from './strings';
import { Composer } from './composer';
import { Shots } from './shots';

interface Props {
  on: boolean;
  /** The canvas, whose sections stay open or closed as the owner left them. */
  canvas: string;
  /** A command typed in the sheet: read like a spoken one, with its line above the microphone. */
  onTell: (text: string, images?: string[]) => void;
  items: Item[];
  preferences: Preference[];
  /** The canvas's repositories, whose CLAUDE.md a proposal may go into. */
  repos: RepoRef[];
  talk: Talk[];
  reshare?: Reshare;
  onOpen: (i: Item) => void;
}

export function KoordinatorSheet({ on, canvas, items, preferences, repos, talk, reshare, onOpen, onTell }: Props) {
  const proposals = preferences.filter((p) => p.state === 'proposed');
  const rules = preferences.filter((p) => p.state === 'active');
  const [folds, setFolds] = useFolds(canvas);
  const fresh = useRead(on, talk);
  // the proposals stay closed only as long as no proposal came after the owner closed them
  const proposalsOpen = !folds.proposalsClosed || proposals.some((p) => !folds.proposalsClosed!.includes(p.id));
  return (
    <aside id="ksheet" className={on ? 'sheet on' : 'sheet'}>
      <div className="p-kind">{t.koordinator.kind}</div>
      <h2>{t.koordinator.title}</h2>
      <Conversation talk={talk} fresh={fresh} />
      <TellKoordinator onTell={onTell} />

      <div className="k-rest">
        {proposals.length > 0 && (
          <Fold
            kind="proposals"
            head={t.koordinator.proposalsHead(proposals.length)}
            open={proposalsOpen}
            onToggle={() => setFolds({ ...folds, proposalsClosed: proposalsOpen ? proposals.map((p) => p.id) : undefined })}
          >
            <p className="hint">{t.koordinator.proposalsHint}</p>
            <ul className="prefs proposals">
              {proposals.map((p) => (
                <ProposalRow key={p.id} p={p} items={items} rules={rules} repos={repos} onOpen={onOpen} />
              ))}
            </ul>
          </Fold>
        )}

        {reshare && <ReshareBox r={reshare} items={items} onOpen={onOpen} />}

        <Fold head={t.koordinator.preferencesHead(rules.length)} open={!!folds.preferences} onToggle={() => setFolds({ ...folds, preferences: !folds.preferences })}>
          <p className="hint">{t.koordinator.preferencesHint}</p>
          <ul className="prefs">
            {rules.map((p) => (
              <PreferenceRow key={p.id} p={p} />
            ))}
          </ul>
          <NewPreference repos={repos} />
        </Fold>
      </div>
    </aside>
  );
}

/**
 * Answers that came while the owner was elsewhere are read once the sheet is in view (open, and the
 * page not hidden); those that were waiting stay marked until it closes, so the owner sees which.
 */
function useRead(on: boolean, talk: Talk[]): number[] {
  const [fresh, setFresh] = useState<number[]>([]);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const seen = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, []);
  const unread = talk.filter((x) => x.unread).map((x) => x.id);
  useEffect(() => {
    if (!on) return setFresh([]);
    if (!visible || !unread.length) return;
    setFresh((f) => [...f, ...unread.filter((id) => !f.includes(id))]);
    api.readTalk().catch(() => {});
  }, [on, visible, unread.join()]);
  return fresh;
}

/** Which of the sheet's sections the owner opened; the proposals are open unless closed, with the ones open then. */
interface Folds {
  preferences?: boolean;
  proposalsClosed?: number[];
}

/** The sections' state, per canvas, so a reload keeps it. */
function useFolds(canvas: string): [Folds, (f: Folds) => void] {
  const key = `obeya-ksheet-${canvas}`;
  const read = (): Folds => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
    } catch {
      return {};
    }
  };
  const [folds, setFolds] = useState<{ key: string; f: Folds }>(() => ({ key, f: read() }));
  const f = folds.key === key ? folds.f : read();
  return [
    f,
    (next) => {
      setFolds({ key, f: next });
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
    },
  ];
}

/** A section under the conversation: a head with its count that opens and closes it. */
function Fold({ kind, head, open, onToggle, children }: { kind?: string; head: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={['fold', kind, open && 'open'].filter(Boolean).join(' ')}>
      <button className="fold-head" aria-expanded={open} onClick={onToggle}>
        <span className="arrow" />
        {head}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}

/** What the owner said to the Koordinator with no card open, and its replies; newest last. */
function Conversation({ talk, fresh }: { talk: Talk[]; fresh: number[] }) {
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const newest = useRef<number | undefined>(undefined);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // every change on the canvas brings a new snapshot: only what the owner just said takes the
    // conversation back to its end, so they can read further up in the meantime
    const last = talk.at(-1)?.id;
    if (last !== newest.current) atEnd.current = true;
    newest.current = last;
    if (atEnd.current) el.scrollTop = el.scrollHeight;
  }, [talk]);
  useEffect(() => {
    // the newest exchange stays in view when the sheet grows or shrinks, or the text wraps anew once
    // the font is in, unless the owner scrolled up
    const el = box.current;
    if (!el) return;
    const keep = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight;
    });
    keep.observe(el);
    for (const x of el.children) keep.observe(x);
    return () => keep.disconnect();
  }, [talk]);
  if (!talk.length) return null;
  return (
    <div
      className="talk conv"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      }}
    >
      {talk.map((x) => (
        <Fragment key={x.id}>
          <Msg by="owner" who={t.author.owner} at={x.at}>
            <Body md={x.said} />
            <Shots ids={x.images} />
          </Msg>
          <Msg by="koordinator" className={x.undone ? 'undone' : undefined} who={t.author.koordinator} at={x.at}>
            <Body md={x.reply} />
            {x.undone && <div className="hint">{t.koordinator.undone}</div>}
          </Msg>
          {/* a question it looked up: the answer follows the acknowledgement */}
          {x.question && x.answer === undefined && (
            <Msg by="koordinator" className="thinking" who={t.author.koordinator}>
              <div className="hint">{t.koordinator.lookingUp}</div>
            </Msg>
          )}
          {x.answer !== undefined && (
            <Msg by={x.answerBy ?? 'koordinator'} className={fresh.includes(x.id) ? 'fresh' : undefined} who={t.author[x.answerBy ?? 'koordinator']}>
              <Body md={x.answer} />
            </Msg>
          )}
        </Fragment>
      ))}
    </div>
  );
}

/** A command in writing, for when speaking is not possible; its screenshots go to the cards it creates or concerns. */
function TellKoordinator({ onTell }: { onTell: (text: string, images?: string[]) => void }) {
  return <Composer className="tell" placeholder={t.voice.typePlaceholder} obeya onSend={onTell} />;
}

/**
 * A rule the Koordinator learned, with where it came from and where it goes (the preferences, or a
 * repository's CLAUDE.md): the owner accepts it, in their own words and for another place if they
 * like, or rejects it.
 */
function ProposalRow({ p, items, rules, repos, onOpen }: { p: Preference; items: Item[]; rules: Preference[]; repos: RepoRef[]; onOpen: (i: Item) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [target, setTarget] = useState(p.target ?? '');
  const [error, setError] = useState('');
  const card = p.cardId ? items.find((i) => i.id === p.cardId) : undefined;
  const replaced = p.replaces !== undefined ? rules.find((r) => r.id === p.replaces) : undefined;
  const decide = async (act: () => Promise<void>) => {
    try {
      await act();
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  };
  const accept = () =>
    decide(() => api.acceptProposal(p.id, draft === null || draft.trim() === p.text ? undefined : draft.trim(), target === (p.target ?? '') ? undefined : target || null));
  const quote = p.quote && (p.quote.length > 200 ? `${p.quote.slice(0, 200).trimEnd()} …` : p.quote);
  return (
    <li className="proposal">
      {draft === null ? (
        <span className="pref-text">{p.text}</span>
      ) : (
        <textarea
          autoFocus
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (draft.trim()) accept();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(null);
            }
          }}
        />
      )}
      {replaced && <span className="occasion">{t.koordinator.changes(replaced.text)}</span>}
      <span className="occasion">
        {p.review ? (
          <>
            {t.koordinator.fromReview}
            {quote && `: ${quote}`}
          </>
        ) : (
          <>
            {card && (
              <a className="from" onClick={() => onOpen(card)}>
                {plain(card.title)}
              </a>
            )}
            {card && quote && ': '}
            {quote && <q>{quote}</q>}
          </>
        )}
      </span>
      <label className="target">
        {t.koordinator.target}
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">{t.koordinator.targetPreferences}</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {t.koordinator.targetClaudeMd(r.name)}
            </option>
          ))}
        </select>
      </label>
      <span className="pref-actions">
        <button className="btn primary" disabled={draft !== null && !draft.trim()} onClick={accept}>
          {t.koordinator.accept}
        </button>
        {draft === null ? (
          <button className="btn" onClick={() => setDraft(p.text)}>
            {t.koordinator.change}
          </button>
        ) : (
          <button className="btn" onClick={() => setDraft(null)}>
            {t.koordinator.cancel}
          </button>
        )}
        <button className="btn danger" onClick={() => decide(() => api.rejectProposal(p.id))}>
          {t.koordinator.reject}
        </button>
      </span>
      {error && <span className="p-error">{error}</span>}
    </li>
  );
}

/** How many of the outdated shared demos to share again at once: the newest few, or all. */
const RESHARE_COUNTS = [10, 20, 50, 100];

/**
 * Shared demos whose pages are made differently now: shared again many at once, the newest first,
 * one after the other, with how far it got and which failed.
 */
function ReshareBox({ r, items, onOpen }: { r: Reshare; items: Item[]; onOpen: (i: Item) => void }) {
  const counts = RESHARE_COUNTS.filter((n) => n < r.outdated);
  const [pick, setPick] = useState<number | 'all'>();
  const [error, setError] = useState('');
  // the newest 20 unless the owner picks otherwise; null is all of them
  const chosen = pick === 'all' ? null : pick !== undefined && counts.includes(pick) ? pick : (counts.find((n) => n >= 20) ?? null);
  const run = r.run;
  const going = !!run && run.left > 0;
  const act = async (fn: () => Promise<void>) => {
    try {
      await fn();
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  };
  const s = t.koordinator.reshare;
  const out = run ? run.done + run.failed.length : 0;
  return (
    <div className="reshare">
      <ul className="prefs proposals">
        {run && (
          <li>
            <span className="pref-text">{going ? s.progress(out, run.total) : run.stopped ? s.stopped(run.done, run.total) : s.finished(run.done, run.total)}</span>
            <span className="bar">
              <span style={{ width: `${run.total ? (100 * out) / run.total : 100}%` }} />
            </span>
            {going && run.current && <span className="occasion">{s.now(plain(run.current))}</span>}
            {run.failed.length > 0 && (
              <span className="occasion">
                {s.failed(run.failed.length)}
                {run.failed.map((f) => {
                  const card = items.find((i) => i.id === f.id);
                  return (
                    <span key={f.id} className="failed">
                      {card ? (
                        <a className="from" onClick={() => onOpen(card)}>
                          {plain(f.title)}
                        </a>
                      ) : (
                        plain(f.title)
                      )}
                    </span>
                  );
                })}
              </span>
            )}
            <span className="pref-actions">
              {going ? (
                <button className="btn" title={s.stopHint} disabled={!!run.stopped} onClick={() => act(api.stopReshare)}>
                  {s.stop}
                </button>
              ) : (
                <button className="btn" onClick={() => act(api.dismissReshare)}>
                  {s.dismiss}
                </button>
              )}
            </span>
          </li>
        )}
        {r.outdated > 0 && !going && (
          <li>
            <span className="pref-text">{s.outdated(r.outdated)}</span>
            <span className="occasion">{s.outdatedHint}</span>
            <span className="pref-actions">
              {counts.length > 0 && (
                <select value={chosen ?? ''} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : 'all')}>
                  {counts.map((n) => (
                    <option key={n} value={n}>
                      {s.newest(n)}
                    </option>
                  ))}
                  <option value="">{s.all(r.outdated)}</option>
                </select>
              )}
              <button className="btn primary" onClick={() => act(() => api.reshare(chosen))}>
                {s.go}
              </button>
            </span>
          </li>
        )}
      </ul>
      {error && <p className="p-error">{error}</p>}
    </div>
  );
}

function PreferenceRow({ p }: { p: Preference }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const save = async () => {
    if (draft === null || draft.trim() === p.text) return setDraft(null);
    try {
      await api.setPreference(p.id, draft);
      setDraft(null);
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  };
  return (
    <li>
      {draft === null ? (
        <span className="pref-text" title={t.koordinator.edit} onClick={() => setDraft(p.text)}>
          {p.text}
        </span>
      ) : (
        <textarea
          autoFocus
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(null);
            }
          }}
        />
      )}
      <button className="pref-del" title={t.koordinator.remove} onClick={() => api.setPreference(p.id, null).catch(() => {})}>
        ✕
      </button>
      {error && <span className="p-error">{error}</span>}
    </li>
  );
}

/** A rule the owner writes: one of theirs, active at once, or for a repository's CLAUDE.md, which goes into its card „CLAUDE.md ergänzen“. */
function NewPreference({ repos }: { repos: RepoRef[] }) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState('');
  const [filed, setFiled] = useState('');
  const [error, setError] = useState('');
  const add = async () => {
    if (!text.trim()) return;
    try {
      await api.addPreference(text.trim(), target || undefined);
      setText('');
      setError('');
      setFiled(target ? t.koordinator.filed(repos.find((r) => r.id === target)?.name ?? target) : '');
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e.code) : t.offlineError);
    }
  };
  return (
    <div className="composer pref-new">
      <textarea
        value={text}
        rows={1}
        placeholder={t.koordinator.addPlaceholder}
        onChange={(e) => {
          setText(e.target.value);
          setFiled('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            add();
          }
        }}
      />
      <button className="btn" disabled={!text.trim()} onClick={add}>
        {t.koordinator.add}
      </button>
      <label className="target">
        {t.koordinator.target}
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">{t.koordinator.targetPreferences}</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {t.koordinator.targetClaudeMd(r.name)}
            </option>
          ))}
        </select>
      </label>
      {filed && <span className="hint filed">{filed}</span>}
      {error && <span className="p-error">{error}</span>}
    </div>
  );
}
