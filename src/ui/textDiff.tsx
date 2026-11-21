// Two versions of a text as a diff the owner reads at a glance: gone lines red, new ones green, the
// words that differ between two similar lines marked, and unchanged stretches far from a change
// folded into a row that unfolds with a click.

import { useMemo, useState } from 'react';
import { type DiffRow, foldUnchanged, type TextLine, textDiff } from '../core/diff';
import { t } from './strings';

export function TextDiff({ before, after, context = 3 }: { before: string[]; after: string[]; context?: number }) {
  const key = JSON.stringify([before, after, context]);
  const rows = useMemo(() => foldUnchanged(textDiff(before, after), context), [key]);
  // the folds unfolded, for the diff they were unfolded in (an edit makes another one)
  const [open, setOpen] = useState<{ key: string; rows: Set<number> }>({ key, rows: new Set() });
  const unfolded = open.key === key ? open.rows : new Set<number>();
  return (
    <div className="d-lines t-diff">
      {rows.flatMap((r: DiffRow, i) =>
        'line' in r ? (
          <Line key={i} line={r.line} />
        ) : unfolded.has(i) ? (
          r.folded.map((line, k) => <Line key={`${i}.${k}`} line={line} />)
        ) : (
          <button key={i} className="d-fold" title={t.diff.unfold} onClick={() => setOpen({ key, rows: new Set([...unfolded, i]) })}>
            <span className="d-no">⋯</span>
            <span className="d-text">{t.diff.unchanged(r.folded.length)}</span>
          </button>
        ),
      )}
    </div>
  );
}

function Line({ line }: { line: TextLine }) {
  return (
    <div className={line.kind === '+' ? 'd-add' : line.kind === '-' ? 'd-del' : undefined}>
      <span className="d-no">{line.kind === ' ' ? '' : line.kind === '+' ? '+' : '−'}</span>
      <span className="d-text">{line.parts ? line.parts.map((p, i) => (p.changed ? <mark key={i}>{p.text}</mark> : p.text)) : line.line}</span>
    </div>
  );
}
