// The repository a card is built in, picked before work on it begins: one of the canvas's, or a
// new one Obeya creates for it (its folder, and whether it gets a canvas of its own). Built once
// for every kind of card that has a task before it starts (a planned task, an idea); the button
// that starts or builds the card names a new one, so what the click does is clear before it.

import { useEffect, useRef, useState } from 'react';
import { type CardPatch, type Item, type RepoRef } from '../core/types';
import { t } from './strings';

/** A new repository as the owner picks it on the card. */
export interface FreshRepo {
  path: string;
  canvas: boolean;
}

export interface RepoChoice {
  repo: string;
  fresh: FreshRepo | null;
  /** Its name, from the folder; empty while no folder is named. */
  name: string;
  pickRepo: (id: string) => void;
  pickNew: (start: string) => void;
  setFresh: (f: FreshRepo) => void;
}

/**
 * The pick on the open card, saved as the owner makes it (`onEdit`), so it survives closing the
 * card and a reload like anything else entered on it. A pick the idea's agent makes meanwhile
 * shows, unless the owner has changed it on the card since it opened.
 */
export function useRepoChoice(item: Item, onEdit: (p: CardPatch) => void): RepoChoice {
  const saved: FreshRepo | null = item.newRepo ? { path: item.newRepo.path, canvas: item.newRepo.canvas } : null;
  const [repo, setRepo] = useState(item.repo);
  const [fresh, setFreshState] = useState(saved);
  // what the owner picked here and the server does not have yet: until it does, the card keeps showing it
  const mine = useRef<string | null>(null);
  const key = (r: string, f: FreshRepo | null) => JSON.stringify([r, f?.path.trim() ?? null, f?.canvas ?? null]);
  const stored = key(item.repo, saved);
  useEffect(() => {
    if (mine.current !== null && mine.current !== stored) return;
    mine.current = null;
    setRepo(item.repo);
    setFreshState(saved);
  }, [stored]);
  const setFresh = (f: FreshRepo) => {
    mine.current = key(repo, f);
    setFreshState(f);
    onEdit({ newRepo: f });
  };
  return {
    repo,
    fresh,
    name: fresh ? newRepoName(fresh.path) : '',
    pickRepo: (id) => {
      mine.current = key(id, null);
      setRepo(id);
      setFreshState(null);
      onEdit({ repo: id, newRepo: null });
    },
    pickNew: (start) => setFresh(fresh ?? { path: start, canvas: true }),
    setFresh,
  };
}

/** The name a new repository's folder gives it (and its canvas): the last part of its path. */
export const newRepoName = (path: string) => path.trim().replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) ?? '';

/** Where a new repository's folder starts out: beside the canvas's first repository. */
const besideHome = (repos: RepoRef[]) => repos[0]?.path.replace(/[/\\][^/\\]+[/\\]?$/, '/') ?? '';

/**
 * The picker: the canvas's repositories and "New repository …", which once picked shows its
 * folder and "own canvas". It stays out of the way: shown on a canvas with several
 * repositories, and where a new one is picked already (by the idea's agent, or the owner's words to
 * Obeya); a card of a canvas with one repository and no new one shows none. `fresh`: a new
 * repository may be picked (not on a proposal, whose acceptance starts it where it is).
 */
export function RepoPick({ choice, repos, fresh = true }: { choice: RepoChoice; repos: RepoRef[]; fresh?: boolean }) {
  const pathRef = useRef<HTMLInputElement>(null);
  const [focusPath, setFocusPath] = useState(false);
  useEffect(() => {
    const el = pathRef.current;
    if (!focusPath || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    setFocusPath(false);
  }, [focusPath]);
  const n = choice.fresh;
  if (repos.length < 2 && !n) return null;
  return (
    <div className="repo-pick">
      <div className="seg">
        {repos.map((r) => (
          <button key={r.id} className={!n && r.id === choice.repo ? 'on' : ''} onClick={() => choice.pickRepo(r.id)}>
            {r.name}
          </button>
        ))}
        {fresh && (
          <button
            className={n ? 'on' : ''}
            title={t.repoPick.newRepoHint}
            onClick={() => {
              choice.pickNew(besideHome(repos));
              setFocusPath(true);
            }}
          >
            {n && choice.name ? t.repoPick.named(choice.name) : t.repoPick.newRepo}
          </button>
        )}
      </div>
      {n && (
        <div className="repo-new">
          <input
            ref={pathRef}
            className="repo-path"
            aria-label={t.repoPick.path}
            value={n.path}
            placeholder={t.repoPick.pathPlaceholder}
            spellCheck={false}
            maxLength={1000}
            onChange={(e) => choice.setFresh({ ...n, path: e.target.value })}
          />
          <label className="repo-canvas" title={t.repoPick.ownCanvasHint}>
            <input type="checkbox" checked={n.canvas} onChange={(e) => choice.setFresh({ ...n, canvas: e.target.checked })} />
            {t.repoPick.ownCanvas}
          </label>
        </div>
      )}
    </div>
  );
}

/** What the start or build button says of a new repository, and the line under it; nothing without one. */
export function newRepoWords(choice: RepoChoice, idea: boolean): { button: string; hint: string; ready: boolean } | null {
  const n = choice.fresh;
  if (!n) return null;
  const path = n.path.trim();
  if (!path || !choice.name) return { button: idea ? t.idea.build : t.start, hint: t.repoPick.noPath, ready: false };
  return {
    button: idea ? t.repoPick.build(choice.name) : t.repoPick.start(choice.name),
    hint: n.canvas ? t.repoPick.willMove(path, choice.name, idea) : t.repoPick.willJoin(path),
    ready: true,
  };
}
