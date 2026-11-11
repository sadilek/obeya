// The owner's actions on the canvas's cards and projects from their buttons (on the canvas, in a
// project's sheet, in the bar's lists): each tells the server, and the line above the microphone
// confirms it, often with "Undo", or says what went wrong.

import { useMemo } from 'react';
import { EVICT_HOLD_MS, type Item, type PlanDir, START_ALL_HOLD_MS } from '../core/types';
import { api, ApiError, failText } from './api';
import { useLatest } from './latest';
import { plain } from './markdown';
import { forcedText } from './queue';
import { t } from './strings';

interface Host {
  canvasId: string;
  /** The cards on the canvas as the page shows them. */
  items: { readonly current: Item[] };
  /** A project folded or unfolded here, until the server echoes it back (`undefined`: as the server has it). */
  fold: (id: string, collapsed: boolean | undefined) => void;
  /** Closes the project's sheet, where it is open. */
  closeSheet: (p: Item) => Promise<void>;
  showAck: (text: string, undo?: () => unknown, undoMs?: number) => void;
  fail: (e: unknown) => void;
}

/** The actions, each of a fixed identity (memoised cards take them), acting with the host as it is now. */
export function useCanvasActions(host: Host) {
  const now = useLatest(host);
  return useMemo(() => {
    const showAck: Host['showAck'] = (...a) => now.current.showAck(...a);
    const attempt = (fn: () => Promise<unknown>) => fn().then(() => {}, now.current.fail);
    /** Archived: its title confirms it, with a moment to undo. */
    const archived = (i: Item) => showAck(t.archive.archived(plain(i.title)), () => api.unarchive(i.id));
    /**
     * "Give to the waiting card" in the Workspaces list: the card's clone goes to the card waiting
     * longest once the undo window is through; "Undo" (here or in its row) takes that back meanwhile.
     */
    const keepWorkspace = async (i: Item) => {
      try {
        await api.act(i.id, { action: 'keepWorkspace' });
        showAck(t.workspaces.keptBack(plain(i.title)));
      } catch (e) {
        showAck(e instanceof ApiError && e.code === 'notEvictable' ? t.voice.tooLate : failText(e));
      }
    };
    return {
      /** The play button on a card: starts it, or one queued behind others despite the likely conflict. */
      startCard: (i: Item) =>
        attempt(async () => {
          await api.act(i.id, { action: i.queue ? 'force' : 'start' });
          if (i.queue) showAck(forcedText(i.queue));
        }),
      /** The archive button on a finished card or a parked or dropped idea: takes it off the canvas. */
      archiveCard: (i: Item) =>
        attempt(async () => {
          await api.archive(i.id);
          archived(i);
        }),
      /** The archive button of a project whose work is done, on the canvas and in its sheet. */
      archiveProject: (p: Item) =>
        attempt(async () => {
          await api.archive(p.id);
          await now.current.closeSheet(p);
          archived(p);
        }),
      /** "Back to the canvas" in the sheet of an archived project whose work is done. */
      unarchiveProject: (p: Item) =>
        attempt(async () => {
          await api.unarchive(p.id);
          await now.current.closeSheet(p);
          showAck(t.archive.unarchived(plain(p.title)));
        }),
      /** The bar's "Archive finished cards". */
      archiveDone: async () => {
        const { ids } = await api.archiveDone();
        if (ids.length) showAck(t.archive.archivedMany(ids.length), () => Promise.all(ids.map((id) => api.unarchive(id))));
      },
      /**
       * The project's button, on its card and in its sheet: all planned workstreams go to the
       * Coordinator together, which waits a few seconds before it plans them, so the start can be taken back.
       */
      startAll: (p: Item, n: number) =>
        attempt(async () => {
          await api.act(p.id, { action: 'start' });
          const takeBack = async () => {
            try {
              await api.act(p.id, { action: 'dequeue' });
              showAck(t.plan.startTakenBack);
            } catch (e) {
              showAck(e instanceof ApiError && e.code === 'notQueued' ? t.voice.tooLate : t.offlineError);
            }
          };
          showAck(t.plan.startedAll(n), takeBack, START_ALL_HOLD_MS);
        }),
      keepWorkspace,
      /** "Commit to a new branch and free the clone" on a clone uncommitted changes block: it takes effect at once, the leftovers on a branch of their own. */
      keepLeftovers: (repo: string, host: string, path: string) =>
        attempt(async () => {
          showAck(t.workspaces.leftoversKept((await api.keepLeftovers(repo, host, path)).branch));
        }),
      takeWorkspace: (i: Item) =>
        attempt(async () => {
          await api.act(i.id, { action: 'takeWorkspace' });
          showAck(t.workspaces.taken(plain(i.title)), () => keepWorkspace(i), EVICT_HOLD_MS);
        }),
      /**
       * The project's "Arrange", on its card and in its sheet: its workstreams in columns by what builds
       * on what, once Obeya has read that from the plan doc. It takes effect at once; "Undo" puts
       * the cards (and the project, which may have made room for itself) back where they stood.
       */
      arrange: (p: Item) => {
        const before = [p, ...now.current.items.current.filter((i) => i.parent === p.id)].map(({ id, x, y }) => ({ id, x, y }));
        return attempt(async () => {
          await api.act(p.id, { action: 'arrange' });
          showAck(t.plan.arranged, () =>
            attempt(async () => {
              await Promise.all(before.map(({ id, x, y }) => api.patch(id, { x, y })));
              showAck(t.plan.arrangeUndone);
            }),
          );
        });
      },
      /** The fold in a project's head: collapsed, only its head and a mark for each workstream stay on the canvas. */
      collapse: async (p: Item, collapsed: boolean) => {
        now.current.fold(p.id, collapsed);
        try {
          await api.patch(p.id, { collapsed });
        } catch (e) {
          now.current.fold(p.id, undefined);
          now.current.fail(e);
        }
      },
      /** "Prepare as a project" on the note on a plan directory: a card whose agent prepares the doc, started at once. */
      preparePlanDoc: (dir: PlanDir, file: string) =>
        attempt(async () => {
          const card = await api.preparePlanDoc(now.current.canvasId, dir.repo, file);
          showAck(t.planDir.started(plain(card.title)));
        }),
    };
  }, []);
}
