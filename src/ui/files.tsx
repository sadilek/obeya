// The files a card's work made or changed, as its result on the left beside the conversation: the
// change list above the view, a line each (the demo first), which picks what the view shows;
// Markdown formatted, a PDF in the browser's viewer (drawn by pdf.js on a phone), an image, a page in the sandboxed frame of an
// HTML artifact, text as it is, anything else as a tile; each to open on the computer, show in its
// folder, or download. Folder and git cards alike.

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type CardDiff, diffSize, shownChanges, splitDiff } from '../core/diff';
import { type ChangeRow, changeRows, imageAt, type ShownFile } from '../core/files';
import type { DemoKind, Item } from '../core/types';
import { api, cardFile } from './api';
import { ChangeNote, DiffView, FileDiff, Lines, MARK } from './diff';
import { Doc, DocImages } from './markdown';
import { useReportedHeight } from './message';
import { PdfPages } from './pdf';
import { phoneView } from './phone';
import { t } from './strings';

/** How many lines the change list shows before „und N weitere ▾“ where it is not folded to the result; the file picked shows too. */
const FOLD = 8;
/** How much of a text file the view shows; the rest is a click on „Auf dem Rechner öffnen“ or ↓ away. */
const TEXT_CAP = 400_000;
/** The highest a page grows in its frame; a higher one scrolls inside it. */
const PAGE_CAP = 30000;

const DEMO = '';

/** The card's change, read as the work moves on; `given` where the card has read it already (a folder's change list). */
function useChange(item: Item, given: CardDiff | null | undefined): CardDiff | null {
  const [diff, setDiff] = useState<CardDiff | null>(null);
  const own = given === undefined;
  useEffect(() => {
    if (!own) return;
    let gone = false;
    api.diff(item.id).then((d) => !gone && setDiff(d), () => {});
    return () => {
      gone = true;
    };
  }, [own, item.id, item.state, item.need, item.summary, item.workspace, JSON.stringify(item.files)]);
  return own ? diff : given;
}

/**
 * The card's left column with its files: the change list, the demo (`demo`) under its first line, a
 * file's view under each line that has one. Without a change it is the demo alone. `diff`: the
 * card's change where the card has read it already. `tab`: the path of the file picked (`''` the
 * demo); null for the first.
 */
export function ResultFiles({ item, diff, demo, tab, onTab }: { item: Item; diff?: CardDiff | null; demo: ReactNode; tab: string | null; onTab: (path: string) => void }) {
  const change = useChange(item, diff);
  // the demo's line says what it is, a video or an artifact; where the card's demos are of both kinds, only that it is the demo
  const kinds = new Set([...(item.demos ?? []), item.demo].map((d) => d?.kind ?? 'video'));
  const demoKind = demo ? (kinds.size === 1 ? [...kinds][0]! : 'any') : undefined;
  // beside a demo, and while the agent is at work, the code behind the result waits folded
  const fold = !!demo || atWork(item);
  const rows = changeRows(change, item.files);
  const files = rows.flatMap((r) => (r.file ? [r.file] : []));
  // which files show their changes rather than themselves, where the owner chose; a changed one does at first
  const [asChanges, setAsChanges] = useState<Record<string, boolean>>({});
  const demoBox = useRef<HTMLDivElement>(null);
  // what the shown files are as of now: the change read and the latest handover
  const rev = revision(`${item.state}:${item.need ?? ''}:${item.summary ?? ''}:${JSON.stringify(change?.files ?? [])}:${JSON.stringify(change?.folder?.changes ?? [])}`);
  // the column keeps the height of its tallest view so far: the card does not shrink and move under the list
  const box = useRef<HTMLDivElement>(null);
  const [tallest, setTallest] = useState(0);
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    if (h > tallest) setTallest(h);
  });
  const first = demo ? DEMO : ((fold ? files.find((f) => f.caption !== undefined) : files[0])?.path ?? DEMO);
  const current = tab !== null && (tab === DEMO ? !!demo : files.some((f) => f.path === tab)) ? tab : first;
  // a video left playing under another file would go on talking
  const shown = useRef(current);
  useEffect(() => {
    if (shown.current === current) return;
    shown.current = current;
    if (current !== DEMO) demoBox.current?.querySelectorAll('video').forEach((v) => v.pause());
  }, [current]);
  // a line picked brings its view into sight where it lies below the column's visible part, the line picked already too:
  // the click would otherwise seem to do nothing
  const [picked, setPicked] = useState(0);
  useEffect(() => {
    if (!picked) return;
    const view = current === DEMO ? (demoBox.current?.querySelector('video, iframe') ?? demoBox.current) : box.current?.querySelector('.r-file');
    if (view && !seen(view)) view.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [picked]);
  if (!rows.length && !demo) return item.files && change ? <p className="hint">{t.files.none}</p> : null;
  const file = files.find((f) => f.path === current);
  // the size of the whole change stands with its files, not up in the card's branch line
  const count = change?.folder ? shownChanges(change.folder.changes).length : (change?.files.length ?? 0);
  // the demo keeps its place in the page once the change is read: moved, it would start afresh and no longer play on its own
  return (
    <div className="results" ref={box} style={tallest ? { minHeight: tallest } : undefined}>
      {rows.length > 0 && (
        <ChangeList
          item={item}
          rows={rows}
          demo={demoKind}
          fold={fold}
          total={count ? { ...diffSize(change!.files), files: count } : undefined}
          current={current}
          onPick={(path, changes) => {
            onTab(path);
            setPicked(picked + 1);
            if (changes !== undefined) setAsChanges({ ...asChanges, [path]: changes });
          }}
        />
      )}
      {demo && (
        <div ref={demoBox} hidden={current !== DEMO}>
          {demo}
        </div>
      )}
      {/* a new handover (or the work going on) may change the file at the same path: its view is read afresh */}
      {file && (
        <FileView
          key={`${file.path}:${rev}`}
          item={item}
          file={file}
          rev={rev}
          changes={file.diff && (asChanges[file.path] ?? true)}
          onChanges={(c) => setAsChanges({ ...asChanges, [file.path]: c })}
        />
      )}
      {!file && !demo && !fold && <p className="hint">{t.files.none}</p>}
    </div>
  );
}

