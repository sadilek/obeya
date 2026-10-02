// The Koordinator's sheet: the conversation, what waits, what runs, and the owner's preferences it
// keeps, with the ones it learned and proposes.

import { useEffect, useRef, useState } from 'react';
import type { Item, Preference, RepoRef, Talk } from '../core/types';
import { api, ApiError } from './api';
import { Inline, plain } from './markdown';
import { errorText, stateLabel, t } from './strings';
import { AttachButton, ShotStrip, Shots, useShotInput } from './shots';
import type { Heard } from './voice';

interface Props {
  on: boolean;
  onHeard: (h: Heard) => void;
  items: Item[];
  preferences: Preference[];
  /** The canvas's repositories, whose CLAUDE.md a proposal may go into. */
  repos: RepoRef[];
  talk: Talk[];
  onOpen: (i: Item) => void;
}

export function KoordinatorSheet({ on, items, preferences, repos, talk, onOpen, onHeard }: Props) {
  const queued = items.filter((i) => i.state === 'planned' && i.queue);
  const running = items.filter((i) => (i.state === 'working' || i.state === 'waiting') && i.kind !== 'project');
  const title = (id: string) => plain(items.find((i) => i.id === id)?.title ?? '');
  const proposals = preferences.filter((p) => p.state === 'proposed');
  const rules = preferences.filter((p) => p.state === 'active');
  return (
    <aside id="ksheet" className={on ? 'sheet on' : 'sheet'}>
      <div className="p-kind">{t.koordinator.kind}</div>
      <h2>{t.koordinator.title}</h2>
      <Conversation talk={talk} />
      <div className="k-rest">
        <TellKoordinator onHeard={onHeard} />

        {proposals.length > 0 && (
          <>
            <h4 className="p-h">{t.koordinator.proposals}</h4>
            <p className="hint">{t.koordinator.proposalsHint}</p>
            <ul className="prefs proposals">
              {proposals.map((p) => (
                <ProposalRow key={p.id} p={p} items={items} rules={rules} repos={repos} onOpen={onOpen} />
              ))}
            </ul>
          </>
        )}

        <h4 className="p-h">{t.koordinator.queue}</h4>
        {queued.length === 0 ? (
          <p className="hint">{t.koordinator.queueEmpty}</p>
        ) : (
          <ol>
            {queued.map((i) => (
              <li key={i.id} className="s-planned" onClick={() => onOpen(i)}>
                <span className="dot" />
                <span>
                  {plain(i.title)}
                  <br />
                  <span className="hint">
                    {i.queue && 'behind' in i.queue ? t.queue.behind(i.queue.behind.map(title)) : stateLabel(i)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}

        <h4 className="p-h">{t.koordinator.running}</h4>
        {running.length === 0 ? (
          <p className="hint">{t.koordinator.runningEmpty}</p>
        ) : (
          <ol>
            {running.map((i) => (
              <li key={i.id} className={`s-${i.state}`} onClick={() => onOpen(i)}>
                <span className="dot" />
                <span>
                  {plain(i.title)}
                  <br />
                  <span className="hint">{i.statusLine ?? stateLabel(i)}</span>
                </span>
              </li>
            ))}
          </ol>
        )}

        <h4 className="p-h">{t.koordinator.preferences}</h4>
        <p className="hint">{t.koordinator.preferencesHint}</p>
        <ul className="prefs">
          {rules.map((p) => (
            <PreferenceRow key={p.id} p={p} />
          ))}
        </ul>
        <NewPreference repos={repos} />
      </div>
    </aside>
  );
}

/** What the owner said to the Koordinator with no card open, and its replies; newest last. */
function Conversation({ talk }: { talk: Talk[] }) {
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // it takes the height the sheet leaves free; when the rest needs more, it keeps 360px, or less
    // when the conversation is shorter than that
    el.style.minHeight = '0';
    el.style.minHeight = `${Math.min(360, el.scrollHeight)}px`;
    el.scrollTop = el.scrollHeight;
    atEnd.current = true;
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
  const time = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return (
    <div
      className="log talk"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      }}
    >
      {talk.map((x) => (
        <div key={x.id} className={x.undone ? 'exchange undone' : 'exchange'}>
          <div className="ev ev-say by-owner">
            <span className="t">{time(x.at)}</span>
            <span className="who">{t.author.owner}</span>
            <span className="x">
              {x.said}
              <Shots ids={x.images} />
            </span>
          </div>
          <div className="ev ev-say by-koordinator">
            <span className="t">{time(x.at)}</span>
            <span className="who">{t.author.koordinator}</span>
            <span className="x">
              {x.reply}
              {x.undone && <span className="hint"> ({t.koordinator.undone})</span>}
            </span>
          </div>
          {/* a question it looked up: the answer follows the acknowledgement */}
          {x.question && x.answer === undefined && (
            <div className="ev ev-say by-koordinator">
              <span className="t">{time(x.at)}</span>
              <span className="who">{t.author.koordinator}</span>
              <span className="x hint">{t.koordinator.lookingUp}</span>
            </div>
          )}
          {x.answer !== undefined && (
            <div className={`ev ev-say answer by-${x.answerBy ?? 'koordinator'}`}>
              <span className="who">{t.author[x.answerBy ?? 'koordinator']}</span>
              <span className="x">
                <Inline md={x.answer} />
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** A command in writing, for when speaking is not possible; its screenshots go to the cards it creates or concerns. */
function TellKoordinator({ onHeard }: { onHeard: (h: Heard) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const shots = useShotInput();
  const ready = !!text.trim() && !busy && !shots.uploading;
  const send = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      onHeard(await api.command(text.trim(), null, shots.images));
      setText('');
      shots.clear();
    } catch (e) {
      onHeard({ confirm: e instanceof ApiError ? errorText(e.code) : t.offlineError });
    }
    setBusy(false);
  };
  return (
    <div className={`composer tell${shots.dropping ? ' dropping' : ''}`} {...shots.drop}>
      <ShotStrip shots={shots} />
      <div className="c-field">
        <textarea
          value={text}
          rows={2}
          placeholder={t.voice.typePlaceholder}
          onFocus={() => api.warmVoice()}
          onChange={(e) => setText(e.target.value)}
          onPaste={shots.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <AttachButton shots={shots} />
      </div>
      <button className="btn primary" disabled={!ready} onClick={send}>
        {t.send}
      </button>
      {shots.error && <p className="p-error c-error">{shots.error}</p>}
    </div>
  );
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
