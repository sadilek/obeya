// What taking back the owner's approval of a card would do now (design: Taking back an approval),
// read from its row alone: the card shows it on its button, and `Revocations` does it.

import type { Revocable } from '../core/types';
import type { CardRow } from './db';
import { fromJson } from './row';

/** What taking back the approval of the card in `r` does now (`Item.revocable`); none where nothing can be taken back. */
export function revocable(r: CardRow): Revocable | undefined {
  // a review card's merge is the contributor's pull request; a prototype never lands
  if (r.contribution || r.prototype_of || r.archived_at) return;
  const pr = fromJson(r.pr);
  if (pr?.rollback) return;
  // a fork's work that went to the original as a pull request is public there, and on the main branch too
  if (pr?.upstream || fromJson(r.shipped)?.upstream) return;
  if (r.state === 'working' && r.approved_at && !r.landed) return { how: 'approval' };
  const inPr = r.state === 'inPr' || (r.state === 'waiting' && r.need === 'question' && !!pr);
  if (inPr && !r.landed) {
    // a part merged already is on the default branch: closing the rest would not take it back
    if ([pr, ...(pr?.more ?? [])].some((p) => p?.merged)) return;
    return { how: 'closePr', ...(pr?.url && pr.number ? { pr: pr.number } : {}) };
  }
  if (r.state !== 'live') return;
  const s = fromJson(r.shipped);
  // where the work starts on the default branch is not known (a merge the forge did not name): nothing to revert by
  if (!s?.commit || !s.base) return;
  if (!s.pr) return { how: 'revert' };
  // pull requests in other repositories would need reverting there too
  return pr?.more?.length ? undefined : { how: 'rollbackPr', pr: s.pr.number };
}
