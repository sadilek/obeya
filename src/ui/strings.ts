// Every UI string. German first; an English table follows the same shape.

import type { CardState, ErrorCode, Need, Queue } from '../core/types';

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
  need: { demo: 'Demo bereit', question: 'Frage an dich', review: 'Bereit zur Abnahme' } satisfies Record<Need, string>,
  proposalMark: '✦ Vorschlag · ',
  progress: (live: number, all: number) => `${live} von ${all} live`,
  needsYou: 'brauchen dich',
  newCard: 'Neue Karte',
  keys: 'Ziehen: verschieben · ⌘ + Scrollen / Pinch: Zoom · 0: Übersicht · Doppelklick: neue Karte · K: Koordinator',
  close: 'Schließen (Esc)',
  planSheet: 'Projekt · Plan',
  fromPlan: 'Aus dem Plan-Dokument; geändert wird es dort:',
  titlePlaceholder: 'Worum geht es?',
  bodyPlaceholder: 'Beschreibung',
  delete: 'Löschen',
  deleted: (title: string) => `Karte „${title}“ gelöscht.`,
  undo: 'Rückgängig',
  offline: 'Keine Verbindung zum Server',
  start: 'Agent starten',
  stop: 'Anhalten',
  approve: 'Freigeben',
  accept: 'Übernehmen',
  dismiss: 'Verwerfen',
  send: 'Senden',
  compose: {
    working: 'Hinweis an den Agenten – er arbeitet weiter',
    question: 'Eigene Antwort',
    review: 'Feedback – der Agent arbeitet daran weiter',
  },
  questionFromWorker: 'Frage des Agenten',
  summary: 'Zusammenfassung des Agenten',
  proposal: 'Vorschlag',
  proposedBy: (title: string) => `Vorgeschlagen vom Agenten der Karte „${title}“.`,
  task: 'Auftrag',
  log: 'Verlauf',
  logEmpty: 'Noch nichts passiert.',
  lastFailure: (at: string) => `Zuletzt gescheitert (${at})`,
  author: { worker: 'Agent', owner: 'Du', project: 'Projekt-Agent', koordinator: 'Koordinator', obeya: 'Obeya' },
  branch: 'Branch',
  started: (title: string) => `Agent arbeitet an „${title}“.`,
  answered: 'Antwort ist beim Agenten.',
  approved: 'Freigegeben.',
  accepted: 'Vorschlag übernommen und eingeplant.',
  dismissed: 'Vorschlag verworfen.',
  stopped: 'Agent angehalten.',
  queue: {
    checking: 'Koordinator prüft',
    cutting: 'Koordinator teilt auf',
    cuttingLong: 'Der Koordinator schneidet die Karte in Pakete, die parallel laufen können. Sie ersetzen die Karte.',
    waiting: 'In der Warteschlange',
    checkingLong: 'Der Koordinator prüft, ob die Karte mit laufender Arbeit kollidiert.',
    behind: (titles: string[]) => `Wartet auf ${titles.map((x) => `„${x}“`).join(', ')}.`,
    force: 'Trotzdem starten',
    dequeue: 'Aus der Warteschlange nehmen',
    forced: 'Gestartet, trotz Überschneidung.',
    dequeued: 'Aus der Warteschlange genommen.',
  },
  /** Why the server refused an action; `invalid` is also the text for anything unknown. */
  error: {
    unknownCard: 'Diese Karte gibt es nicht mehr.',
    project: 'Ein Projekt wird über seine Workstreams bearbeitet, nicht als Ganzes.',
    notPlanned: 'Nur eine geplante Karte kann gestartet werden.',
    queued: 'Die Karte liegt schon beim Koordinator.',
    notQueued: 'Die Karte wartet nicht in der Warteschlange.',
    notSplittable: 'Aufteilen lässt sich nur eine eigene, geplante Karte, die nicht beim Koordinator liegt.',
    noAgent: 'An dieser Karte arbeitet gerade kein Agent.',
    noQuestion: 'Die Karte hat keine offene Frage mehr.',
    notReady: 'Die Karte ist nicht bereit zur Abnahme.',
    notProposal: 'Die Karte ist kein Vorschlag mehr.',
    planCard: 'Die Karte kommt aus dem Plan-Dokument; geändert wird sie dort.',
    noWorkspace: 'Kein Workspace frei: Alle sind belegt oder es ist keiner eingerichtet.',
    dirtyWorkspaces: 'Kein Workspace frei: Jeder freie hat noch nicht committete Änderungen.',
    workspace: 'Der Workspace für den Agenten ließ sich nicht vorbereiten (git-Fehler).',
    emptyText: 'Bitte zuerst einen Text eingeben.',
    unknownPreference: 'Diese Präferenz gibt es nicht mehr.',
    landDirty: 'Nicht gelandet: Im Workspace liegen noch nicht committete Änderungen. Der Agent kümmert sich darum.',
    landConflict: 'Nicht gelandet: Beim Rebase auf main gab es Konflikte. Der Agent löst sie.',
    landEmpty: 'Nicht gelandet: Der Branch enthält keine Commits. Der Agent sieht nach.',
    landCheckout: 'Nicht gelandet: Der Obeya-Checkout steht nicht auf main. Bitte dort auf main wechseln.',
    landMerge: 'Nicht gelandet: Der Obeya-Checkout hat lokale Änderungen an denselben Dateien. Bitte dort committen oder beiseitelegen.',
    land: 'Nicht gelandet: git-Fehler im Obeya-Checkout.',
    invalid: 'Das hat nicht geklappt. Der Server hat die Aktion abgelehnt.',
  } satisfies Record<ErrorCode, string>,
  offlineError: 'Der Server ist nicht erreichbar.',
  scope: 'Voraussichtlich betroffen',
  koordinator: {
    button: 'Koordinator',
    kind: 'Koordinator',
    title: 'Planung und Präferenzen',
    queue: 'Warteschlange',
    queueEmpty: 'Nichts wartet.',
    running: 'In Arbeit',
    runningEmpty: 'Gerade arbeitet kein Agent.',
    preferences: 'Deine Präferenzen',
    preferencesHint: 'Der Koordinator lernt sie aus deinen Antworten und Hinweisen; alle Agenten halten sich daran.',
    edit: 'Zum Bearbeiten klicken',
    remove: 'Entfernen',
    add: 'Hinzufügen',
    addPlaceholder: 'Neue Präferenz',
  },
  split: 'Aufteilen',
  empty: 'Noch keine Karten. Doppelklick auf die Fläche legt eine an.',
};

export const stateLabel = (i: { state: CardState; need?: Need; queue?: Queue }) =>
  i.queue
    ? 'checking' in i.queue
      ? t.queue.checking
      : 'cutting' in i.queue
        ? t.queue.cutting
        : t.queue.waiting
    : i.state === 'waiting' && i.need
      ? t.need[i.need]
      : t.state[i.state];

/** The owner's text for a refused request or a logged error code; the generic one for anything unknown. */
export const errorText = (code: string | undefined) => (code && Object.hasOwn(t.error, code) ? t.error[code as ErrorCode] : t.error.invalid);