/** A card whose agent is still at work on it: what it changed is not its result yet. */
export const atWork = (item: Item) => item.state === 'working' || item.state === 'planned' || (item.state === 'waiting' && item.need === 'question');

/**
 * The card's change list, a line per file: its sign, its path (cut at the front, so its name stays),
 * its lines added and removed, and in a folder what discarding would leave. With `onPick` it picks
 * what the left column shows: the line `current` marked, a click on a line showing its file (on its
 * lines, its changes), the demo first where there is one (`demo`, named by its kind), lines without a view greyed. A
 * line's lines open its diff over the page where it has no view, and without `onPick` its path does
 * too. With `fold`, only the demo and the files its worker named show, the rest a click away; without it,
 * the lines past `FOLD`. `total`, the size of the whole change, stands below the list and opens its whole diff.
 */
export function ChangeList({
  item,
  rows,
  demo,
  fold,
  total,
  current,
  onPick,
}: {
  item: Item;
  rows: ChangeRow[];
  demo?: DemoKind | 'any';
  fold?: boolean;
  total?: { added: number; removed: number; files: number };
  current?: string;
  onPick?: (path: string, changes?: boolean) => void;
}) {
  const [more, setMore] = useState(false);
  // one file's diff over the page, or the whole change's
  const [open, setOpen] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  const pick = onPick && ((path: string, changes?: boolean) => {
    setMore(false);
    onPick(path, changes);
  });
  const lines: (ChangeRow | typeof DEMO)[] = [...(demo ? ([DEMO] as const) : []), ...rows];
  const at = (l: ChangeRow | typeof DEMO) => (l === DEMO ? DEMO : l.path);
  // folded, the result is the demo and the files the worker named; otherwise a line or two past the fold are shown rather than folded
  const kept = fold ? lines.filter((l) => l === DEMO || l.caption !== undefined) : lines.slice(0, FOLD);
  const folds = fold ? kept.length < lines.length : lines.length > FOLD + 2;
  const visible = folds && !more ? lines.filter((l) => kept.includes(l) || at(l) === current) : lines;
  const hidden = lines.length - visible.length;
  const toggle = folds && (more || hidden > 0);
  // folded to the demo alone, the toggle counts the files, and the size beside it need not
  const counted = toggle && !more && !visible.some((l) => l !== DEMO);
  return (
    <div className="cl-list" role={pick ? 'tablist' : undefined}>
      <table>
        <colgroup>
          <col className="cl-mark" />
          <col />
          <col className="cl-n" />
          <col className="cl-n" />
        </colgroup>
        <tbody>
          {visible.map((l) =>
            l === DEMO ? (
              <tr key="demo" className={current === DEMO ? 'cl-row on' : 'cl-row'} onClick={() => pick?.(DEMO)}>
                <td />
                <td className="cl-path">
                  <button className="cl-name" role="tab" aria-selected={current === DEMO}>
                    {t.files.demo[demo!]}
                  </button>
                </td>
                <td />
                <td />
              </tr>
            ) : (
              <Line
                key={`${l.kind ?? ''}:${l.from ?? ''}:${l.path}`}
                row={l}
                on={current === l.path}
                onPick={pick && l.file ? (changes) => pick(l.path, changes) : undefined}
                onDiff={l.added || l.removed ? () => setOpen(l.path) : undefined}
                tabs={!!pick}
              />
            ),
          )}
        </tbody>
      </table>
      {(toggle || total) && (
        <div className="cl-foot">
          {toggle && (
            <button className="link cl-more" aria-expanded={more} onClick={() => setMore(!more)}>
              {more ? `${t.files.less} ▴` : `${counted ? t.files.changed(hidden) : t.files.more(hidden)} ▾`}
            </button>
          )}
          {toggle && total && ' · '}
          {total && (
            <button className="link diff-size" title={t.diff.show} onClick={() => setWhole(true)}>
              <Lines n={total} />
              {!counted && ` ${t.diff.size(total.files)}`}
            </button>
          )}
        </div>
      )}
      {open !== null && <DiffView item={item} file={open} onClose={() => setOpen(null)} onRead={() => {}} />}
      {whole && <DiffView item={item} onClose={() => setWhole(false)} onRead={() => {}} />}
    </div>
  );
}

