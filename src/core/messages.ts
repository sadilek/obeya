// What the server says to the owner, in German and English (two tables of one shape, like the UI's
// strings in src/ui/strings.ts): the lines it writes into a card's log, the questions it puts to
// the owner, the Koordinator's own confirmations and what it speaks. A line goes into the log in
// the language that applies when it is written and stays so.

import type { Language } from './locale';
import type { Awaited, AwaitedState, Snooze } from './types';

/** What a worker pauses for: Obeya restarting, Obeya stopping, or only its repository's agents restarting (a change to its configuration). */
export type Pause = 'restart' | 'stop' | 'repo';

const de = {
  /** A time in the owner's words: „um 14:40“, or „am 7.10. um 14:40“ on another day. */
  when: (at: number) => {
    const d = new Date(at);
    const time = `um ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
    return d.toDateString() === new Date().toDateString() ? time : `am ${d.getDate()}.${d.getMonth() + 1}. ${time}`;
  },
  /** A day and time in the owner's words, the year only when it is not this one: „Fr 31.10., 08:00“. */
  at: (at: number) => {
    const d = new Date(at);
    const day = d.toLocaleDateString('de-DE', { weekday: 'short' }).replace(/\.$/, '');
    const year = d.getFullYear() === new Date().getFullYear() ? '' : String(d.getFullYear());
    return `${day} ${d.getDate()}.${d.getMonth() + 1}.${year}, ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  },
  /** A title as the text around it quotes it. */
  quote: (s: string) => `„${s}“`,
  /** The marker of a question with several answers allowed, after its text in the log. */
  multiple: 'Mehrfachauswahl',
  /** The headings of a taken proposal's questions in its text. */
  decided: 'Entschieden',
  openQuestions: 'Offene Fragen',
  /** Whisper's words to expect, before the titles on the canvas. */
  vocabulary: 'Obeya, Aufgabe, Folgeaufgabe, Karte, Workstream, Idee, Prototyp, parken, Demo, freigeben, Pull Request, Agent.',
  voice: {
    notUnderstood: 'Das habe ich nicht verstanden.',
    nothingHeard: 'Ich habe nichts gehört.',
    couldNotRead: (why: string) => `Ich konnte das nicht lesen. ${why}`,
    cloudFailed: (service: string, why: string) => `${service} hat die Aufnahme nicht erkannt (${why}).`,
    interrupted: 'Obeya startete neu, bevor ich das gelesen hatte. Bitte noch einmal.',
    /** The usage limit keeps the Koordinator from reading the words: it reads them by itself once it lifts. */
    held: (when: string) => `Das Nutzungslimit ist erreicht. Ich lese das ${when} von selbst.`,
    undone: 'Zurückgenommen.',
    created: 'Per Sprache angelegt.',
  },
  failure: {
    notLoggedIn: 'Claude ist auf diesem Rechner nicht angemeldet: im Terminal „claude“ starten und „/login“ ausführen.',
    session: (message: string) => `Die Claude-Sitzung brach mit einem Fehler ab: ${message}`,
  },
  answer: {
    failed: (why: string) => `Ich konnte die Frage nicht beantworten (${why}).`,
    /** On the card the question was asked on: the usage limit stopped the look-up, which goes on by itself. */
    limited: (when: string) => `Das Nutzungslimit ist erreicht. Obeya schlägt das ${when} von selbst nach.`,
    asIdea: 'Als Idee weiter besprochen.',
  },
  tool: {
    read: (file: string) => `Liest ${file}`,
    edit: (file: string) => `Ändert ${file}`,
    write: (file: string) => `Schreibt ${file}`,
    grep: (pattern: string) => `Sucht „${pattern}“`,
    glob: (pattern: string) => `Sucht Dateien ${pattern}`,
    todo: 'Plant die nächsten Schritte',
  },
  worker: {
    restarted: (earlier: string) => `Von vorn gestartet. ${earlier}`,
    newSession: (earlier: string) => `Neue Sitzung. ${earlier}`,
    earlierRun: (session: string) => `Der frühere Lauf (Sitzung ${session}) bleibt für die Arbeitsrückschau erhalten.`,
    started: (branch: string) => `Agent gestartet auf ${branch}.`,
    laterInConversation: 'Danach im Gespräch:',
    approvedPr: 'Freigegeben. Der Agent öffnet den Pull Request.',
    approvedDirect: 'Freigegeben und direkt auf main gepusht.',
    landedDirect: 'Nach der Freigabe direkt auf main gepusht.',
    approvedMain: 'Freigegeben und auf main.',
    landedMain: 'Nach der Freigabe auf main gelandet.',
    approvedUnchanged: 'Freigegeben. Ohne Änderung am Code gibt es nichts zu landen: erledigt.',
    doneUnchanged: 'Ohne Änderung am Code abgeschlossen: erledigt.',
    startedInFolder: 'Agent gestartet im Ordner.',
    approvedFolder: 'Freigegeben. Die Änderungen bleiben im Ordner: erledigt.',
    /** What „Änderungen verwerfen“ did in a folder without git. */
    undone: (n: number) => (n === 1 ? 'Änderungen verworfen: 1 Datei zurückgesetzt.' : `Änderungen verworfen: ${n} Dateien zurückgesetzt.`),
    undoChangedSince: (files: string) => `Seitdem von jemand anderem geändert, daher gelassen: ${files}.`,
    undoLost: (files: string) => `Nicht rückgängig zu machen, keine Kopie von vorher: ${files}.`,
    undoShared: (files: string) => `Zugleich mit einer anderen Karte geändert, daher gelassen: ${files}.`,
    prototypeDiscarded: 'Verworfen; der Code ist weg, Demo und Log bleiben im Archiv.',
    prototypeBuiltInto: (workstream: string) => `Gebaut: Workstream ${workstream} wird auf diesem Prototyp gebaut.`,
    prototypeBuilt: (idea: string) => `Gebaut: Die Idee „${idea}“ wird auf diesem Prototyp gebaut.`,
    prototypeDiscardedOnIdea: (title: string) => `Prototyp „${title}“ verworfen; er liegt mit seiner Demo im Archiv.`,
    merged: 'Pull Request gemergt. Live.',
    prClosed: 'Pull Request ohne Merge geschlossen.',
    prClosedQuestion: 'Der Pull Request wurde geschlossen, ohne gemergt zu werden. Wie geht es weiter?',
    reopen: 'Neu eröffnen',
    discardWork: 'Die Arbeit verwerfen',
    stopped: 'Gestoppt.',
    /** The owner paused the worker, and let it go on again. */
    pausedByOwner: 'Pausiert.',
    resumedByOwner: 'Weiter.',
    /** The card was snoozed until a time (`at`, or `awaits`), with what its agent does then. */
    snoozed: (at: string, why?: string) => `Zurückgestellt bis ${at}${why ? ` · ${why}` : ''}`,
    /** Until when a worker waits on another card: until it is done or waits for the owner, and at the latest when, if it gave a time. */
    awaits: (title: string, state: AwaitedState, at?: string) => `„${title}“ ${state === 'done' ? 'erledigt ist' : 'auf dich wartet'}${at ? `, spätestens ${at}` : ''}`,
    /** It woke from a snooze, and why (`wokeWhy`). Until 2026-10-17 the line said who had snoozed it: „Wieder da (vom Agenten zurückgestellt)“. */
    woke: (why: string) => `Wieder da: ${why}`,
    wokeWhy: {
      time: 'Zeitpunkt erreicht',
      owner: 'von dir zurückgeholt',
      /** Obeya had something for an agent that snoozed itself (a review, the landing, a failed check). */
      news: 'Neues für den Agenten',
      needsYou: 'die Karte braucht dich',
      /** What became of the card the agent waited on. */
      card: (title: string, met: Awaited, state: AwaitedState) =>
        `„${title}“ ${{ reached: state === 'done' ? 'ist erledigt' : 'wartet auf dich', gone: 'ist nicht mehr da', archived: 'ist archiviert', stopped: 'wurde gestoppt', dropped: 'wurde verworfen' }[met]}`,
    },
    parked: 'App im Workspace gestoppt, solange die Karte wartet. Der Agent startet sie wieder, wenn er sie braucht.',
    parkKept: 'Die App im Workspace läuft weiter, während die Karte wartet: Sie hält Daten, die bleiben sollen. Soll sie trotzdem gestoppt werden, sag es dem Agenten.',
    parkFailed: (output: string) => `Die App im Workspace zu stoppen, ist fehlgeschlagen: ${output}`,
    /** The page the owner's browser gets for a card whose app no longer runs. */
    appGone: 'Die App dieser Karte läuft nicht mehr. Soll der Agent sie wieder starten, sag es ihm auf der Karte.',
    stoppedPrOpen: (n: number) => `Gestoppt. Pull Request #${n} bleibt offen.`,
    restartDue: (pause: Pause) =>
      `${pause === 'stop' ? 'Beenden von Obeya' : pause === 'repo' ? 'Neustart der Agenten dieses Repositorys' : 'Neustart von Obeya'} angekündigt; der Agent pausiert beim nächsten sicheren Punkt.`,
    restartWaits: (pause: Pause): string =>
      pause === 'stop'
        ? 'Obeya wartet auf das Beenden; der Agent macht weiter, wenn Obeya wieder läuft.'
        : pause === 'repo'
          ? 'Obeya wartet, um die Agenten dieses Repositorys neu zu starten; der Agent macht danach weiter.'
          : 'Obeya wartet auf einen Neustart; der Agent macht danach weiter.',
    restartStillDue: (pause: Pause) => `Der Agent ist vor dem ${pause === 'stop' ? 'Beenden' : 'Neustart'} wieder aufgewacht; Obeya sagt ihm, dass ${pause === 'stop' ? 'das Beenden' : 'der Neustart'} noch auf ihn wartet.`,
    limitResumes: (when: string) => `Der Agent arbeitet ${when} automatisch weiter.`,
    limitRetries: (when: string) => `Obeya versucht es ${when} noch einmal.`,
    paused: (pause: Pause): string => (pause === 'stop' ? 'Pausiert, bis Obeya wieder läuft.' : pause === 'repo' ? 'Pausiert bis zum Neustart der Agenten dieses Repositorys.' : 'Pausiert bis zum Neustart von Obeya.'),
    hostLost: (host: string) => `Die Verbindung zu ${host} ist weg; der Agent macht weiter, sobald ${host} wieder erreichbar ist.`,
    hostBack: (host: string) => `${host} ist wieder erreichbar; der Agent macht weiter.`,
    stalled: 'Der Agent hat angehalten, ohne fertig zu sein.',
    unanswered: 'Der Agent hat aufgehört, ohne auf deine Nachricht zu antworten. Schreib noch einmal, dann macht er weiter.',
    remainsUndone: (reason: string) => `${reason} Was nach der Landung noch zu tun war, ist nicht erledigt; „Stoppen“ schließt die Karte ohne den Rest ab.`,
    tryAgain: 'Nochmal versuchen',
    /** A tool call refused without asking anyone: what it was, who refused it, and their words when they gave any. */
    denied: (what: string, by: string, reason?: string) => `Nicht erlaubt (${by}): ${what}${reason ? ` — ${reason}` : ''}`,
    deniedBy: {
      rule: 'Regel in den Einstellungen',
      classifier: 'Prüfmodell des Auto-Modus',
      mode: 'Berechtigungsmodus',
      hook: 'Hook',
      obeya: 'Obeya: Warten im Vordergrund',
      other: 'ohne Angabe',
    },
    /** A tool call the settings want the owner to confirm, as the question the card waits on. */
    permission: (what: string, reason?: string) => `Der Agent möchte das tun, und die Einstellungen verlangen dafür deine Bestätigung:\n\n${what}${reason ? `\n\nGrund der Rückfrage: ${reason}` : ''}`,
    allow: 'Erlauben',
    deny: 'Ablehnen',
    limitStatus: 'Nutzungslimit',
    limitStatusUntil: (when: string) => `Nutzungslimit · weiter ${when}`,
    proposesBuild: (reason: string) => `Schlägt vor, die Idee auf diesem Prototyp zu bauen: ${reason}`,
    proposedIdea: (title: string) => `Idee vorgeschlagen: ${title}`,
    proposedCard: (title: string) => `Aufgabe vorgeschlagen: ${title}`,
    /** The agent's own earlier proposal, withdrawn or replaced (`by`: the proposal that takes its place). */
    withdrewProposal: (title: string, why?: string, by?: string) =>
      by ? `Ersetzt den Vorschlag „${title}“ durch „${by}“${why ? `: ${why}` : '.'}` : `Zieht den Vorschlag „${title}“ zurück${why ? `: ${why}` : '.'}`,
    /** On the accepted proposal it withdrew or replaced: who did and why. */
    superseded: (by?: string, why?: string) =>
      by ? `Der vorschlagende Agent hat diese Karte ersetzt durch „${by}“${why ? `: ${why}` : '.'}` : `Der vorschlagende Agent hat diese Karte zurückgezogen${why ? `: ${why}` : '.'}`,
    prOpened: (n: number) => `Pull Request #${n} geöffnet.`,
    landing: 'Landet auf main',
    waitsForRestart: 'Wartet auf den Neustart von Obeya mit der neuen Version',
    needsClone: 'Braucht für die Antwort einen vollen Klon',
    waitsForWorkspace: 'Wartet auf Workspace',
    waitsForClone: 'Die Nachfrage wartet auf den nächsten freien Klon und geht dann von selbst weiter.',
    cloneFree: 'Ein Klon ist frei: Der Agent antwortet dort weiter.',
  },
  pr: {
    checkFailed: (names: string) => `Check fehlgeschlagen: ${names}. Der Agent sieht nach.`,
    conflict: 'Konflikt mit dem Zielbranch. Der Agent bringt den Branch auf Stand.',
    stale: 'Neuer Stand seit dem letzten Review, um ein neues hat niemand gebeten. Der Agent fragt danach.',
    held: (by: string, score: string) => `Bereit zum Mergen, aber ${by} gibt nur ${score}: Unter 4/5 mergt Obeya nicht selbst. Du entscheidest.`,
    ready: 'Bereit zum Mergen: Checks grün, alle Anmerkungen erledigt, das Review ist durch. Obeya mergt.',
    mergeFailed: (reason: string) => `Obeya konnte nicht mergen: ${reason}`,
    unreadable: (reason: string) => `Obeya kann den Pull Request nicht lesen: ${reason}`,
  },
  idea: {
    buildAfterReply: 'So bauen, sobald die Antwort da ist; fragt der Agent noch etwas, wird nicht gebaut.',
    buildAnswer: 'So bauen, wie der Stand der Idee sagt.',
    buildLog: 'So bauen: Der Stand der Idee ist der Auftrag.',
    unbuild: 'Doch nicht bauen.',
    notBuiltNoReply: 'Nicht gebaut: Die Antwort kam nicht zustande.',
    notBuiltQuestions: 'Nicht gebaut: Der Agent hat noch Fragen.',
    notBuiltQuestion: 'Nicht gebaut: Der Agent hat noch eine Frage.',
    buildOnAnswer: (prototype: string) => `So bauen, auf Prototyp „${prototype}“.`,
    buildOnLog: (prototype: string) => `So bauen, auf dem Prototyp „${prototype}“: Sein Branch ist jetzt der dieser Aufgabe.`,
    whichPrototype: (workstream: string) => `Auf welchem Prototyp baut ${workstream}?`,
    onPrototype: (prototype: string) => `Auf Prototyp „${prototype}“.`,
    workstreamOnLog: (prototype: string) => `Auf dem Prototyp „${prototype}“ bauen: Sein Branch ist jetzt der dieses Workstreams.`,
    splitOffAnswer: (task: string) => `Teilaufgabe abtrennen: „${task}“.`,
    splitOffLog: (task: string) => `Teilaufgabe abgetrennt: „${task}“ ist jetzt eine eigene Aufgabe; das Offene bleibt hier.`,
    /** The task "Teilaufgabe abtrennen" makes: where it comes from, after the part its agent marked. */
    settledTask: (idea: string) => `Aus der Idee „${idea}“ der Teil, der feststeht. Was dort noch offen ist, bespricht die Idee weiter; es gehört nicht zu dieser Aufgabe.`,
    settledFrom: (idea: string) => `Von der Idee „${idea}“ abgetrennt.`,
    howOn: (idea: string) => `Idee „${idea}“: wie weiter?`,
    howOnTask: (task: string) => `Aufgabe „${task}“: wie weiter?`,
    planDocAnswer: 'Als Projekt: erst ein Plan-Doc mit Workstreams.',
    planDocLog: 'Als Projekt: Ein Agent schreibt das Plan-Doc; ist es gelandet, tritt das Projekt an die Stelle der Idee.',
    planDocTaskLog: 'Als Projekt: Ein Agent schreibt das Plan-Doc; ist es gelandet, tritt das Projekt an die Stelle der Aufgabe.',
    dropped: 'Verworfen.',
    parked: 'Geparkt.',
    /** `file`: the doc to write, where the plan directory is a folder outside the repository. */
    planDocTask: (dir: string, task = false, file?: string) =>
      `Schreibe aus ${task ? 'dieser Aufgabe' : 'dem Stand dieser Idee'} ein Plan-Doc ${file ? `als \`${file}\`, in einem Ordner dieses Rechners außerhalb des Repositorys,` : `in \`${dir}/\`,`} nach den Konventionen des Repositorys (vorhandene Plan-Docs als Vorbild). Es braucht ein \`## Ziel\` (oder \`## Goal\`) und eine Checkliste unter \`## Workstreams\` (\`- [ ] **W1:** Titel. Details\`), in Pakete geschnitten, die einzeln landen können; dann zeigt Obeya es als Projekt, das an die Stelle dieser ${task ? 'Aufgabe' : 'Idee'} tritt. Baue nichts davon; nur das Plan-Doc${file ? '' : ' (und ein Verweis darauf, wo das Repository Plan-Docs verlinkt)'}.`,
    planDocIdea: (title: string) => `Idee: „${title}“`,
    planDocCard: (title: string) => `Aufgabe: „${title}“`,
    planDocPrototypes: (n: number) =>
      `Zu dieser Idee gibt es schon ${n > 1 ? `${n} Prototypen` : 'einen Prototyp'}. Sie bleiben auf der Leinwand stehen; steht das Projekt, wählt der Owner einen von ihnen („Diesen Prototyp bauen“), und der Workstream, der darauf aufbaut, wird auf seinem Branch gebaut. Plane sie also nicht noch einmal als Workstreams, sondern nimm, was sie gezeigt haben, ins Plan-Doc auf. Nur der Workstream, der auf dem gewählten Prototyp aufbaut, erwähnt Prototypen: an ihm erkennt Obeya, welcher Workstream auf dem Branch des Prototyps gebaut wird.`,
    planDocHandedOver: (title: string, summary: string) => `„${title}“, so übergeben:\n\n${summary}`,
    planDocInProgress: (title: string) => `„${title}“: noch in Arbeit.`,
    onlyThisVariant: (others: string) => `Nur diese Variante: ${others} bauen eigene Prototypen.`,
    showAsItStands: 'Zeige die Idee so, wie der Stand der Idee sie beschreibt.',
    prototypeTitle: (idea: string) => `Prototyp: ${idea}`,
    prototypesStarted: (titles: string) => `Prototypen gestartet: ${titles}.`,
    prototypeStarted: (title: string, what: string) => `Prototyp „${title}“ gestartet${what ? `: ${what}` : ''}.`,
    prototypeReady: (title: string, demo: boolean) => `Prototyp „${title}“ fertig${demo ? '; seine Demo liegt hier' : ''}.`,
    reopened: 'Idee wieder aufgenommen.',
    briefUpdated: 'Aktualisiert den Stand der Idee',
    plansPrototypes: (approaches: string) => `Plant Prototypen: ${approaches}`,
    plansNoPrototypes: 'Plant keine Prototypen mehr',
    plansSplit: (task: string) => `Markiert eine Teilaufgabe zum Abtrennen: „${task}“`,
    plansNoSplit: 'Markiert keine Teilaufgabe zum Abtrennen mehr',
    decision: (question: string, answer: string) => `Entscheidung: ${question} → ${answer}`,
    becameProject: 'Das Projekt steht jetzt an der Stelle der Idee; die Idee liegt im Archiv.',
    taskBecameProject: 'Das Projekt steht jetzt an der Stelle der Aufgabe; die Aufgabe liegt im Archiv.',
    /** A workstream whose part landed while its plan doc keeps it open. */
    partLanded: 'Teil gelandet, im Plan-Doc weiter offen.',
    /** How the brief and the prototype button are called on the card, for the idea's agent. */
    briefName: 'Stand der Idee',
    prototypeButton: 'Prototyp bauen lassen',
    splitOffButton: 'Teilaufgabe abtrennen',
  },
  proposal: {
    /** `how`: the button clicked, "Übernehmen und starten", "Übernehmen und besprechen" (a proposed idea) or "Als Idee besprechen". */
    acceptAfterRevision: (how: 'start' | 'discuss' | 'asIdea') =>
      `${{ start: 'Übernehmen und starten', discuss: 'Übernehmen und besprechen', asIdea: 'Als Idee besprechen' }[how]}, sobald der Vorschlag überarbeitet ist; hat er noch Fragen, bleibt er Vorschlag.`,
    notAccepting: 'Doch nicht übernehmen.',
    notAcceptedNoRevision: 'Nicht übernommen: Die Überarbeitung kam nicht zustande.',
    notAcceptedQuestions: 'Nicht übernommen: Der Vorschlag hat noch Fragen.',
    notAcceptedQuestion: 'Nicht übernommen: Der Vorschlag hat noch eine Frage.',
  },
  koordinator: {
    allStarted: (names: string) => `Alle Workstreams gestartet: ${names}. Obeya legt die Reihenfolge fest.`,
    startedDespite: 'Trotz Überschneidung gestartet.',
    startTakenBack: (names: string) => `Start zurückgenommen: ${names}.`,
    dequeued: 'Aus der Warteschlange genommen.',
    movedBefore: (title: string) => `In der Warteschlange vor „${title}“ gezogen.`,
    movedAfter: (title: string) => `In der Warteschlange hinter „${title}“ gestellt.`,
    proposes: (rule: string) => `Schlägt vor: „${rule}“`,
    nothingRuns: 'Nichts läuft gerade; es geht sofort los.',
    estimateFailed: (why: string) => `Obeya konnte den Umfang nicht schätzen (${why}); die Aufgabe startet trotzdem.`,
    noConflict: 'Kein Merge-Konflikt mit laufender Arbeit zu erwarten.',
    waitsAhead: (title: string) => `„${title}“ (wartet selbst und ist vorher dran)`,
    likelyConflict: 'Wahrscheinlich Merge-Konflikte mit laufender Arbeit.',
    waitsFor: (names: string, reason: string) => `Obeya: wartet auf ${names}. ${reason}`,
    togetherFailed: (why: string) => `Obeya konnte die Workstreams nicht gemeinsam einplanen (${why}) und prüft sie einzeln.`,
    togetherStarts: 'Gemeinsam mit den anderen Workstreams eingeplant; startet jetzt.',
    planned: (started: number, of: number) => `Eingeplant: ${started} von ${of} Workstreams starten jetzt, die anderen warten.`,
    says: (why: string) => `Obeya: ${why}`,
    workspaceFree: 'Ein Workspace ist frei; es geht los.',
    slotFree: 'Ein Rechner hat wieder einen Slot frei; es geht los.',
    waitedDone: 'Worauf sie gewartet hat, ist erledigt; es geht los.',
    waitedDoneRecheck: 'Obeya: Worauf sie gewartet hat, ist erledigt; prüft neu gegen die laufende Arbeit.',
    noWorkspace: 'Kein Workspace frei: Alle sind belegt oder es ist keiner eingerichtet. Die Aufgabe startet, sobald einer frei wird.',
    dirtyWorkspaces: 'Kein Workspace frei: Jeder freie hat noch nicht committete Änderungen. Die Aufgabe startet, sobald einer sauber ist.',
    noSlot: 'Kein Slot frei: Auf jedem Rechner mit freiem Workspace arbeiten so viele Agenten, wie er Slots hat. Die Aufgabe startet, sobald einer fertig ist.',
    ruleTaken: (rule: string) => `Regel aufgenommen: „${rule}“`,
    revised: 'Vorschlag überarbeitet.',
    reviseFailed: (why: string) => `Überarbeiten ging nicht: ${why}`,
  },
  claudeMd: {
    title: 'CLAUDE.md ergänzen',
    task: 'Der Owner hat diese Regeln für dieses Repo festgelegt. Arbeite sie in die CLAUDE.md ein, passend zu dem, was dort steht (Abschnitt, Ton, Länge) und ohne Dopplungen; steht eine schon sinngemäß drin, schärfe nur die Stelle. Sonst nichts ändern. Statt einer Demo genügt in der Zusammenfassung der neue Wortlaut.',
  },
  retro: {
    friction: (notes: string) => `Arbeitsrückschau, Reibung notiert:\n${notes}`,
    note: (what: string, cost: string, fix: string) => `– ${what} Kosten: ${cost} Verhindert hätte es: ${fix}`,
    nothingToRead: (repo: string) => `Arbeitsrückschau für ${repo}: Seit der letzten gibt es keine Reibung zu lesen.`,
    occasion: (why: string) => `Anlass (Arbeitsrückschau): ${why}`,
    from: (repo: string, why: string, cards: string) => `Aus der Arbeitsrückschau für ${repo}. ${why} Karten: ${cards}.`,
    done: (repo: string, made: number) =>
      `Arbeitsrückschau für ${repo}: ${made ? `${made === 1 ? 'ein Vorschlag' : `${made} Vorschläge`}, auf der Leinwand und bei Obeya.` : 'nichts, was sich auf mehreren Karten wiederholt.'}`,
    settings: { checks: 'Prüfungen', setup: 'Einrichten', softPaths: 'Weiche Pfade', run: 'So läuft die App' },
    onMachine: (setting: string, repo: string) => `„${setting}“ für ${repo} gilt jetzt auf diesem Rechner.`,
    committed: (setting: string, repo: string, branch: string) => `„${setting}“ für ${repo} steht jetzt in .obeya/settings.json auf ${branch} und gilt für alle.`,
    opened: (setting: string, repo: string, pr: string) => `„${setting}“ für ${repo}: Pull Request geöffnet, ${pr}. Bis er gemergt ist, gilt der Wert auf diesem Rechner.`,
  },
  share: {
    share: 'Teilen: Die Seite geht online.',
    again: 'Erneut teilen: Die Seite wird mit dem neuen Stand erzeugt.',
    newDemo: 'Auf der Seite ersetzen: Die Seite zeigt jetzt diese Demo statt der geteilten.',
    added: 'Zur Seite dazunehmen: Die Seite bekommt diese Demo als Ergänzung dazu.',
    unshare: 'Nicht mehr teilen: Die Seite wird zurückgezogen.',
    unshareOne: 'Nicht mehr teilen: Die Seite geht ohne diese Demo wieder online.',
    againWithOthers: 'Erneut teilen, mit anderen geteilten Demos: Die Seite wird mit dem neuen Stand erzeugt.',
    approved: (how: 'share' | 'replace' | 'add'): string =>
      how === 'share'
        ? 'Mit der Freigabe geteilt: Die Seite geht online.'
        : how === 'add'
          ? 'Mit der Freigabe zur Seite dazugenommen: Die Seite bekommt die neueste Demo als Ergänzung dazu.'
          : 'Mit der Freigabe auf der Seite ersetzt: Die Seite zeigt jetzt die neueste Demo statt der geteilten.',
    notOnApproval: 'Mit der Freigabe nicht geteilt: „Mit der Freigabe teilen“ war abgewählt.',
    notAgain: 'Nicht erneut geteilt',
    notLinked: 'Der Link zum Pull Request ist nicht auf die Seite gekommen',
    notShared: 'Nicht geteilt',
    demoGone: 'Eine Demo, die die Seite zeigt, ist nicht mehr da; „Auf der Seite ersetzen“ bringt die neueste der Aufgabe.',
    linkLater: 'Die geteilte Seite bekommt den Link zum Pull Request mit dem nächsten Teilen.',
    noDemo: 'Die Aufgabe hat keine Demo mehr, oder ihr Repository teilt keine.',
    sharedAgain: (url: string) => `Erneut geteilt: ${url}`,
    linksPr: (url: string) => `Die geteilte Seite verlinkt jetzt den Pull Request: ${url}`,
    shared: (url: string) => `Geteilt: ${url}`,
    prLinked: (n: number | undefined) => `Den Link zur Demo in die Beschreibung von Pull Request #${n} eingetragen.`,
    prNotLinked: (n: number | undefined, why: string) => `Den Link zur Demo nicht in Pull Request #${n} eingetragen: ${why}`,
    notWithdrawnNoShare: 'Nicht zurückgezogen: Das Repository der Aufgabe teilt keine Demos mehr.',
    withdrawn: 'Die Seite ist zurückgezogen.',
    // a site Obeya keeps (`demo.site`): why a page did not go out, or did not come down
    pageIncomplete: 'Der Seite fehlen Titel, Text oder das Verzeichnis der Demo.',
    fileMissing: (file: string, dir: string) => `${file} fehlt in ${dir}.`,
    fileTooLarge: (file: string, mib: string, max: string) => `${file} ist ${mib} MiB groß; die Site nimmt höchstens ${max} MiB pro Datei.`,
    siteLacks: (dir: string, slugs: string[]) =>
      `Nicht deployt: ${dir} fehlen ${slugs.length === 1 ? 'eine Seite' : `${slugs.length} Seiten`}, die Obeya als geteilt kennt (${slugs.join(', ')}); ein Deploy nähme ${slugs.length === 1 ? 'sie' : 'sie alle'} offline. Erst das Verzeichnis wiederherstellen.`,
    envMissing: (file: string) => `${file} fehlt auf diesem Rechner.`,
    deployFailed: (code: number) => `Der Deploy der Site ist gescheitert (Exit-Code ${code}).`,
    notWithdrawn: (why: string) => `Nicht zurückgezogen: ${why}`,
    // several machines publishing to one site: the manifest read before and after each deploy
    manifestUnreadable: (url: string, why: string) =>
      `Das Manifest der Site war nicht zu lesen (${url}: ${why}). Ohne es nähme ein Deploy womöglich Seiten offline, die andere Rechner geteilt haben.`,
    loginWall: (status: number) => `HTTP ${status}, eine Umleitung auf eine Anmeldung; die headers der Site fehlen oder stimmen nicht`,
    notManifest: 'keine Manifest-Datei',
    headerKey: (key: string, header: string) => `Der Header ${header} der Site braucht ${key}, und die env-Datei der Site hat es nicht.`,
    pulling: (pages: number, mib: string) => `Lade ${pages === 1 ? 'eine Seite' : `${pages} Seiten`} von der Site, die andere Rechner geteilt haben (${mib} MiB) …`,
    pulled: (done: number, of: number) => `${done} von ${of} Seiten geladen.`,
    downloadFailed: (file: string, why: string) => `${file} war von der Site nicht zu laden (${why}).`,
    downloadBad: (file: string) => `${file} von der Site passt nicht zu ihrem Manifest.`,
    cameBetween: 'Der Deploy eines anderen Rechners kam dazwischen; noch eine Runde.',
    lostTwice: 'Zweimal kam der Deploy eines anderen Rechners dazwischen; die Site zeigt die Änderung nicht. Bitte noch einmal.',
    notSeenYet: 'Die Site zeigt den neuen Stand noch nicht; der nächste Deploy prüft wieder.',
    withdrawnElsewhere: (machine: string) => `Die Seite wurde auf einem anderen Rechner (${machine}) zurückgezogen; der Link ist weg.`,
    restored: 'Die Seite fehlte auf der Site: Der Deploy eines anderen Rechners hatte sie offline genommen. Obeya hat sie wieder deployt.',
    notRestored: (why: string) => `Die Seite fehlt auf der Site (der Deploy eines anderen Rechners hat sie offline genommen) und ist nicht wieder deployt: ${why}`,
    exported: (zip: boolean, name: string) => `Exportiert als ${zip ? 'ZIP' : 'HTML-Datei'}: ${name}`,
    /** The line in a pull request's description that links its demo. */
    rebuilt: (language: 'de' | 'en'): string =>
      `Das Demo ist in seinem Verzeichnis neu vertont, auf ${language === 'en' ? 'Englisch' : 'Deutsch'}: Die Aufgabe zeigt es mit seinen neuen Kapiteln, und der Text seiner Seite wird beim Teilen neu geschrieben.`,
    prLine: (html: boolean): string => (html ? 'Demo-Seite' : 'Demo-Video'),
  },
  /** The first card on the canvas the setup assistant created: what to try. */
  welcome: {
    title: 'Erste Aufgabe: etwas Kleines ändern',
    body: 'Schreib in diese Karte, was ein Agent in diesem Repository tun soll, zum Beispiel: „Ergänze im README, wie man das Projekt startet.“ Dann „Agent starten“: Er arbeitet auf einem eigenen Branch, fragt nach, wenn er etwas nicht selbst entscheiden soll, und zeigt dir zum Schluss eine Demo. Du gibst sie frei oder schreibst, was noch fehlt.\n\nWeitere Aufgaben legst du mit „+ Neue Aufgabe“ an, oder du sagst sie: Leertaste halten und sprechen. „Konfiguration“ → „Einrichtung prüfen“ prüft auch später, was Obeya auf diesem Rechner braucht.',
  },
  adapterSetup: {
    title: (repo: string) => `Obeya für ${repo} einrichten`,
    body: 'Füll mit dem Skill `obeya:settings` die Einstellungen dieses Repositorys für alle aus (`.obeya/settings.json`, in der Konfiguration unter „Einstellungen“ als „aus dem Repository“ zu sehen): welche Prüfungen laufen, wie Arbeit landet, wie ein Agent die App betreibt (starten, nach einer Änderung, für eine Demo), wie Obeya sie stoppt, und wo die Plan-Docs liegen, die Obeya als Projekte zeigt. Hat das Repository noch ein `.obeya/adapter/`, übernimm, was darin steht, in die Einstellungen und lösch es. Was du im Repository nicht herausfindest (Login, Testdaten), frag mich.',
  },
  /** The card that turns a doc in the plan directory that is not a project into one. */
  preparePlanDoc: {
    title: (file: string) => `${file.slice(file.lastIndexOf('/') + 1)} als Projekt aufbereiten`,
    body: (file: string) =>
      `Bereite \`${file}\` so auf, dass Obeya es als Projekt zeigt. Obeya liest ein Plan-Doc als Projekt, wenn unter \`## Workstreams\` (oder \`## Arbeitspakete\`) eine Checkliste steht: Jeder Punkt der obersten Ebene ist ein Workstream (\`- [ ] **W1:** Titel. Details\`), ein Paket, das einzeln landen kann, und ein abgehakter ist gelandet. Das Ziel des Projekts ist der erste Absatz unter \`## Goal\` (oder \`## Ziel\`).\n\nErgänze die Checkliste, und das Ziel, wenn es fehlt, im Stil des Docs aus dem, was es plant. Führt es seine Aufgaben schon unter einer anderen Überschrift (Tasks, Meilensteine, Phasen), wird daraus die Checkliste, statt sie zu verdoppeln. Hake ab, was schon erledigt ist; ist alles erledigt, sag es mir, denn ein Projekt mit lauter abgehakten Workstreams geht gleich ins Archiv. Der übrige Text bleibt, und gebaut wird nichts davon.`,
  },
  /** The page another device gets until it is paired (src/server/remote.ts). */
  notOwner: {
    title: 'Nicht angemeldet · Obeya',
    heading: 'Dieser Browser ist nicht bei Obeya angemeldet',
    how: 'Öffne den Link, den Obeya beim Start im Terminal ausgibt („Obeya … on http://127.0.0.1:…/login?token=…“). Er gilt, bis Obeya neu startet; danach gibt Obeya einen neuen aus, und auch, wenn du es noch einmal startest, während es läuft. In der App öffnet „Im Browser öffnen“ (in den Einstellungen) Obeya angemeldet im Browser.',
    used: 'Dieser Link gilt nicht mehr: Obeya ist seither neu gestartet, oder er war für einen einzigen Browser.',
  },
  notPaired: {
    title: 'Nicht verbunden · Obeya',
    heading: 'Dieses Gerät ist nicht mit Obeya verbunden',
    how: 'Am Rechner, auf dem Obeya läuft: oben in der Leiste das Telefon-Symbol, dann den QR-Code mit der Kamera dieses Geräts scannen. Oder den Code, der dort steht, hier eingeben:',
    code: 'Code',
    pair: 'Verbinden',
    wrong: 'Dieser Code stimmt nicht oder ist abgelaufen. „Telefon verbinden“ am Rechner zeigt einen neuen.',
  },
  /** A push to the owner's phone: what the card waits for, or how many cards a push of several stands for. */
  push: {
    demo: 'Demo bereit',
    review: 'Bereit zur Abnahme',
    answered: 'Agent hat geantwortet',
    question: 'Frage an dich',
    stuck: 'Agent kommt nicht weiter',
    landing: 'Landen fehlgeschlagen',
    proposal: 'Vorschlag eines Agenten',
    superseded: 'Vom Agenten zurückgezogen oder ersetzt',
    pr: 'PR wartet auf dich',
    idea: 'Idee · du bist dran',
    several: (n: number) => `${n} Karten warten auf dich`,
  },
};

