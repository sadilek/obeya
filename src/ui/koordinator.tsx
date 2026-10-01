// The Koordinator's sheet: the conversation, what waits, what runs, and the owner's preferences it keeps.

import { useEffect, useRef, useState } from 'react';
import type { Item, Preference, Talk } from '../core/types';
import { api, ApiError } from './api';
import { Inline, plain } from './markdown';
import { errorText, stateLabel, t } from './strings';
import type { Heard } from './voice';

interface Props {
  on: boolean;
  onHeard: (h: Heard) => void;
  items: Item[];
  preferences: Preference[];
  talk: Talk[];
  onOpen: (i: Item) => void;
}

export function KoordinatorSheet({ on, items, preferences, talk, onOpen, onHeard }: Props) {
  const queued = items.filter((i) => i.state === 'planned' && i.queue);
  const running = items.filter((i) => (i.state === 'working' || i.state === 'waiting') && i.kind !== 'project');
  const title = (id: string) => plain(items.find((i) => i.id === id)?.title ?? '');
  return (
    <aside id="ksheet" className={on ? 'sheet on' : 'sheet'}>
      <div className="p-kind">{t.koordinator.kind}</div>
      <h2>{t.koordinator.title}</h2>
      <Conversation talk={talk} />
      <TellKoordinator onHeard={onHeard} />

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
        {preferences.map((p) => (
          <PreferenceRow key={p.id} p={p} />
        ))}
      </ul>
      <NewPreference />
    </aside>
  );
}

/** What the owner said to the Koordinator with no card open, and its replies; newest last. */
function Conversation({ talk }: { talk: Talk[] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [talk]);
  if (!talk.length) return null;
  const time = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="log talk" ref={box}>
      {talk.map((x) => (
        <div key={x.id} className={x.undone ? 'exchange undone' : 'exchange'}>
          <div className="ev ev-say by-owner">
            <span className="t">{time(x.at)}</span>
            <span className="who">{t.author.owner}</span>
            <span className="x">{x.said}</span>
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
            <div className={`ev ev-say by-${x.answerBy ?? 'koordinator'}`}>
              <span className="t later">{time(x.at)}</span>
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

/** A command in writing, for when speaking is not possible. */
function TellKoordinator({ onHeard }: { onHeard: (h: Heard) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      onHeard(await api.command(text.trim(), null));
      setText('');
    } catch (e) {
      onHeard({ confirm: e instanceof ApiError ? errorText(e.code) : t.offlineError });
    }
    setBusy(false);
  };
  return (
    <div className="composer tell">
      <textarea
        value={text}
        rows={2}
        placeholder={t.voice.typePlaceholder}
        onFocus={() => api.warmVoice()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button className="btn primary" disabled={!text.trim() || busy} onClick={send}>
        {t.send}
      </button>
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

function NewPreference() {
  const [text, setText] = useState('');
  const add = async () => {
    if (!text.trim()) return;
    await api.addPreference(text.trim()).catch(() => {});
    setText('');
  };
  return (
    <div className="composer pref-new">
      <textarea
        value={text}
        rows={1}
        placeholder={t.koordinator.addPlaceholder}
        onChange={(e) => setText(e.target.value)}
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
    </div>
  );
}