/** A line of the change list: a file to pick (`onPick`, `tabs`), or one whose diff a click shows (`onDiff`), or neither. */
function Line({ row, on, onPick, onDiff, tabs }: { row: ChangeRow; on: boolean; onPick?: (changes?: boolean) => void; onDiff?: () => void; tabs: boolean }) {
  const name = (p: string) => (row.dir ? `${p}/` : p);
  const path = row.from ? `${name(row.from)} → ${name(row.path)}` : name(row.path);
  // a file the column cannot show is greyed: its name opens nothing, its lines its diff
  const byName = tabs ? onPick : onDiff;
  const lines = row.added !== undefined && (row.added > 0 || row.removed! > 0);
  const onLines = onPick ? () => onPick(row.file?.diff ? true : undefined) : onDiff;
  const count = (text: string) =>
    onLines ? (
      <button className="link cl-lines" title={onPick ? t.files.showChanges : t.diff.showFile} onClick={(e) => (e.stopPropagation(), onLines())}>
        {text}
      </button>
    ) : (
      text
    );
  const note = row.caption || row.changed || (row.undo && row.undo !== 'yes');
  return (
    <tr className={['cl-row', on && 'on', tabs && !onPick && 'off'].filter(Boolean).join(' ')} onClick={onPick && (() => onPick())}>
      <td className="f-mark" aria-label={row.kind}>
        {row.kind && MARK[row.kind]}
      </td>
      <td className="cl-path">
        {byName ? (
          <button className="cl-name" role={tabs ? 'tab' : undefined} aria-selected={tabs ? on : undefined} title={tabs ? path : `${path}\n${t.diff.showFile}`} onClick={(e) => (e.stopPropagation(), byName())}>
            <bdi>{path}</bdi>
          </button>
        ) : (
          <span className="cl-name" title={path}>
            <bdi>{path}</bdi>
          </span>
        )}
        {note && (
          <div className="cl-note">
            {row.caption}
            <ChangeNote c={row} />
          </div>
        )}
      </td>
      <td className="d-add">{lines && count(`+${row.added}`)}</td>
      <td className="d-del">{lines && count(`−${row.removed}`)}</td>
    </tr>
  );
}

/** Whether enough of `el` is in sight to be seen, not only a strip of its top: in the window, scrolled into view and not under the card's buttons. */
function seen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(200, r.height / 2));
  return !!at && el.contains(at);
}

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A short mark of `s` for an address and a key, which changes when `s` does. */
function revision(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * One file of the card's work (its path and caption stand in its line of the change list): how it is shown (a changed one its changes
 * first, the file as it is a click away), and the ways to the file itself.
 */
function FileView({ item, file, rev, changes, onChanges }: { item: Item; file: ShownFile; rev: string; changes: boolean; onChanges: (changes: boolean) => void }) {
  const [note, setNote] = useState('');
  const url = `${cardFile(item.id, file.path)}?v=${rev}`;
  const open = (show: boolean) => {
    setNote('');
    api.openCardFile(item.id, file.path, show).catch(() => {
      // from another device, or where the system has no app for it: the browser saves it instead
      if (show) setNote(t.files.notHere);
      else location.assign(cardFile(item.id, file.path, true));
    });
  };
  return (
    <div className="r-file">
      <div className="r-bar">
        {file.diff && (
          <span className="r-mode" role="group">
            <button className={changes ? '' : 'on'} aria-pressed={!changes} onClick={() => onChanges(false)}>
              {file.kind === 'markdown' || file.kind === 'page' ? t.files.formatted : t.files.whole}
            </button>
            <button className={changes ? 'on' : ''} aria-pressed={changes} onClick={() => onChanges(true)}>
              {t.files.changes}
            </button>
          </span>
        )}
        <span className="r-ways">
          <button className="link" title={t.files.openHint} onClick={() => open(false)}>
            {t.files.open}
          </button>
          {' · '}
          <button className="link" title={t.files.showHint} onClick={() => open(true)}>
            {t.files.show}
          </button>
          {' · '}
          <a className="link" href={cardFile(item.id, file.path, true)} title={t.files.download} aria-label={t.files.download}>
            ↓
          </a>
        </span>
      </div>
      {note && <p className="hint">{note}</p>}
      {changes ? <Changes item={item} path={file.path} /> : <Shown item={item} file={file} url={url} rev={rev} onOpen={() => open(false)} />}
    </div>
  );
}