export type Messages = typeof de;

const en: Messages = {
  when: (at: number) => {
    const d = new Date(at);
    const time = `at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    return d.toDateString() === new Date().toDateString() ? time : `on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
  },
  at: (at: number) => {
    const d = new Date(at);
    const year = d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' as const };
    return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...year }).replace(',', '')}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  },
  quote: (s: string) => `“${s}”`,
  multiple: 'multiple choice',
  decided: 'Decided',
  openQuestions: 'Open questions',
  vocabulary: 'Obeya, task, follow-up, card, workstream, idea, prototype, park, demo, approve, pull request, agent.',
  voice: {
    notUnderstood: 'I did not understand that.',
    nothingHeard: 'I heard nothing.',
    couldNotRead: (why: string) => `I could not read that. ${why}`,
    cloudFailed: (service: string, why: string) => `${service} did not transcribe the recording (${why}).`,
    interrupted: 'Obeya restarted before I had read that. Please say it again.',
    held: (when: string) => `The usage limit is reached. I will read this by myself ${when}.`,
    undone: 'Taken back.',
    created: 'Created by voice.',
  },
  failure: {
    notLoggedIn: 'Claude is not logged in on this machine: run “claude” in a terminal and then “/login”.',
    session: (message: string) => `The Claude session failed with an error: ${message}`,
  },
  answer: {
    failed: (why: string) => `I could not answer the question (${why}).`,
    limited: (when: string) => `The usage limit is reached. Obeya looks this up by itself ${when}.`,
    asIdea: 'Discussed further as an idea.',
  },
  tool: {
    read: (file: string) => `Reads ${file}`,
    edit: (file: string) => `Edits ${file}`,
    write: (file: string) => `Writes ${file}`,
    grep: (pattern: string) => `Searches for “${pattern}”`,
    glob: (pattern: string) => `Looks for files ${pattern}`,
    todo: 'Plans the next steps',
  },
  worker: {
    restarted: (earlier: string) => `Started from scratch. ${earlier}`,
    newSession: (earlier: string) => `New session. ${earlier}`,
    earlierRun: (session: string) => `The earlier run (session ${session}) is kept for the work retrospective.`,
    started: (branch: string) => `Agent started on ${branch}.`,
    laterInConversation: 'Later in the conversation:',
    approvedPr: 'Approved. The agent opens the pull request.',
    approvedDirect: 'Approved and pushed straight to main.',
    landedDirect: 'Pushed straight to main after the approval.',
    approvedMain: 'Approved and on main.',
    landedMain: 'Landed on main after the approval.',
    approvedUnchanged: 'Approved. Without a change to the code there is nothing to land: done.',
    doneUnchanged: 'Finished without a change to the code: done.',
    startedInFolder: 'Agent started in the folder.',
    approvedFolder: 'Approved. The changes stay in the folder: done.',
    undone: (n: number) => (n === 1 ? 'Changes discarded: 1 file put back.' : `Changes discarded: ${n} files put back.`),
    undoChangedSince: (files: string) => `Changed by someone else since, so left alone: ${files}.`,
    undoLost: (files: string) => `Cannot be undone, no copy from before: ${files}.`,
    undoShared: (files: string) => `Changed at the same time as another card, so left alone: ${files}.`,
    prototypeDiscarded: 'Discarded; the code is gone, demo and log stay in the archive.',
    prototypeBuiltInto: (workstream: string) => `Built: workstream ${workstream} is built on this prototype.`,
    prototypeBuilt: (idea: string) => `Built: the idea “${idea}” is built on this prototype.`,
    prototypeDiscardedOnIdea: (title: string) => `Prototype “${title}” discarded; it is in the archive with its demo.`,
    merged: 'Pull request merged. Live.',
    prClosed: 'Pull request closed without a merge.',
    prClosedQuestion: 'The pull request was closed without being merged. How should it go on?',
    reopen: 'Reopen it',
    discardWork: 'Discard the work',
    stopped: 'Stopped.',
    pausedByOwner: 'Paused.',
    resumedByOwner: 'Resumed.',
    snoozed: (at: string, why?: string) => `Snoozed until ${at}${why ? ` · ${why}` : ''}`,
    awaits: (title: string, state: AwaitedState, at?: string) => `“${title}” ${state === 'done' ? 'is done' : 'waits for you'}${at ? `, at the latest ${at}` : ''}`,
    woke: (why: string) => `Woke up: ${why}`,
    wokeWhy: {
      time: 'the time has come',
      owner: 'woken by you',
      news: 'news for the agent',
      needsYou: 'the card needs you',
      card: (title: string, met: Awaited, state: AwaitedState) =>
        `“${title}” ${{ reached: state === 'done' ? 'is done' : 'waits for you', gone: 'is gone', archived: 'was archived', stopped: 'was stopped', dropped: 'was dropped' }[met]}`,
    },
    parked: 'Stopped the app in the workspace while the card waits. The agent starts it again when it needs it.',
    parkKept: 'The app in the workspace keeps running while the card waits: it holds data that should stay. To have it stopped anyway, tell the agent.',
    parkFailed: (output: string) => `Stopping the app in the workspace failed: ${output}`,
    /** The page the owner's browser gets for a card whose app no longer runs. */
    appGone: 'The app of this card no longer runs. To have the agent start it again, tell it on the card.',
    stoppedPrOpen: (n: number) => `Stopped. Pull request #${n} stays open.`,
    restartDue: (pause: Pause) => `Obeya is about to ${pause === 'stop' ? 'stop' : pause === 'repo' ? "restart this repository's agents" : 'restart'}; the agent pauses at the next safe point.`,
    restartWaits: (pause: Pause) =>
      pause === 'stop'
        ? 'Obeya waits to stop; the agent goes on once Obeya runs again.'
        : pause === 'repo'
          ? "Obeya waits to restart this repository's agents; the agent goes on after that."
          : 'Obeya waits to restart; the agent goes on after the restart.',
    restartStillDue: (pause: Pause) => `The agent woke before Obeya's ${pause === 'stop' ? 'stop' : 'restart'}; Obeya tells it the ${pause === 'stop' ? 'stop' : 'restart'} still waits for it.`,
    limitResumes: (when: string) => `The agent goes on by itself ${when}.`,
    limitRetries: (when: string) => `Obeya tries again ${when}.`,
    paused: (pause: Pause) => (pause === 'stop' ? 'Paused until Obeya runs again.' : pause === 'repo' ? "Paused until this repository's agents restart." : 'Paused until Obeya has restarted.'),
    hostLost: (host: string) => `The connection to ${host} is gone; the agent goes on once ${host} can be reached again.`,
    hostBack: (host: string) => `${host} can be reached again; the agent goes on.`,
    stalled: 'The agent stopped without being done.',
    unanswered: 'The agent stopped without answering your message. Write again and it goes on.',
    remainsUndone: (reason: string) => `${reason} What was left to do after the landing is not done; “Stop” closes the card without the rest.`,
    tryAgain: 'Try again',
    denied: (what: string, by: string, reason?: string) => `Not allowed (${by}): ${what}${reason ? ` — ${reason}` : ''}`,
    deniedBy: {
      rule: 'a rule in the settings',
      classifier: "auto mode's classifier",
      mode: 'the permission mode',
      hook: 'a hook',
      obeya: 'Obeya: waiting in the foreground',
      other: 'no reason given',
    },
    permission: (what: string, reason?: string) => `The agent wants to do this, and the settings ask for your confirmation:\n\n${what}${reason ? `\n\nWhy it asks: ${reason}` : ''}`,
    allow: 'Allow',
    deny: 'Deny',
    limitStatus: 'Usage limit',
    limitStatusUntil: (when: string) => `Usage limit · continues ${when}`,
    proposesBuild: (reason: string) => `Proposes building the idea on this prototype: ${reason}`,
    proposedIdea: (title: string) => `Proposed an idea: ${title}`,
    proposedCard: (title: string) => `Proposed a task: ${title}`,
    withdrewProposal: (title: string, why?: string, by?: string) =>
      by ? `Replaces the proposal “${title}” by “${by}”${why ? `: ${why}` : '.'}` : `Withdraws the proposal “${title}”${why ? `: ${why}` : '.'}`,
    superseded: (by?: string, why?: string) =>
      by ? `The agent that proposed this card replaced it by “${by}”${why ? `: ${why}` : '.'}` : `The agent that proposed this card withdrew it${why ? `: ${why}` : '.'}`,
    prOpened: (n: number) => `Pull request #${n} opened.`,
    landing: 'Landing on main',
    waitsForRestart: 'Waits for Obeya to restart with the new version',
    needsClone: 'Needs a full clone to answer',
    waitsForWorkspace: 'Waiting for a workspace',
    waitsForClone: 'The follow-up waits for the next free clone and then goes on by itself.',
    cloneFree: 'A clone is free: the agent goes on answering there.',
  },
  pr: {
    checkFailed: (names: string) => `Check failed: ${names}. The agent looks into it.`,
    conflict: 'Conflict with the base branch. The agent brings the branch up to date.',
    stale: 'New commits since the last review, and nobody asked for another one. The agent asks for it.',
    held: (by: string, score: string) => `Ready to merge, but ${by} gives only ${score}: below 4/5 Obeya does not merge by itself. Your call.`,
    ready: 'Ready to merge: checks green, all comments resolved, the review is through. Obeya merges.',
    mergeFailed: (reason: string) => `Obeya could not merge: ${reason}`,
    unreadable: (reason: string) => `Obeya cannot read the pull request: ${reason}`,
  },
  idea: {
    buildAfterReply: 'Build it once the reply is there; if the agent still asks something, it is not built.',
    buildAnswer: 'Build it as the idea stands.',
    buildLog: 'Build it: where the idea stands is the task.',
    unbuild: 'Not building it after all.',
    notBuiltNoReply: 'Not built: the reply did not come.',
    notBuiltQuestions: 'Not built: the agent still has questions.',
    notBuiltQuestion: 'Not built: the agent still has a question.',
    buildOnAnswer: (prototype: string) => `Build it, on the prototype “${prototype}”.`,
    buildOnLog: (prototype: string) => `Build it, on the prototype “${prototype}”: its branch is now this task’s.`,
    whichPrototype: (workstream: string) => `Which prototype does ${workstream} build on?`,
    onPrototype: (prototype: string) => `On the prototype “${prototype}”.`,
    workstreamOnLog: (prototype: string) => `Build on the prototype “${prototype}”: its branch is now this workstream’s.`,
    splitOffAnswer: (task: string) => `Split off a task: “${task}”.`,
    splitOffLog: (task: string) => `Task split off: “${task}” is now a task of its own; what is open stays here.`,
    settledTask: (idea: string) => `The part of the idea “${idea}” that is settled. What is still open there, the idea goes on discussing; it is not part of this task.`,
    settledFrom: (idea: string) => `Split off from the idea “${idea}”.`,
    howOn: (idea: string) => `Idea “${idea}”: how to go on?`,
    howOnTask: (task: string) => `Task “${task}”: how to go on?`,
    planDocAnswer: 'As a project: a plan doc with workstreams first.',
    planDocLog: 'As a project: an agent writes the plan doc; once it has landed, the project takes the idea’s place.',
    planDocTaskLog: 'As a project: an agent writes the plan doc; once it has landed, the project takes the task’s place.',
    dropped: 'Dropped.',
    parked: 'Parked.',
    planDocTask: (dir: string, task = false, file?: string) =>
      `Write a plan doc ${file ? `as \`${file}\`, in a folder of this machine outside the repository,` : `in \`${dir}/\``} from ${task ? 'this task' : 'where this idea stands'}, following the repository’s conventions (existing plan docs as the model). It needs a \`## Goal\` (or \`## Ziel\`) and a checklist under \`## Workstreams\` (\`- [ ] **W1:** Title. Details\`), cut into packages that can land one by one; then Obeya shows it as a project that takes the place of this ${task ? 'task' : 'idea'}. Build none of it; only the plan doc${file ? '' : ' (and a link to it where the repository links plan docs)'}.`,
    planDocIdea: (title: string) => `Idea: “${title}”`,
    planDocCard: (title: string) => `Task: “${title}”`,
    planDocPrototypes: (n: number) =>
      `This idea already has ${n > 1 ? `${n} prototypes` : 'a prototype'}. They stay on the canvas; once the project stands, the owner picks one of them (“Build this prototype”), and the workstream that builds on it is built on its branch. So do not plan them again as workstreams; take what they showed into the plan doc. Only the workstream that builds on the chosen prototype mentions prototypes: that is how Obeya knows which workstream is built on the prototype’s branch.`,
    planDocHandedOver: (title: string, summary: string) => `“${title}”, handed over like this:\n\n${summary}`,
    planDocInProgress: (title: string) => `“${title}”: still in progress.`,
    onlyThisVariant: (others: string) => `Only this variant: ${others} get prototypes of their own.`,
    showAsItStands: 'Show the idea as where the idea stands describes it.',
    prototypeTitle: (idea: string) => `Prototype: ${idea}`,
    prototypesStarted: (titles: string) => `Prototypes started: ${titles}.`,
    prototypeStarted: (title: string, what: string) => `Prototype “${title}” started${what ? `: ${what}` : ''}.`,
    prototypeReady: (title: string, demo: boolean) => `Prototype “${title}” is ready${demo ? '; its demo is here' : ''}.`,
    reopened: 'Idea taken up again.',
    briefUpdated: 'Updates where the idea stands',
    plansPrototypes: (approaches: string) => `Plans prototypes: ${approaches}`,
    plansNoPrototypes: 'Plans no prototypes any more',
    plansSplit: (task: string) => `Marks a task to split off: “${task}”`,
    plansNoSplit: 'Marks no task to split off any more',
    decision: (question: string, answer: string) => `Decision: ${question} → ${answer}`,
    becameProject: 'The project now stands in the idea’s place; the idea is in the archive.',
    taskBecameProject: 'The project now stands in the task’s place; the task is in the archive.',
    partLanded: 'Part landed; the plan doc keeps it open.',
    briefName: 'Where the idea stands',
    prototypeButton: 'Have a prototype built',
    splitOffButton: 'Split off a task',
  },
  proposal: {
    acceptAfterRevision: (how: 'start' | 'discuss' | 'asIdea') =>
      `${{ start: 'Accept and start', discuss: 'Accept and discuss', asIdea: 'Discuss as an idea' }[how]} once the proposal is revised; if it still has questions, it stays a proposal.`,
    notAccepting: 'Not accepting it after all.',
    notAcceptedNoRevision: 'Not accepted: the revision did not come.',
    notAcceptedQuestions: 'Not accepted: the proposal still has questions.',
    notAcceptedQuestion: 'Not accepted: the proposal still has a question.',
  },
  koordinator: {
    allStarted: (names: string) => `All workstreams started: ${names}. Obeya decides their order.`,
    startedDespite: 'Started despite the overlap.',
    startTakenBack: (names: string) => `Start taken back: ${names}.`,
    dequeued: 'Taken out of the queue.',
    movedBefore: (title: string) => `Moved ahead of “${title}” in the queue.`,
    movedAfter: (title: string) => `Moved behind “${title}” in the queue.`,
    proposes: (rule: string) => `Proposes: “${rule}”`,
    nothingRuns: 'Nothing is running; it starts right away.',
    estimateFailed: (why: string) => `Obeya could not estimate the scope (${why}); the task starts anyway.`,
    noConflict: 'No merge conflict with work in progress expected.',
    waitsAhead: (title: string) => `“${title}” (waiting itself, and ahead in the queue)`,
    likelyConflict: 'Likely merge conflicts with work in progress.',
    waitsFor: (names: string, reason: string) => `Obeya: waits for ${names}. ${reason}`,
    togetherFailed: (why: string) => `Obeya could not plan the workstreams together (${why}); it checks them one by one.`,
    togetherStarts: 'Planned together with the other workstreams; starts now.',
    planned: (started: number, of: number) => `Planned: ${started} of ${of} workstreams start now, the others wait.`,
    says: (why: string) => `Obeya: ${why}`,
    workspaceFree: 'A workspace is free; it starts.',
    slotFree: 'A machine has a free slot again; it starts.',
    waitedDone: 'What it waited for is done; it starts.',
    waitedDoneRecheck: 'Obeya: what it waited for is done; checks it again against the work in progress.',
    noWorkspace: 'No workspace free: all are taken or none is set up. The task starts as soon as one is free.',
    dirtyWorkspaces: 'No workspace free: every free one has uncommitted changes. The task starts as soon as one is clean.',
    noSlot: 'No slot free: every machine with a free workspace has as many agents at work as it has slots. The task starts as soon as one is done.',
    ruleTaken: (rule: string) => `Rule added: “${rule}”`,
    revised: 'Proposal revised.',
    reviseFailed: (why: string) => `Revising did not work: ${why}`,
  },
  claudeMd: {
    title: 'Add to CLAUDE.md',
    task: 'The owner set these rules for this repository. Work them into the CLAUDE.md, fitting what is there (section, tone, length) and without repeating anything; where one is in it already in other words, only sharpen that place. Change nothing else. Instead of a demo, the new wording in the summary is enough.',
  },
  retro: {
    friction: (notes: string) => `Work retrospective, friction noted:\n${notes}`,
    note: (what: string, cost: string, fix: string) => `– ${what} Cost: ${cost} What would have prevented it: ${fix}`,
    nothingToRead: (repo: string) => `Work retrospective for ${repo}: no friction to read since the last one.`,
    occasion: (why: string) => `Occasion (work retrospective): ${why}`,
    from: (repo: string, why: string, cards: string) => `From the work retrospective for ${repo}. ${why} Cards: ${cards}.`,
    done: (repo: string, made: number) =>
      `Work retrospective for ${repo}: ${made ? `${made === 1 ? 'one proposal' : `${made} proposals`}, on the canvas and with Obeya.` : 'nothing that recurs on several cards.'}`,
    settings: { checks: 'Checks', setup: 'Setup', softPaths: 'Soft paths', run: 'How to run the app' },
    onMachine: (setting: string, repo: string) => `“${setting}” for ${repo} now applies on this machine.`,
    committed: (setting: string, repo: string, branch: string) => `“${setting}” for ${repo} is now in .obeya/settings.json on ${branch} and applies to everyone.`,
    opened: (setting: string, repo: string, pr: string) => `“${setting}” for ${repo}: pull request opened, ${pr}. Until it is merged, the value applies on this machine.`,
  },
  share: {
    share: 'Share: the page goes online.',
    again: 'Share again: the page is made anew.',
    newDemo: 'Replace on the page: the page now shows this demo instead of the shared ones.',
    added: 'Add to the page: the page gets this demo as an addendum.',
    unshare: 'Stop sharing: the page is withdrawn.',
    unshareOne: 'Stop sharing: the page goes online again without this demo.',
    againWithOthers: 'Share again, with other shared demos: the page is made anew.',
    approved: (how: 'share' | 'replace' | 'add'): string =>
      how === 'share'
        ? 'Shared with the approval: the page goes online.'
        : how === 'add'
          ? 'Added to the page with the approval: the page gets the latest demo as an addendum.'
          : 'Replaced on the page with the approval: the page now shows the latest demo instead of the shared ones.',
    notOnApproval: 'Not shared with the approval: “Share on approval” was unticked.',
    notAgain: 'Not shared again',
    notLinked: 'The link to the pull request did not get onto the page',
    notShared: 'Not shared',
    demoGone: 'A demo the page shows is gone; “Replace on the page” brings the task’s latest.',
    linkLater: 'The shared page gets the link to the pull request with the next share.',
    noDemo: 'The task has no demo any more, or its repository shares none.',
    sharedAgain: (url: string) => `Shared again: ${url}`,
    linksPr: (url: string) => `The shared page now links the pull request: ${url}`,
    shared: (url: string) => `Shared: ${url}`,
    prLinked: (n: number | undefined) => `Added the demo’s link to the description of pull request #${n}.`,
    prNotLinked: (n: number | undefined, why: string) => `Did not add the demo’s link to pull request #${n}: ${why}`,
    notWithdrawnNoShare: 'Not withdrawn: the task’s repository no longer shares demos.',
    withdrawn: 'The page is withdrawn.',
    pageIncomplete: 'The page lacks a title, a text or the demo’s directory.',
    fileMissing: (file: string, dir: string) => `${file} is missing in ${dir}.`,
    fileTooLarge: (file: string, mib: string, max: string) => `${file} is ${mib} MiB; the site takes at most ${max} MiB per file.`,
    siteLacks: (dir: string, slugs: string[]) =>
      `Not deployed: ${dir} lacks ${slugs.length === 1 ? 'a page' : `${slugs.length} pages`} Obeya has as shared (${slugs.join(', ')}); a deploy would take ${slugs.length === 1 ? 'it' : 'them'} offline. Restore the directory first.`,
    envMissing: (file: string) => `${file} is missing on this machine.`,
    deployFailed: (code: number) => `The site’s deploy failed (exit code ${code}).`,
    notWithdrawn: (why: string) => `Not withdrawn: ${why}`,
    manifestUnreadable: (url: string, why: string) =>
      `The site’s manifest could not be read (${url}: ${why}). Without it a deploy might take pages other machines shared offline.`,
    loginWall: (status: number) => `HTTP ${status}, a redirect to a login; the site’s headers are missing or wrong`,
    notManifest: 'not a manifest',
    headerKey: (key: string, header: string) => `The site’s header ${header} needs ${key}, which the site’s env file lacks.`,
    pulling: (pages: number, mib: string) => `Downloading ${pages === 1 ? 'a page' : `${pages} pages`} other machines shared from the site (${mib} MiB) …`,
    pulled: (done: number, of: number) => `Downloaded ${done} of ${of} pages.`,
    downloadFailed: (file: string, why: string) => `${file} could not be downloaded from the site (${why}).`,
    downloadBad: (file: string) => `${file} from the site does not match its manifest.`,
    cameBetween: 'Another machine’s deploy came in between; one more round.',
    lostTwice: 'Another machine’s deploy came in between twice; the site does not show the change. Please try again.',
    notSeenYet: 'The site does not show the new state yet; the next deploy checks again.',
    withdrawnElsewhere: (machine: string) => `The page was withdrawn on another machine (${machine}); the link is gone.`,
    restored: 'The page was missing on the site: another machine’s deploy had taken it offline. Obeya deployed it again.',
    notRestored: (why: string) => `The page is missing on the site (another machine’s deploy took it offline) and was not deployed again: ${why}`,
    exported: (zip: boolean, name: string) => `Exported as ${zip ? 'ZIP' : 'HTML file'}: ${name}`,
    rebuilt: (language: 'de' | 'en') =>
      `The demo was narrated anew in its directory, in ${language === 'en' ? 'English' : 'German'}: the task shows it with its new chapters, and its page’s text is written again when it is shared.`,
    prLine: (html: boolean) => (html ? 'Demo page' : 'Demo video'),
  },
  welcome: {
    title: 'First task: change something small',
    body: 'Write into this card what an agent should do in this repository, for example: “Add to the README how to start the project.” Then “Start agent”: it works on a branch of its own, asks when something is not its to decide, and shows you a demo at the end. You approve it or write what is still missing.\n\nMore tasks come from “+ New task”, or you say them: hold Space and speak. “Configuration” → “Check setup” checks again later what Obeya needs on this machine.',
  },
  adapterSetup: {
    title: (repo: string) => `Set up Obeya for ${repo}`,
    body: "With the skill `obeya:settings`, fill in this repository's settings for everyone (`.obeya/settings.json`, shown in the configuration under “Settings” as “from the repository”): which checks run, how work lands, how an agent runs the app (starting it, after a change, for a demo), how Obeya stops it, and where the plan docs are that Obeya shows as projects. If the repository still has a `.obeya/adapter/`, move what it says into the settings and delete it. Ask me what you cannot find out in the repository (login, test data).",
  },
  preparePlanDoc: {
    title: (file: string) => `Prepare ${file.slice(file.lastIndexOf('/') + 1)} as a project`,
    body: (file: string) =>
      `Prepare \`${file}\` so that Obeya shows it as a project. Obeya reads a plan doc as a project when a checklist stands under \`## Workstreams\` (or \`## Arbeitspakete\`): each top-level item is a workstream (\`- [ ] **W1:** Title. Details\`), a package that can land on its own, and a ticked one has landed. The project's goal is the first paragraph under \`## Goal\` (or \`## Ziel\`).\n\nAdd the checklist, and the goal if it is missing, in the doc's own style, from what it plans. If the doc already keeps its tasks under another heading (Tasks, Milestones, Phases), that becomes the checklist instead of a copy of it. Tick what is already done; if everything is, tell me, since a project whose workstreams are all ticked goes straight to the archive. The rest of the text stays, and nothing of it is built.`,
  },
  notOwner: {
    title: 'Not signed in · Obeya',
    heading: 'This browser is not signed in to Obeya',
    how: 'Open the link Obeya prints in its terminal when it starts (“Obeya … on http://127.0.0.1:…/login?token=…”). It holds until Obeya restarts; then Obeya prints a new one, and also when you start it again while it runs. In the app, “Open in browser” (in the settings) opens Obeya signed in in the browser.',
    used: 'This link no longer holds: Obeya has restarted since, or it was for a single browser.',
  },
  notPaired: {
    title: 'Not connected · Obeya',
    heading: 'This device is not connected to Obeya',
    how: "On the computer Obeya runs on: the phone icon at the top of the bar, then scan the QR code with this device's camera. Or type the code shown there here:",
    code: 'Code',
    pair: 'Connect',
    wrong: 'This code is wrong or has expired. “Connect a phone” on the computer shows a new one.',
  },
  push: {
    demo: 'Demo ready',
    review: 'Ready for review',
    answered: 'The agent answered',
    question: 'A question for you',
    stuck: 'The agent is stuck',
    landing: 'Landing failed',
    proposal: 'Proposal from an agent',
    superseded: 'Withdrawn or replaced by its agent',
    pr: 'A PR waits for you',
    idea: 'Idea · your turn',
    several: (n: number) => `${n} cards wait for you`,
  },
};

export const MESSAGES: Record<Language, Messages> = { de, en };

/** Until when a card is snoozed, in the words of `m`: a time, or the card it waits on (with a time, when it has one too). */
export const snoozeTerm = (m: Messages, s: Snooze) => (s.on ? m.worker.awaits(s.on.title, s.on.state, s.until ? m.at(Date.parse(s.until)) : undefined) : m.at(Date.parse(s.until!)));
