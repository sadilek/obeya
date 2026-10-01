// Every UI string. German first; an English table follows the same shape.

import type { CardState, ErrorCode, Idea, Need, Queue } from '../core/types';

export const t = {
  kind: { feature: 'Feature', bugfix: 'Bugfix', project: 'Projekt', workstream: 'Workstream', idea: 'Idee', spike: 'Spike' },
  state: {
    idea: 'Idee',
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
  keys: 'Ziehen: verschieben · ⌘ + Scrollen / Pinch: Zoom · 0: Übersicht · Doppelklick: neue Karte · K: Koordinator · A: Archiv · Leertaste halten: sprechen',
  close: 'Schließen (Esc)',
  planSheet: 'Projekt · Plan',
  fromPlan: 'Aus dem Plan-Dokument; geändert wird es dort:',
  titlePlaceholder: 'Worum geht es?',
  bodyPlaceholder: 'Beschreibung',
  delete: 'Löschen',
  deleted: (title: string) => `Karte „${title}“ gelöscht.`,
  undo: 'Rückgängig',
  offline: 'Keine Verbindung zum Server',
  noCanvas: 'Obeya hat keine Leinwand. Beim Start ein Repository angeben.',
  repos: (n: number) => `${n} Repositories`,
  switchCanvas: 'Leinwand wechseln',
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
  author: { worker: 'Agent', owner: 'Du', project: 'Projekt-Agent', koordinator: 'Koordinator', obeya: 'Obeya', explorer: 'Explorations-Agent' },
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
    imageType: 'Das ist kein Bild, das der Agent lesen kann (PNG, JPEG, GIF oder WebP).',
    imageTooLarge: 'Das Bild ist zu groß, auch verkleinert.',
    notDone: 'Archivieren lässt sich nur eine eigene Karte, die live ist.',
    notArchived: 'Die Karte liegt nicht mehr im Archiv.',
    notIdea: 'Die Karte ist keine Idee (mehr).',
    spikeRunning: 'Für diese Idee läuft schon ein Spike.',
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
  voice: {
    hold: 'Halten zum Sprechen (Leertaste)',
    koordinator: 'Koordinator',
    agent: (title: string) => `Agent: ${title}`,
    idea: (title: string) => `Idee: ${title}`,
    project: (title: string) => `Projekt: ${title}`,
    noMic: 'Kein Mikrofon: der Browser hat den Zugriff nicht erlaubt.',
    failed: 'Das hat nicht geklappt; bitte noch einmal.',
    typePlaceholder: 'Dem Koordinator schreiben, z. B. „Neue Karte: …“',
    tooLate: 'Zu spät: das ist schon passiert.',
  },
  pr: {
    title: (n: number) => `Pull Request #${n}`,
    conflict: 'Konflikt mit dem Zielbranch; der Agent rebased.',
    noChecks: 'Noch keine Checks.',
    opening: 'Der Agent öffnet den Pull Request.',
    short: (n: number, failed: number, conflict: boolean) =>
      [`PR #${n}`, failed ? `${failed} ${failed === 1 ? 'Check rot' : 'Checks rot'}` : '', conflict ? 'Konflikt' : ''].filter(Boolean).join(' · '),
  },
  demo: { question: 'Offene Frage', shown: 'Gezeigt', notShown: 'Nicht gezeigt', findings: 'Auffälligkeiten', none: '–', kept: 'Die Demo bleibt hier abrufbar.' },
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
    undone: 'zurückgenommen',
    lookingUp: 'schlägt nach …',
  },
  archive: {
    button: 'Archiv',
    kind: 'Archiv',
    title: 'Erledigte Karten',
    hint: 'Zuletzt archivierte oben. Ein Klick öffnet die Karte.',
    empty: 'Noch nichts archiviert.',
    archive: 'Archivieren',
    archiveDone: (n: number) => (n === 1 ? '1 erledigte Karte archivieren' : `${n} erledigte Karten archivieren`),
    unarchive: 'Zurück auf die Leinwand',
    archived: (title: string) => `„${title}“ archiviert.`,
    archivedMany: (n: number) => (n === 1 ? '1 Karte archiviert.' : `${n} Karten archiviert.`),
    unarchived: (title: string) => `„${title}“ ist zurück auf der Leinwand.`,
    /** The heading over the cards archived on one day. */
    day: (d: Date, today = new Date()) => {
      const days = Math.round((startOfDay(today) - startOfDay(d)) / 86_400_000);
      if (days === 0) return 'Heute';
      if (days === 1) return 'Gestern';
      return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
    },
    /** When an archived card went into the archive, on the unfolded card. */
    when: (d: Date) => {
      const day = t.archive.day(d);
      return `archiviert ${day === 'Heute' || day === 'Gestern' ? day.toLowerCase() : `am ${day}`}, ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
    },
    time: (d: Date) => `archiviert ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`,
  },
  split: 'Aufteilen',
  idea: {
    status: { open: 'Idee', parked: 'Idee · geparkt', dropped: 'Idee · verworfen' } satisfies Record<Idea['status'], string>,
    yourTurn: 'Idee · du bist dran',
    brief: 'Stand der Idee',
    briefEmpty: 'Noch leer. Der Explorations-Agent hält hier fest, was das Gespräch ergibt: Ziel, Varianten, Entscheidungen, offene Fragen.',
    seed: 'Ausgangspunkt',
    talk: 'Gespräch',
    talkEmpty: 'Erzähl, worum es geht. Der Explorations-Agent liest Code und Pläne mit, fragt nach und zeigt Varianten.',
    thinking: 'denkt nach …',
    compose: 'Frag nach, widersprich, entscheide – oder halte die Leertaste',
    build: 'So bauen',
    planDoc: 'Als Projekt planen',
    spike: 'Spike bauen lassen',
    spikePlaceholder: 'Was soll der Prototyp zeigen? (leer: die Idee, wie sie steht)',
    spikeGo: 'Spike starten',
    park: 'Parken',
    drop: 'Verwerfen',
    built: 'Die Idee wird gebaut; der Stand der Idee ist ihr Auftrag.',
    planned: 'Eingeplant: Ein Agent schreibt das Plan-Doc.',
    parked: 'Idee geparkt.',
    dropped: 'Idee verworfen. Die Karte bleibt mit ihrem Stand liegen.',
    spiked: 'Spike läuft: Ein Agent baut einen Wegwerf-Prototyp.',
    spikeDemo: 'Spike',
    spikeKept: 'Der Prototyp landet nie; die Demo dient nur der Entscheidung.',
    reopen: 'Wer weiterredet, nimmt die Idee wieder auf.',
    makeIdea: 'Erst besprechen',
    spikeOf: (title: string) => `Wegwerf-Prototyp für die Idee „${title}“. Er landet nie.`,
    discard: 'Prototyp verwerfen',
    discarded: 'Prototyp verworfen; die Demo bleibt bei der Idee.',
  },
  shots: {
    attach: 'Screenshot anhängen – oder mit ⌘V einfügen oder hineinziehen',
    remove: 'Entfernen',
    enlarge: 'Vergrößern',
    close: 'Schließen (Esc)',
    alt: 'Screenshot',
    uploading: 'lädt …',
  },
  empty: 'Noch keine Karten. Doppelklick auf die Fläche legt eine an.',
};

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export const stateLabel = (i: { state: CardState; need?: Need; queue?: Queue; idea?: Idea }) =>
  i.idea
    ? i.idea.status === 'open' && i.idea.yourTurn && !i.idea.thinking
      ? t.idea.yourTurn
      : t.idea.status[i.idea.status]
    : i.queue
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
