// Every UI string. German first; an English table follows the same shape.

import type { CardState, Need } from '../core/types';

export const t = {
  kind: { feature: 'Feature', bugfix: 'Bugfix', project: 'Projekt', workstream: 'Workstream' },
  state: {
    proposal: 'Vorschlag eines Agenten',
    planned: 'Geplant',
    working: 'Agent arbeitet',
    waiting: 'Wartet auf dich',
    approved: 'Freigegeben',
    inPr: 'Im PR',
    live: 'Live',
  } satisfies Record<CardState, string>,
  need: { demo: 'Demo bereit', question: 'Frage an dich' } satisfies Record<Need, string>,
  proposalMark: '✦ Vorschlag · ',
  progress: (live: number, all: number) => `${live} von ${all} live`,
  needsYou: 'brauchen dich',
  newCard: 'Neue Karte',
  keys: 'Ziehen: verschieben · ⌘ + Scrollen / Pinch: Zoom · 0: Übersicht · Doppelklick: neue Karte',
  close: 'Schließen (Esc)',
  planSheet: 'Projekt · Plan',
  fromPlan: 'Aus dem Plan-Dokument; geändert wird es dort:',
  titlePlaceholder: 'Worum geht es?',
  bodyPlaceholder: 'Beschreibung',
  delete: 'Löschen',
  deleted: (title: string) => `Karte „${title}“ gelöscht.`,
  undo: 'Rückgängig',
  offline: 'Keine Verbindung zum Server',
  empty: 'Noch keine Karten. Doppelklick auf die Fläche legt eine an.',
};

export const stateLabel = (i: { state: CardState; need?: Need }) => (i.state === 'waiting' && i.need ? t.need[i.need] : t.state[i.state]);
