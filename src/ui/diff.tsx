// A card's branch, with the size of its change beside it: a click shows the whole diff over the
// page. Where the branch is checked out is copied with another click, and the app running there
// opens with a third. All stay quiet: the owner rarely reads the code or tries the app by hand.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { type CardDiff, type DiffPart, diffSize, type FolderChange, shownChanges, splitDiff } from '../core/diff';
import type { Item } from '../core/types';
import { api } from './api';
import { useCopy } from './copy';
import { plain } from './markdown';
import { t } from './strings';

/** A file with more lines than this starts folded, so a generated file does not bury the rest. */
const FOLD_LINES = 1500;

/**
 * The branch line of a card: its name, the size of its change, its directory to copy, and its
 * running app to open. `sizeBelow`: the card's change list shows the size instead.
 */
export function Branch({ item, sizeBelow }: { item: Item; sizeBelow?: boolean }) {
  const [diff, setDiff] = useState<CardDiff | null>(null);
  const [open, setOpen] = useState(false);
  // read again when the work moves on; the line keeps the last size meanwhile
  useEffect(() => {
    let gone = false;
    api.diff(item.id).then((d) => !gone && setDiff(d), () => {});
    return () => {
      gone = true;
    };
  }, [item.id, item.state, item.need, item.statusLine, item.workspace, item.summary]);
  // until the change is read, its size as last read: the line keeps its length, and what is under it its place
  const size = diff ? { ...diffSize(diff.files), files: diff.files.length } : item.changeSize;
  return (
    <>
      {t.branch} <code>{item.branch}</code>
      {size && !(sizeBelow && size.files) && (
        <>
          {' · '}
          {size.files ? (
            <button className="link diff-size" title={t.diff.show} onClick={() => setOpen(true)}>
              <Lines n={size} /> {t.diff.size(size.files)}
            </button>
          ) : (
            t.diff.none
          )}
        </>
      )}
      {item.workspace && (
        <>
          {' · '}
          <CopyPath path={item.workspace} />
        </>
      )}
      <AppLink item={item} />
      {open && <DiffView item={item} onClose={() => setOpen(false)} onRead={setDiff} />}
    </>
  );
}

/** How often an open card looks whether its app answers, while its worker says it runs. */
const APP_LOOK_MS = 10_000;

/**
 * The app running in the card's workspace, while it answers: a link beside the workspace's path for
 * the owner to try it by hand, opened through Obeya, which keeps it running a while after.
 */
