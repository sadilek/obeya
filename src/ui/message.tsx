// One message of a conversation, as cards and the Coordinator's sheet show it alike: who said it
// and when above, the text below as paragraphs and lists; a reply quotes the message it answers
// above its words, as chat apps do.

import { createContext, type ReactNode, useContext, useRef, useState } from 'react';
import type { AnswerFile, CardEvent, Item } from '../core/types';
import { answerFile, api } from './api';
import { useReportedHeight } from './frame';
import { plain } from './markdown';
import { clock as time, t } from './strings';
import type { Quoted } from './reply';
import { clip } from '../core/text';
import { isWalkthrough } from '../core/walkthrough';
import { WalkthroughButton, WalkthroughPlayer } from './walkthrough';

/**
 * A message's frame: `by` places and colours it (the owner's on the right), `who` heads it with its
 * time; `className` adds what kind it is (a question, the agent at work, the starting point).
 * `ev`: the message's place in the conversation (a card's event id), which a quote of it leads to; `onReply`: the owner can reply to it;
 * `onDelete`: the owner can delete it, with `deleteLabel` as the button's title; `head`: buttons at
 * the right of its head, left of Reply ("Make it a card").
 */
export function Msg({
  by,
  who,
  at,
  className,
  ev,
  onReply,
  onDelete,
  deleteLabel,
  head,
  children,
}: {
  by: string;
  who: ReactNode;
  at?: string;
  className?: string;
  ev?: number | string;
  onReply?: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  head?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={['msg', `by-${by}`, onReply && 'replies', className].filter(Boolean).join(' ')} data-ev={ev}>
      <div className="who">
        {who}
        {at && <span className="t">{time(at)}</span>}
        {(onReply || head) && (
          <span className="msg-acts">
            {/* first of the head's buttons, so it stands rightmost */}
            {onReply && (
              <button className="msg-act msg-reply" onMouseDown={(e) => e.preventDefault()} onClick={onReply}>
                <svg viewBox="0 0 20 20" width="11" height="11" aria-hidden="true">
                  <path d="M8 5 3 10l5 5M3.5 10H11a6 6 0 0 1 6 6v.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t.talk.reply}
              </button>
            )}
            {head}
          </span>
        )}
      </div>
      {onDelete && (
        <button className="msg-delete" title={deleteLabel} aria-label={deleteLabel} onMouseDown={(e) => e.preventDefault()} onClick={onDelete}>
          <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
            <path d="M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10M8.5 9v4.5M11.5 9v4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {children}
    </div>
  );
}

/** Under the owner's words while the Coordinator reads them, in the sheet and on a card alike. */
export const Reading = () => <Msg by="coordinator" className="thinking" who={`${t.author.coordinator} ${t.talk.reading}`} />;

/**
 * Scrolls the conversation to a message (`ev` in `Msg`), which lights up once, so the eye finds it;
 * one that does not stand there as a message goes to `orElse` instead (a question asked again that
 * waits at the end, among the questions for the owner).
 */
export function goToMessage(ev: number | string, orElse?: string) {
  const el = document.querySelector<HTMLElement>(`.talk [data-ev="${ev}"]`) ?? (orElse ? document.querySelector<HTMLElement>(`.talk ${orElse}`) : null);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/**
 * The message a reply answers, quoted above it or above the field the reply is written in: who said
 * it and its start, a few lines at most. A click on it goes to the message in the conversation
 * (`ev` in `Msg`); `onClear` takes it out of the field.
 */
export function Quote({ q, onClear }: { q: Quoted; onClear?: () => void }) {
  return (
    <div className={`quote q-by-${q.by}`}>
      <button className="quote-go" title={t.talk.toQuoted} onMouseDown={(m) => m.preventDefault()} onClick={() => goToMessage(q.ev)}>
        <span className="quote-who">
          {t.author[q.by]}
          {q.what === 'question' ? ` · ${t.talk.question}` : q.what === 'handover' ? ` · ${t.talk.handover}` : ''}
        </span>
        <span className="quote-text">{q.text || '📷'}</span>
      </button>
      {onClear && (
        <button className="quote-clear" title={t.talk.replyCancel} aria-label={t.talk.replyCancel} onMouseDown={(m) => m.preventDefault()} onClick={onClear}>
          ×
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ looked-up answers

/** The highest a page an answer comes with grows in its frame; a higher one scrolls inside it. */
const PAGE_CAP = 900;

const isPage = (name: string) => /\.html?$/i.test(name);
const isImage = (name: string) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name);

/** The mark of a file chip, by what the file is: a table, code, a document, anything else. */
function fileMark(name: string) {
  if (/\.(xlsx?|csv|tsv|ods|numbers)$/i.test(name)) return '▤';
  if (/\.(sql|py|js|ts|sh|r|ipynb|json|ya?ml)$/i.test(name)) return '⌘';
  if (/\.(docx?|odt|rtf|pdf|md|txt|eml)$/i.test(name)) return '✉';
  return '◇';
}

/**
 * The files a looked-up answer comes with, under its text, in the sheet, a card's log and a
 * Question card alike: its walkthrough in its player, a page in
 * the sandboxed frame of an HTML artifact, an image inline, any other file as a chip that opens it
 * with the system's app (or downloads it, where that cannot be), and "Show in folder" for the
 * thread's directory where it holds more than walkthroughs (whose script and audio no one opens).
 */
export function AnswerFiles({ thread, files }: { thread: number; files?: AnswerFile[] }) {
  if (!files?.length) return null;
  const others = files.filter((f) => !isPage(f.name) && !isImage(f.name) && !isWalkthrough(f.name));
  const folder = files.some((f) => !isWalkthrough(f.name));
  const open = (file?: string) =>
    api.openAnswer(thread, file).catch(() => {
      // the system has no app for it here (or Obeya runs elsewhere): the browser saves it instead
      if (file !== undefined) location.assign(answerFile(thread, file, true));
    });
  return (
    <div className="answer-files">
      {files.filter((f) => isWalkthrough(f.name)).map((f) => (
        <WalkthroughPlayer key={f.name} thread={thread} file={f} />
      ))}
      {files.filter((f) => isPage(f.name)).map((f) => (
        <AnswerPage key={f.name} thread={thread} file={f} />
      ))}
      {files.filter((f) => isImage(f.name)).map((f) => (
        <figure key={f.name} className="answer-image">
          <a href={answerFile(thread, f.name)} target="_blank" rel="noreferrer">
            <img src={answerFile(thread, f.name)} alt={f.caption || f.name} />
          </a>
          <figcaption>
            {f.name}
            {f.caption && ` · ${f.caption}`}
          </figcaption>
        </figure>
      ))}
      {folder && (
        <div className="file-chips">
          {others.map((f) => (
            <span key={f.name} className="file-chip">
              <button className="file-open" title={t.answer.open(f.caption)} onMouseDown={(e) => e.preventDefault()} onClick={() => void open(f.name)}>
                <span className="file-mark">{fileMark(f.name)}</span> {f.name}
              </button>
              <a className="file-down" href={answerFile(thread, f.name, true)} title={t.download} aria-label={t.download}>
                ↓
              </a>
            </span>
          ))}
          <button className="link file-folder" title={t.answer.showFolderHint} onMouseDown={(e) => e.preventDefault()} onClick={() => void open()}>
            {t.answer.showFolder}
          </button>
        </div>
      )}
    </div>
  );
}

/** A page an answer comes with: in the frame of an HTML artifact, its scripts away from Obeya's API, as high as it reports. */
function AnswerPage({ thread, file }: { thread: number; file: AnswerFile }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const height = useReportedHeight(frame, PAGE_CAP);
  return (
    <figure className="answer-page">
      <iframe ref={frame} sandbox="allow-scripts" src={answerFile(thread, file.name)} title={file.caption || file.name} style={height ? { height } : undefined} />
      <figcaption>
        <a href={answerFile(thread, file.name)} target="_blank" rel="noreferrer">
          {file.name}
        </a>
        {file.caption && ` · ${file.caption}`}
      </figcaption>
    </figure>
  );
}

/**
 * The head of a looked-up answer's message, right of who said it: "Make it a card", which moves the
 * thread onto a Question card and opens it; or, once it is on one, the way there.
 */
export function ThreadCard({ thread, card, onOpen }: { thread: number; card?: Item; onOpen: (i: Item) => void }) {
  const [busy, setBusy] = useState(false);
  if (card)
    return (
      <button className="msg-act msg-card on" title={t.answer.onCardHint} onMouseDown={(e) => e.preventDefault()} onClick={() => onOpen(card)}>
        ↗ {t.answer.onCard(plain(card.title))}
      </button>
    );
  return (
    <button
      className="msg-act msg-card"
      title={t.answer.makeCardHint}
      disabled={busy}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        setBusy(true);
        api
          .threadCard(thread)
          .then(onOpen)
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
    >
      ↗ {t.answer.makeCard}
    </button>
  );
}

/** The cards on the canvas, and how to open one (closing the card open), for a looked-up answer in a card's log. */
export const Cards = createContext<{ items: Item[]; open: (i: Item) => void }>({ items: [], open: () => {} });

/**
 * Whether a message of a card's conversation is a text answer "Show as walkthrough" can tell: a
 * looked-up answer without a walkthrough, or a reply of Obeya's that only answers.
 */
export const tellable = (e: CardEvent) =>
  !!e.text && !e.answer?.live && (e.answer ? !e.answer.files?.some((f) => isWalkthrough(f.name)) : e.author === 'coordinator' && !!e.reply && !e.wish);

/**
 * What an answer in a card's conversation adds to it: in its head "Make it a card" (a looked-up one,
 * on a card that is not the thread's own) and "Show as walkthrough" (`hint`: it stays in view, the
 * newest answer's, until the owner has used it once), and a looked-up one's files under the text.
 */
export function useAnswer(e: CardEvent, hint?: boolean): { head?: ReactNode; files?: ReactNode; continues?: ReactNode } {
  const { items, open } = useContext(Cards);
  const walk = tellable(e) && <WalkthroughButton of={{ card: e.cardId, ev: e.id }} hint={hint} />;
  if (!e.answer) return walk ? { head: walk } : {};
  const { thread, files, continues, live } = e.answer;
  // its walkthrough plays while its agent tells on: the answer's words, and with them its head, come later
  if (live) return { files: <AnswerFiles thread={thread} files={files} /> };
  const host = items.find((i) => i.id === e.cardId);
  const own = host?.thread?.talk === thread;
  // a thread on a Question card goes on there: its answers are told as walkthroughs there
  const moved = own ? undefined : items.find((i) => i.kind === 'question' && i.thread?.talk === thread);
  return {
    head: (
      <>
        {!own && <ThreadCard thread={thread} card={moved} onOpen={open} />}
        {!moved && walk}
      </>
    ),
    files: <AnswerFiles thread={thread} files={files} />,
    ...(continues ? { continues: <Continues question={continues} /> } : {}),
  };
}

/** Under a follow-up: which answer it continues (or which look-up its words went into), and while it is looked up, that its agent reads. */
export const Continues = ({ question, reading, adds }: { question: string; reading?: boolean; adds?: boolean }) => (
  <div className="continues">
    {(adds ? t.answer.addsTo : t.answer.continues)(clip(plain(question), 90))}
    {reading && ` · ${t.answer.reading}`}
  </div>
);

