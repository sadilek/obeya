// A card's plan reference (`CardRow.plan_ref`): the plan doc it belongs to, in which repository,
// and for a workstream its key in the doc.

import type { CardRow } from './db';

/**
 * The repository a plan reference belongs to: `<repo>:<path>` for the canvas's other repositories,
 * a bare path for its home repository. The path is in the repository, or an absolute one of a plan
 * folder outside it (`/…`, or `C:/…` on Windows, which is no repository `C`).
 */
export function repoOfRef(ref: string, home: string): string {
  const m = REPO_PREFIX.exec(ref);
  return m ? m[1]! : home;
}

/** The repository a card belongs to, by its id: the one it names, else its plan doc's, else the home repository. */
export const repoOfRow = (r: CardRow, home: string): string => r.repo ?? (r.plan_ref ? repoOfRef(r.plan_ref, home) : home);

/** A plan reference's path, without the repository before it. */
export function pathOfRef(ref: string): string {
  return ref.replace(REPO_PREFIX, '');
}

const REPO_PREFIX = /^(?![A-Za-z]:\/)([\w.-]+):/;
/** A plan reference's path in a plan folder outside the repository: absolute, `/…` or `C:/…`. */
export const OUTSIDE_PATH = /^(\/|[A-Za-z]:\/)/;

/** A workstream's plan reference: its doc's file, then its key (`<doc>#<key>`). A project's is its doc's file alone. */
export const workstreamRef = (file: string, key: string) => `${file}#${key}`;

/** The doc's file of a plan reference, a project's or a workstream's. */
export const docOfRef = (ref: string) => (ref.includes('#') ? ref.slice(0, ref.indexOf('#')) : ref);

/** The workstream key of a plan reference; null for a project's or a card's without one. */
export const keyOfRef = (ref: string | null): string | null => (ref?.includes('#') ? ref.slice(ref.indexOf('#') + 1) : null);

/** Whether a plan reference is to a doc in a plan folder outside the repository. */
export const outsideRef = (ref: string) => OUTSIDE_PATH.test(pathOfRef(ref));