function AppLink({ item }: { item: Item }) {
  // null until the first look has answered: the link holds its place meanwhile, unseen, so the line does not grow when it shows
  const [up, setUp] = useState<boolean | null>(null);
  useEffect(() => {
    setUp(null);
    if (!item.app) return;
    let alive = true;
    const look = () => api.appUp(item.id).then((u) => alive && setUp(u), () => alive && setUp((u) => u ?? false));
    void look();
    const timer = setInterval(look, APP_LOOK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [item.id, item.app]);
  if (!item.app || up === false) return null;
  let where = item.app;
  try {
    where = new URL(item.app).host;
  } catch {}
  // on another machine, reached here through a forward of that port
  const host = /^([^/:\\]{2,}):\//.exec(item.workspace ?? '')?.[1];
  if (host) where = `${host}, ${where}`;
  return (
    <span style={up ? undefined : { visibility: 'hidden' }} aria-hidden={up ? undefined : true}>
      {' · '}
      <a className="app-link" href={api.appOpen(item.id)} target="_blank" rel="noreferrer" title={t.app.hint(where)} tabIndex={up ? undefined : -1}>
        {t.app.open} ↗
      </a>
    </span>
  );
}

function CopyPath({ path }: { path: string }) {
  const [copied, copy] = useCopy(3000);
  return (
    <button className={copied ? 'link copied' : 'link'} title={path} onClick={() => copy(path)}>
      {copied ? t.diff.copied : t.diff.copyPath}
    </button>
  );
}

/**
 * The whole diff over the page, file by file; Esc, the × or a click beside it closes it. In a folder
 * without git, the card's change list and its text files' diffs. Opened on one `file`, it shows only
 * that file's diff, with a link to the whole.
 */
export function DiffView({ item, file, onClose, onRead }: { item: Item; file?: string; onClose: () => void; onRead: (d: CardDiff) => void }) {
  const [diff, setDiff] = useState<CardDiff | null | 'failed'>(null);
  const [only, setOnly] = useState(file);
  useEffect(() => {
    let gone = false;
    api.diff(item.id, true).then(
      (d) => {
        if (gone) return;
        setDiff(d ?? 'failed');
        if (d) onRead(d);
      },
      () => !gone && setDiff('failed'),
    );
    return () => {
      gone = true;
    };
  }, [item.id]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, [onClose]);
  const got = diff === 'failed' ? null : diff;
  const folder = got?.folder;
  // in a folder, only text files whose earlier version Obeya kept have lines to show
  const all = got ? splitDiff(got.patch ?? '').filter((p) => !folder || p.lines.some((l) => l.startsWith('@@'))) : [];
  // one file's diff while it is there; a file without one (cut off, say) shows the whole
  const one = only ? all.find((p) => p.file === only) : undefined;
  const parts = one ? [one] : all;
  // one file's size stands in its own header
  const size = !one && got && diffSize(got.files);
  const go = (file: string) => document.getElementById(anchor(file))?.scrollIntoView({ block: 'start' });
  return createPortal(
    <div className="diff-view" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="d-sheet">
        <div className="d-head">
          <h2>{t.diff.title(plain(item.title))}</h2>
          <span className="hint">
            {got?.source === 'folder' ? t.folder.changed : <code>{item.branch}</code>}
            {folder?.undo && ` · ${t.folder.undo[folder.undo]}`}
            {got?.source === 'landed' && ` · ${t.diff.landed}`}
            {size && (
              <>
                {' · '}
                <Lines n={size} />
              </>
            )}
            {one && (
              <>
                {' · '}
                <button className="link" onClick={() => setOnly(undefined)}>
                  {t.diff.show}
                </button>
              </>
            )}
          </span>
          <button className="d-close" title={t.diff.close} onClick={onClose}>
            ×
          </button>
        </div>
        <div className="d-body">
          {diff === null && <p className="hint">{t.diff.loading}</p>}
          {diff === 'failed' && <p className="hint">{t.diff.failed}</p>}
          {folder && !one && folder.undo && <p className="hint">{t.folder.undoHint[folder.undo]}</p>}
          {folder && !one && <ChangeTable changes={shownChanges(folder.changes)} diffed={(c) => all.some((p) => p.file === c.path)} onFile={go} />}
          {got && (
            <>
              {!folder && !one && <table className="d-files">
                <tbody>
                  {got.files.map((f) => (
                    <tr key={f.file}>
                      <td>
                        <button className="link" onClick={() => go(f.file)}>
                          {f.file}
                        </button>{' '}
                        <span className="hint">{t.diff.status[f.status]}</span>
                      </td>
                      <td className="d-add">{f.binary ? '' : `+${f.added}`}</td>
                      <td className="d-del">{f.binary ? '' : `−${f.removed}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>}
              {parts.map((p) => (
                <FileDiff key={p.file} part={p} />
              ))}
              {got.truncated && <p className="hint d-cut">{t.diff.truncated}</p>}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const anchor = (file: string) => `diff-${file}`;

/** Lines added and removed, green and red. */
export function Lines({ n }: { n: { added: number; removed: number } }) {
  return (
    <>
      <span className="d-add">+{n.added}</span> <span className="d-del">−{n.removed}</span>
    </>
  );
}

export function FileDiff({ part }: { part: DiffPart }) {
  const lines = numbered(part.lines);
  const [folded, setFolded] = useState(lines.length > FOLD_LINES);
  return (
    <section className="d-file" id={anchor(part.file)}>
      <h3>
        <span className="d-name">{part.file}</span>
        {part.from && <span className="hint">{t.diff.renamedFrom(part.from)}</span>}
        <span className="hint">{t.diff.status[part.status]}</span>
        {!part.binary && (
          <span>
            <Lines n={part} />
          </span>
        )}
      </h3>
      {part.binary ? (
        <p className="hint">{t.diff.binary}</p>
      ) : folded ? (
        <p className="hint">
          {t.diff.big(lines.length)}{' '}
          <button className="link" onClick={() => setFolded(false)}>
            {t.diff.unfold}
          </button>
        </p>
      ) : (
        <pre className="d-lines">
          {lines.map((l, i) => (
            <div key={i} className={`d-${l.kind}`}>
              <span className="d-no">{l.old ?? ''}</span>
              <span className="d-no">{l.new ?? ''}</span>
              <span className="d-text">{l.text}</span>
            </div>
          ))}
        </pre>
      )}
    </section>
  );
}

interface Line {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note';
  text: string;
  old?: number;
  new?: number;
}

/** A file's hunks with the line numbers before and after; its header lines (names, modes, index) are left out. */
export function numbered(lines: string[]): Line[] {
  const out: Line[] = [];
  let old = 0;
  let now = 0;
  let inHunks = false;
  for (const text of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      [old, now, inHunks] = [Number(hunk[1]), Number(hunk[2]), true];
      out.push({ kind: 'hunk', text });
    } else if (!inHunks) continue;
    else if (text.startsWith('+')) out.push({ kind: 'add', text, new: now++ });
    else if (text.startsWith('-')) out.push({ kind: 'del', text, old: old++ });
    else if (text.startsWith('\\')) out.push({ kind: 'note', text });
    // an empty line of the file is a space; an empty string is what `split` leaves after a last newline
    else if (text) out.push({ kind: 'ctx', text, old: old++, new: now++ });
  }
  return out;
}

/** The sign of what happened to a file: moved, added, changed, deleted. */
export const MARK: Record<FolderChange['kind'], string> = { moved: '↪', added: '＋', modified: '✎', deleted: '✕' };

/** What else the folder's change list says of a file: that the card also changed one it moved, and what discarding would leave. */
export function ChangeNote({ c }: { c: Pick<FolderChange, 'changed' | 'undo'> }) {
  return (
    <>
      {c.changed && <span className="hint"> {t.folder.alsoChanged}</span>}
      {c.undo && c.undo !== 'yes' && (
        <span className="f-left" title={c.undo === 'lost' ? t.folder.lostHint : c.undo === 'shared' ? t.folder.sharedHint : t.folder.changedSinceHint}>
          {' '}
          · {t.folder.state[c.undo]}
        </span>
      )}
    </>
  );
}

/** The folder's changes over its whole diff: what happened to which path, the lines in columns of their own; a path `diffed` names goes to its diff. */
function ChangeTable({ changes, diffed, onFile }: { changes: FolderChange[]; diffed: (c: FolderChange) => boolean; onFile: (path: string) => void }) {
  return (
    <table className="f-list">
      <tbody>
        {changes.map((c) => {
          const name = (p: string) => (c.dir ? `${p}/` : p);
          const path = c.kind === 'moved' ? `${name(c.from!)} → ${name(c.path)}` : name(c.path);
          const lines = c.added !== undefined && (c.added > 0 || c.removed! > 0);
          return (
            <tr key={`${c.kind}:${c.from ?? ''}:${c.path}`}>
              <td className="f-mark" aria-label={c.kind}>
                {MARK[c.kind]}
              </td>
              <td className="f-path">
                {diffed(c) ? (
                  <button className="link" title={t.diff.showFile} onClick={() => onFile(c.path)}>
                    {path}
                  </button>
                ) : (
                  path
                )}
                <ChangeNote c={c} />
              </td>
              <td className="d-add">{lines && `+${c.added}`}</td>
              <td className="d-del">{lines && `−${c.removed}`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
