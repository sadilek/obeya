// What changed on shared demo pages since some of them were shared (src/core/page-changes.ts):
// on a card's shared page (or that its repository's theme changed), and in the Koordinator's notice of outdated pages, with how many lack each.

import { type OutdatedBy, PAGE_CHANGES, THEME_CHANGED } from '../core/page-changes';
import { shortDay, t } from './strings';

export function PageChangeList({ changes }: { changes: { id: OutdatedBy; pages?: number }[] }) {
  return (
    <ul className="page-changes">
      {changes.map(({ id, pages }) => {
        const kinds = PAGE_CHANGES.find((c) => c.id === id)?.kinds ?? [];
        return (
          <li key={id}>
            {/* a change of the repository's theme has no day of Obeya's */}
            <span className="when">{id === THEME_CHANGED ? '' : shortDay(`${id.slice(0, 10)}T12:00`)}</span>
            <span>
              {kinds.length === 1 && <b>{t.pageChanges.only[kinds[0]!]}: </b>}
              {t.pageChanges.text[id]}
              {pages !== undefined && <span className="count"> ({t.pageChanges.pages(pages)})</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
