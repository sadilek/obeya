// The archive: finished cards and dropped ideas taken off the canvas and projects whose plan doc is
// gone, the most recently archived first. A project's workstreams belong to it and are not listed on their own.

import type { Item } from '../core/types';
import { plain } from './markdown';
import { stateLabel, t } from './strings';

interface Props {
  on: boolean;
  /** The archive as the server sends it, newest first; a project is followed by its workstreams. */
  archived: Item[];
  /** Finished cards of the owner's still on the canvas. */
  done: number;
  onOpen: (i: Item) => void;
  onArchiveDone: () => void;
  /** Where an archived card unfolds from and folds back to. */
  els: Map<string, HTMLElement>;
}

export function ArchiveSheet({ on, archived, done, onOpen, onArchiveDone, els }: Props) {
  // one heading per day, in the server's order
  const days: { day: string; items: Item[] }[] = [];
  for (const i of archived.filter((x) => !x.parent)) {
    const day = t.archive.day(new Date(i.archivedAt!));
    if (days.at(-1)?.day === day) days.at(-1)!.items.push(i);
    else days.push({ day, items: [i] });
  }
  return (
    <aside id="asheet" className={on ? 'sheet on' : 'sheet'}>
      <div className="p-kind">{t.archive.kind}</div>
      <h2>{t.archive.title}</h2>
      {done > 0 && (
        <button className="btn" onClick={onArchiveDone}>
          {t.archive.archiveDone(done)}
        </button>
      )}
      {archived.length === 0 ? (
        <p className="hint">{t.archive.empty}</p>
      ) : (
        <>
          <p className="hint">{t.archive.hint}</p>
          {days.map(({ day, items }) => (
            <section key={day}>
              <h4 className="p-h">{day}</h4>
              <ol className="timeline">
                {items.map((i) => (
                  <li key={i.id}>
                    <time>{t.archive.time(new Date(i.archivedAt!))}</time>
                    <span className="tick" />
                    <button className="a-card" ref={(el) => void (el ? els.set(i.id, el) : els.delete(i.id))} onClick={() => onOpen(i)}>
                      <span className="a-ttl">{plain(i.title)}</span>
                      <span className="hint">
                        {i.idea ? stateLabel(i) : t.kind[i.kind]}
                        {i.kind === 'project' && ` · ${t.archive.workstreams(archived.filter((x) => x.parent === i.id).length)}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </>
      )}
    </aside>
  );
}
