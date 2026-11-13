// What the agents cost, shown only while the owner has turned it on in the settings (off until then):
// beside a card's conversation heading, the card's (a project's with its workstreams'), and in the
// bar, the canvas's, whose list names the cards that cost the most. The server counts the costs
// whether they are shown or not, and tells every page when the owner turns them on or off.

import { useRef, useState, useSyncExternalStore } from 'react';
import type { Item } from '../core/types';
import { money, t } from './strings';
import { useMenuClose } from './menu';
import { signal } from './signal';

let shown = false;
const changed = signal();

/** What the server said of the setting: on connect and whenever the owner changes it. */
export function setCostsShown(on: boolean) {
  if (on === shown) return;
  shown = on;
  changed.emit();
}

/** Whether the page shows what the agents cost. */
export const useCostsShown = () => useSyncExternalStore(changed.on, () => shown);

/** A cost as the page writes it: "≈ $1.23", below a cent "< $0.01". */
export const costLabel = (usd: number) => (usd < 0.005 ? t.costs.under(money(0.01)) : t.costs.about(money(usd)));

/** Beside the card's conversation heading: what its agents cost so far, once they cost anything. */
export function Spent({ item }: { item: Item }) {
  const on = useCostsShown();
  if (!on || !item.spent) return null;
  return (
    <span className="spent" title={item.kind === 'project' ? t.costs.projectHint : t.costs.cardHint}>
      {costLabel(item.spent)}
    </span>
  );
}

/** In a project's sheet, under its plan doc: what its project agent and workstreams cost so far. */
export function ProjectSpent({ item }: { item: Item }) {
  const on = useCostsShown();
  if (!on || !item.spent) return null;
  return (
    <p className="hint p-spent" title={t.costs.projectHint}>
      {t.costs.project(costLabel(item.spent))}
    </p>
  );
}

/** How many of the cards that cost the most the bar's list names. */
const TOP = 5;

/**
 * In the bar: what the canvas's agents cost so far; a click (a tap) lists the cards that cost the
 * most, each opening its card, and says what the figure is.
 */
export function CostsPill({ total, items, onOpen }: { total: number | undefined; items: Item[]; onOpen: (i: Item) => void }) {
  const on = useCostsShown();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useMenuClose(open, ref, () => setOpen(false), true);
  if (!on || !total) return null;
  // a project's figure holds its workstreams', which the list names themselves
  const top = items
    .filter((i) => i.spent && i.kind !== 'project')
    .sort((a, b) => b.spent! - a.spent!)
    .slice(0, TOP);
  return (
    <div ref={ref} className={['pill costs', open && 'open'].filter(Boolean).join(' ')}>
      <button className="face" aria-expanded={open} title={t.costs.title} onClick={() => setOpen(!open)}>
        {costLabel(total)}
      </button>
      <div className="tip" role="tooltip">
        <p>
          <b>{t.costs.canvas(costLabel(total))}</b>
        </p>
        {top.length > 0 && (
          <>
            <p className="hint">{t.costs.most}</p>
            <ul className="costs-list">
              {top.map((i) => (
                <li key={i.id}>
                  <button
                    className="link"
                    onClick={() => {
                      setOpen(false);
                      onOpen(i);
                    }}
                  >
                    {i.title}
                  </button>
                  <b>{costLabel(i.spent!)}</b>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="hint">{t.costs.canvasHint}</p>
      </div>
    </div>
  );
}
