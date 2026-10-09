// One message of a conversation, as cards and the Koordinator's sheet show it alike: who said it
// and when above, the text below as paragraphs and lists.

import type { ReactNode } from 'react';
import { Inline } from './markdown';
import { clock as time } from './strings';

/**
 * A message's frame: `by` places and colours it (the owner's on the right), `who` heads it with its
 * time; `className` adds what kind it is (a question, the agent at work, the starting point).
 */
export function Msg({ by, who, at, className, children }: { by: string; who: ReactNode; at?: string; className?: string; children?: ReactNode }) {
  return (
    <div className={['msg', `by-${by}`, className].filter(Boolean).join(' ')}>
      <div className="who">
        {who}
        {at && <span className="t">{time(at)}</span>}
      </div>
      {children}
    </div>
  );
}

/** Text from a plan doc or an agent: paragraphs, and list items as a checklist. */
export function Body({ md }: { md: string }) {
  const blocks: ({ list: { text: string; mark: string }[] } | { para: string })[] = [];
  for (const line of md.split('\n')) {
    const m = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (m) {
      const last = blocks.at(-1);
      const li = { text: m[2]!, mark: m[1] === undefined ? '' : m[1] === ' ' ? 'open' : 'done' };
      if (last && 'list' in last) last.list.push(li);
      else blocks.push({ list: [li] });
    } else if (line.trim()) blocks.push({ para: line.trim() });
  }
  return (
    <>
      {blocks.map((bl, i) =>
        'para' in bl ? (
          <p key={i} className="p-lead">
            <Inline md={bl.para} />
          </p>
        ) : (
          <ul key={i} className="p-list">
            {bl.list.map((li, j) => (
              <li key={j} className={li.mark}>
                <Inline md={li.text} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}