/** The file as it is, shown by its kind. */
function Shown({ item, file, url, rev, onOpen }: { item: Item; file: ShownFile; url: string; rev: string; onOpen: () => void }) {
  switch (file.kind) {
    case 'markdown':
      return (
        <Text url={url}>
          {(md) => (
            // its images from beside it, as far as the card serves them
            <DocImages.Provider value={(src) => (imageAt(file.path, src) ? `${cardFile(item.id, imageAt(file.path, src)!)}?v=${rev}` : null)}>
              <div className="r-doc">
                <Doc md={md} />
              </div>
            </DocImages.Provider>
          )}
        </Text>
      );
    case 'text':
      return <Text url={url}>{(text) => <pre className="r-text">{text}</pre>}</Text>;
    case 'image':
      return (
        <a href={url} target="_blank" rel="noreferrer">
          <img className="r-image" src={url} alt={file.caption || file.path} />
        </a>
      );
    case 'page':
      return <Page url={url} title={file.caption || file.path} />;
    case 'pdf':
      return <Pdf url={url} title={file.caption || file.path} />;
    case 'other':
      return (
        <div className="r-tile">
          <span className="r-tile-name">{base(file.path)}</span>
          <span className="hint">{t.files.other}</span>
          <button className="btn" title={t.files.openHint} onClick={onOpen}>
            {t.files.open}
          </button>
        </div>
      );
  }
}

/** A text file's content, to show as `children` makes it; past `TEXT_CAP`, its start. */
function Text({ url, children }: { url: string; children: (text: string) => ReactNode }) {
  const [text, setText] = useState<string | null | 'failed'>(null);
  useEffect(() => {
    let gone = false;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(
        (s) => !gone && setText(s),
        () => !gone && setText('failed'),
      );
    return () => {
      gone = true;
    };
  }, [url]);
  if (text === null) return <p className="hint">{t.files.loading}</p>;
  if (text === 'failed') return <p className="hint">{t.files.failed}</p>;
  const cut = text.length > TEXT_CAP;
  return (
    <>
      {children(cut ? text.slice(0, TEXT_CAP) : text)}
      {cut && <p className="hint">{t.files.cut(Math.round(TEXT_CAP / 1000))}</p>}
    </>
  );
}

/** A page in the sandboxed frame of an HTML artifact, its scripts away from Obeya's API, as high as it reports. */
function Page({ url, title }: { url: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const height = useReportedHeight(frame, PAGE_CAP);
  return <iframe ref={frame} className="r-page" sandbox="allow-scripts" src={url} title={title} style={height ? { height } : undefined} />;
}

/**
 * A PDF in the browser's viewer, which shows nothing in a sandboxed frame: the file comes as a PDF
 * and nothing else. As high as the column shows, so that scrolled to it, the viewer's own scrollbar
 * is the only one. On a phone, and where the browser has no viewer, pdf.js draws its pages instead.
 */
function Pdf({ url, title }: { url: string; title: string }) {
  if (phoneView() || navigator.pdfViewerEnabled === false)
    return <PdfPages url={url} title={title} />;
  return <PdfFrame url={url} title={title} />;
}

function PdfFrame({ url, title }: { url: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const column = frame.current?.closest('.split-main');
    if (!column) return;
    const fit = () => setHeight(Math.max(360, column.clientHeight - 8));
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(column);
    return () => watch.disconnect();
  }, []);
  return <iframe ref={frame} className="r-pdf" src={url} title={title} style={height ? { height } : undefined} />;
}

/** What the card changed in the file, line by line. */
function Changes({ item, path }: { item: Item; path: string }) {
  const [diff, setDiff] = useState<CardDiff | null | 'failed'>(null);
  useEffect(() => {
    let gone = false;
    api.diff(item.id, true).then(
      (d) => !gone && setDiff(d ?? 'failed'),
      () => !gone && setDiff('failed'),
    );
    return () => {
      gone = true;
    };
  }, [item.id]);
  if (diff === null) return <p className="hint">{t.files.loading}</p>;
  const part = diff === 'failed' ? undefined : splitDiff(diff.patch ?? '').find((p) => p.file === path);
  return part ? (
    <div className="r-diff">
      <FileDiff part={part} />
    </div>
  ) : (
    <p className="hint">{t.files.noDiff}</p>
  );
}
