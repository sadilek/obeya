// What a card changed in a folder without git: the line in place of its branch, the list above its
// conversation where no files show beside it, and "Discard changes", with a moment to take
// that back before it happens.

import { useEffect, useState } from 'react';
import { type CardDiff, diffSize, shownChanges } from '../core/diff';
import { changeRows } from '../core/files';
import type { CardAction, Item } from '../core/types';
import type { ActDone } from './cardSheet';
import { CopyPath, DiffView, Lines } from './diff';
import { atWork, ChangeList } from './files';
import { t } from './strings';

/** How long "Discard changes" waits for a second click that calls it off before it goes ahead: putting the files back cannot be taken back. */
const DISCARD_WAIT_S = 8;

/** Which undo the card has, with what it means on hover. */
function UndoKind({ undo }: { undo: 'full' | 'partial' }) {
  return (
    <span className={`f-undo ${undo}`} title={t.folder.undoHint[undo]}>
      {t.folder.undo[undo]}
    </span>
  );
}

/**
 * The card's line in place of a branch: how much it changed in the folder, its undo, the folder's
 * path to copy. `sizeBelow`: the card's change list shows how much instead.
 */
export function FolderLine({ item, diff, sizeBelow }: { item: Item; diff: CardDiff | null; sizeBelow?: boolean }) {
  const [open, setOpen] = useState(false);
  const changes = diff?.folder?.changes ?? [];
  const size = diff && diffSize(diff.files);
  const below = sizeBelow && !!changes.length;
  return (
    <>
      {t.folder.changed}
      {diff && (
        <>
          {below ? null : ': '}
          {below ? null : changes.length ? (
            <button className="link diff-size" title={t.diff.show} onClick={() => setOpen(true)}>
              {t.folder.files(shownChanges(changes).length)}
              {size && (size.added || size.removed) ? (
                <>
                  {' '}
                  <Lines n={size} />
                </>
              ) : null}
            </button>
          ) : (
            t.folder.none
          )}
          {diff.folder?.undo && (
            <>
              {' · '}
              <UndoKind undo={diff.folder.undo} />
            </>
          )}
        </>
      )}
      {item.workspace && (
        <>
          {' · '}
          <CopyPath path={item.workspace} />
        </>
      )}
      {open && <DiffView item={item} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * What the card changed in the folder, above its conversation where it shows no files beside it
 * (before its first handover, say): the change list, a click on a file's name or lines opening its diff.
 */
export function FolderBox({ item, diff }: { item: Item; diff: CardDiff | null }) {
  const rows = changeRows(diff);
  if (!rows.length) return null;
  return (
    <div className="f-box">
      <b>{t.folder.changed}</b>
      <ChangeList item={item} rows={rows} fold={atWork(item)} />
    </div>
  );
}

/**
 * "Discard changes" on a card waiting for approval: puts back what it changed in the folder.
 * That cannot be taken back once done, so the button first counts down, and a second click on it (or its ×) calls it off.
 */
export function DiscardChanges({ diff, act, onDone }: { diff: CardDiff | null; act: (a: CardAction, done: ActDone) => Promise<void>; onDone: () => void }) {
  const [left, setLeft] = useState<number | null>(null);
  const undoable = (diff?.folder?.changes ?? []).filter((c) => c.undo === 'yes').length;
  useEffect(() => {
    if (left === null) return;
    if (left === 0) {
      setLeft(null);
      void act({ action: 'undo' }, { close: false }).then(onDone);
      return;
    }
    const h = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(h);
  }, [left]);
  if (!undoable && left === null) return null;
  // the button stays itself while it counts down: a second click on it, or its ×, calls it off
  const counting = left !== null;
  return (
    <>
      <button
        className={counting ? 'btn f-discard counting' : 'btn f-discard'}
        title={counting ? t.folder.cancelHint : t.folder.discardHint(undoable)}
        onClick={() => setLeft(counting ? null : DISCARD_WAIT_S)}
      >
        {t.folder.discard}
        {counting && (
          <>
            <span className="f-count">{t.folder.seconds(left)}</span>
            <span className="f-cancel" aria-label={t.cancel}>
              ×
            </span>
          </>
        )}
      </button>
      {counting && <span className="f-discarding">{t.folder.clickToCancel}</span>}
    </>
  );
}
