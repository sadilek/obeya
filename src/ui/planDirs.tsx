// The note on a repository's plan directory, beside the projects on the canvas: the docs there
// that are not projects, each with its reason and "Prepare as a project", or, while the
// repository has no plan doc yet, where the first one goes (which the owner can hide).

import { useCallback } from 'react';
import { type Bounds, PLAN_DIR_NOTE_W, planDirNoteBox, planDirNoteHeight, unionBounds } from '../core/layout';
import type { Item, PlanDir } from '../core/types';
import { t } from './strings';
import { useStoredState } from './stored';

/** Between the note and the projects below it. */
const NOTE_GAP = 40;

/**
 * Where each note stands: where the owner put it, else side by side above the top left of the
 * projects (of all cards, while there are none), so that a card started from a note, which goes
 * right of everything, leaves it where it was. One that stands above the projects stands on the
 * bottom of its box, which is as tall as the camera takes it for to keep it in sight.
 */
export function planDirBoxes(dirs: PlanDir[], placed: { item: Item; b: Bounds }[]): Bounds[] {
  const top = placed.filter(({ item }) => !item.parent);
  const projects = top.filter(({ item }) => item.kind === 'project');
  const at = unionBounds((projects.length ? projects : top).map((p) => p.b)) ?? { x: 0, y: 0, w: 0, h: 0 };
  const h = Math.max(...dirs.map(planDirNoteHeight));
  return dirs.map((d, n) => planDirNoteBox(d) ?? { x: at.x + n * (PLAN_DIR_NOTE_W + NOTE_GAP), y: at.y - NOTE_GAP - h, w: PLAN_DIR_NOTE_W, h });
}

/**
 * The empty notes the owner has hidden, per canvas in this browser: a hidden note stays away while
 * its repository has no plan doc; a directory changed in the settings brings it back.
 */
export function useHiddenEmptyNotes(canvas: string): [(d: PlanDir) => boolean, (d: PlanDir) => void] {
  const [ids, setIds] = useStoredState<string[]>(`obeya-plan-dir-hidden-${canvas}`, []);
  const isHidden = useCallback((d: PlanDir) => d.empty && ids.includes(noteId(d)), [ids]);
  const hide = (d: PlanDir) => setIds([...ids, noteId(d)]);
  return [isHidden, hide];
}

const noteId = (d: PlanDir) => `${d.repo}:${d.dir}`;

export function PlanDirNote({
  dir,
  b,
  dragging,
  repo,
  onPrepare,
  onOpen,
  onChange,
  onHide,
}: {
  dir: PlanDir;
  b: Bounds;
  dragging: boolean;
  /** The repository's name, when the canvas has several. */
  repo?: string;
  onPrepare: (dir: PlanDir, file: string) => void;
  onOpen: (cardId: string) => void;
  onChange: () => void;
  onHide: () => void;
}) {
  const where = repo ? `${repo}: ${dir.dir}` : dir.dir;
  const reasons = new Set(dir.others.map((o) => o.reason));
  const one = reasons.size === 1 ? t.planDir.reason[dir.others[0]!.reason] : null;
  return (
    // a press on the note moves it, like a card; one on a button there is no move
    <div
      className={['plan-dir', dir.empty && 'empty-dir', dir.at && 'put', dragging && 'dragging'].filter(Boolean).join(' ')}
      data-repo={dir.repo}
      title={t.planDir.move}
      style={{ left: b.x, top: dir.at ? b.y : b.y + b.h, width: b.w }}
      onPointerDown={(e) => (e.target as Element).closest('button') && e.stopPropagation()}
    >
      {dir.empty ? (
        <p>
          <button className="x" title={t.planDir.hide} aria-label={t.planDir.hide} onClick={onHide}>
            ×
          </button>
          {t.planDir.empty(where)}{' '}
          <button className="link" title={t.planDir.changeHint} onClick={onChange}>
            {t.planDir.change}
          </button>
        </p>
      ) : (
        <>
          <div className="pd-head">{t.planDir.notProjects(where, dir.others.length)}</div>
          {one && <div className="pd-why">{one}</div>}
          {dir.others.map((o) => (
            <div key={o.file} className="pd-doc">
              <span className="pd-file" title={o.file}>
                <span className="pd-name">{o.file.slice(o.file.lastIndexOf('/') + 1)}</span>
                {!one && <span className="pd-why">{t.planDir.reason[o.reason]}</span>}
              </span>
              {o.preparing ? (
                <button className="link" onClick={() => onOpen(o.preparing!)}>
                  {t.planDir.preparing}
                </button>
              ) : (
                <button className="btn small" title={t.planDir.prepareHint} onClick={() => onPrepare(dir, o.file)}>
                  {t.planDir.prepare}
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
