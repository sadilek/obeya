// The archive: finished cards and dropped ideas taken off the canvas and projects whose plan doc is
// gone, the most recently archived first, listed under the bar's button as the queue is. A project's
// workstreams belong to it and are not listed on their own.

import { type ReactNode, useEffect, useRef } from 'react';
import type { Item } from '../core/types';
import { plain } from './markdown';
import { stateLabel, t } from './strings';

interface Props {
  on: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** A card unfolded from the list is open: the list stays under the dim, for the card to fold back into. */
  held: boolean;
  /** The archive as the server sends it, newest first; a project is followed by its workstreams. */
  archived: Item[];
  /** Finished cards of the owner's still on the canvas. */
  done: number;
  onOpen: (i: Item) => void;
  onArchiveDone: () => void;
  /** Where an archived card unfolds from and folds back to. */
  els: Map<string, HTMLElement>;
  icon: ReactNode;
}

/** The bar's archive button; a click lists the archive under it. A click beside the list or Esc (in App) closes it. */
export function ArchivePill({ on, onToggle, onClose, held, archived, done, onOpen, onArchiveDone, els, icon }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  useEffect(() => {
    if (!on) return;
    const away = (e: PointerEvent) => heldRef.current || box.current?.contains(e.target as Node) || onClose();
    addEventListener('pointerdown', away, true);
    return () => removeEventListener('pointerdown', away, true);
  }, [on]);
  // one heading per day, in the server's order
  const days: { day: string; items: Item[] }[] = [];
  for (const i of archived.filter((x) => !x.parent)) {
    const day = t.archive.day(new Date(i.archivedAt!));
    if (days.at(-1)?.day === day) days.at(-1)!.items.push(i);
    else days.push({ day, items: [i] });
  }
  return (
    <div className="menu-pill" ref={box}>
      <button className={on ? 'pill kpill on' : 'pill kpill'} title={t.archive.title} aria-expanded={on} onClick={onToggle}>
        {icon}
        <span className="lbl">{t.archive.button}</span>
      </button>
      {on && (
        <div id="amenu" className="bar-menu archive-menu">
          {done > 0 && (
            <button className="btn" onClick={onArchiveDone}>
              {t.archive.archiveDone(done)}
            </button>
          )}
          {archived.length === 0 ? (
            <p className="hint">{t.archive.empty}</p>
          ) : (
            days.map(({ day, items }) => (
              <section key={day}>
                <h4>{day}</h4>
                <ol className="timeline">
                  {items.map((i) => (
                    <li key={i.id}>
                      <time>{t.archive.time(new Date(i.archivedAt!))}</time>
                      <span className="tick" />
                      <button className="a-card" ref={(el) => void (el ? els.set(i.id, el) : els.delete(i.id))} onClick={() => onOpen(i)}>
                        <span className="a-ttl">{plain(i.title)}</span>
                        <span className="hint">
                          {i.idea || i.prototypeEnd ? stateLabel(i) : i.becomesProject ? t.kind.becomesProject : t.kind[i.kind]}
                          {i.kind === 'project' && ` · ${t.archive.workstreams(archived.filter((x) => x.parent === i.id).length)}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}
