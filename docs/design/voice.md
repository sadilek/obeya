## Voice

A chapter of the [design doc](../design.md), whose header says how it is written.

### Voice in

Push-to-talk: hold Space or the mic button in Obeya's window. The browser records and posts the
audio with its focus (the open card, the project in view).

#### Dictating or sending

The cursor decides. In a text field under a conversation (a card's, Obeya's sidebar's) the words are
dictated into it at the cursor and nothing is sent; the owner adds to them and sends with Enter.
Elsewhere they go out at once, with what stands in the field of the card in view (or of the sidebar
with no card open): its words before the spoken ones, its screenshots, the message it quotes; the
field empties, and gets them back when nothing was heard. A click into the field or beside it
switches.

A dictation starts from the microphone in the field, the microphone at the bottom (pressing it keeps
the cursor where it is), or Space held in the field. Space in a field is held back: released within
250 ms or overlapped by another key (fast typing), it is typed; held longer it records, and released
before a recording would count (600 ms in all) it is typed after all. While Space is down the field
is read-only: Chrome on the Mac hides the pointer at every key pressed into an editable field, and
the repeating key made it flicker.

A field being spoken into is framed, and the line under it and the microphone says „→ ins Feld ·
abschicken mit Enter“, then „Wird aufgeschrieben …“; nothing heard leaves the field as it was and
says so. Otherwise the line under the microphone names who hears the words and what goes with them
(„→ Agent · Aufgabe: … mit Text und 1 Screenshot“).

#### Drafts

A field's draft (text, screenshots, options picked for the questions above it, the quoted message)
lives outside the field, so the microphone reads and writes it and it outlives closing the card.
Picks count only while the same questions stand. Drafts are kept per tab and canvas in session
storage as they change, so they survive a canvas switch and a restart.

#### The microphone

The log has each recording's length and level beside its transcript. While the key is held, a level
flat for 1.5 s shows „Das Mikrofon liefert keinen Ton.“. The first press after a page load opens
the microphone (0.2–0.3 s); released before it is open, nothing is recorded (rather than a recording running on unheld) and the owner is told
„Das Mikrofon war noch nicht bereit“.

A recording without audible speech gives „Ich habe nichts gehört.“, one Whisper cannot make sense of
„Das habe ich nicht verstanden.“; the Koordinator gets neither to guess from. Whisper fails on such
recordings in recognisable ways (the card titles talk it into loops or guesses; it writes its
phrases for silence), and where the titles may have misled it, it hears the recording again without
them (`voice/transcribe_sidecar.py`).

### Speech recognition

A sidecar keeps the model loaded. Every backend gets the recording decoded by ffmpeg and its Python
from `OBEYA_WHISPER_PYTHON` (a Python with the package) or else from uv.

The default everywhere, the Mac included, is Parakeet TDT 0.6B v3: int8 ONNX through `onnx-asr` on
the CPU, without PyTorch or MLX, about 640 MB, capped at 4 threads (12 were three times slower). It
hears 25 European languages without a language pass, takes no prompt (the Koordinator reads its words
with the card titles in mind) and does not loop or invent phrases on silence. A recording over a
minute is heard in parts of at most 60 s, each cut at the quietest moment of its last 20 s: Parakeet's
memory grows with the length it attends to (1.8 GB for 57 s).

#### Whisper

`OBEYA_WHISPER_BACKEND` picks Whisper instead: `mlx`, `faster`, or `whisper` for the platform's
(mlx-whisper on Apple Silicon; elsewhere faster-whisper, on CUDA with a GPU and its libraries, else int8 on the CPU, as float32
took twice as long),
large-v3-turbo unless `OBEYA_WHISPER_MODEL` says otherwise. It gets the card titles as vocabulary and
transcribes in the language it hears in the first 30 s, German or English, not the interface's. With
faster-whisper the first window's encoder output both tells the language and is handed to that
window's decode (its `generate_segments` accepts it, `transcribe` does not), so a short command costs
one encoder pass; its own `multilingual` picks from all languages and hears short German as Dutch.

#### A cloud service

Where the machine is too slow, the recordings go to a cloud service (see The Spracheingabe settings)
as they came from the browser, with the card titles as a prompt where it takes one. A failure,
refusal or no answer within 30 s says so under the mic („Groq hat die Aufnahme nicht erkannt (401:
Invalid API Key).“), and the words stay in the field.

#### The Spracheingabe settings

The configuration dialog's section „Spracheingabe“ checks the recognition (package, model), ffmpeg
and uv, each missing piece with how to install it here. „Installieren“ fetches and loads the
recognition (about 710 MB for Parakeet, 1.8 GB for Whisper), so the first command does not wait for
it, then times it on a short German sentence Obeya ships, twice, the faster run counting (the first
after loading is slower). The line reads „Parakeet · 0,3 s für einen kurzen Satz“, or, over one
second per second of speech, „zu langsam“, which opens the cloud offer; „Erneut messen“ measures
again. The setup assistant's „Sprachbefehle“ shows the same line.

The cloud offer („Über einen Cloud-Dienst erkennen“, a link under the line also when the machine is
fast enough) is one client for the OpenAI-style
`/audio/transcriptions` endpoint with three presets: Groq (whisper-large-v3-turbo, first: a free tier
without a card, takes a prompt), Mistral (Voxtral Mini Transcribe, EU-hosted, no prompt), and any
OpenAI-compatible endpoint by address and model. Each says that recordings leave the machine and
links to where its key is had; „Testen“ sends the shipped sentence and, once it comes back written,
uses the service from the next recording on. With a service in use nothing local is needed; the line
names it, with „Wieder auf diesem Rechner erkennen“. The measurement (per backend), base URL, model
and key are kept per machine in `voice.json` in Obeya's home (readable by the owner alone), never in
a repository; the page only learns that there is a key.

The server lets a request idle for 120 s instead of Bun's default 10 s: a command answers once it is
transcribed and read, which on a busy CPU took longer.

### Who hears the words

The line under the mic names who hears ("Agent · Aufgabe: …", "Agent · Idee: …", "Obeya · Aufgabe:
…", "Obeya · Projekt: …"; under a card's text field only when Obeya reads rather than the card's
agent), and the words go exactly there: label and route follow one rule.

On a card an agent listens on (a worker at work, waiting, in a pull request or finishing after the
landing; the one a question resumes on a finished card; a prototype's worker; an idea's exploration
agent; the agent reworking a proposal), typed words go straight to it at once, spoken ones once
written down, with their screenshots, as do clicks on answer options. By the card's state that is
talk to an idea, an answer, or words the worker takes in (see Waiting for approval and Questions
after the work). Spoken words carry the remark that speech recognition may have misheard them. They
stand in the conversation under „Du“ at once; nothing waits for „Rückgängig“.

On any other card (planned, queued, finished without an agent), with a project open or nothing, the
Koordinator reads the words with that card or project in focus.

#### Passing a request on to Obeya

Words that ask Obeya rather than the agent (approve, pause, stop, start, a follow-up or new card,
"Merk dir", grouping, an action on another card, a question about the canvas or another card) the
agent passes on with `to_obeya(request)`, one tool shared by workers, prototypes' workers and
exploration agents. The Koordinator reads the request with the owner's own words beside it (the
newest on the card after a restart) and the card in focus, as any command. Where the owner has said
nothing on the card yet, the task stands in for their words if the owner gave it (typed it, had the
Koordinator write it, or accepted an agent's proposal): "lege ein Repo und einen Canvas dafür an"
becomes a task ending in a request for the canvas, which the Koordinator then creates, unless it
already waits on the card for that step (see A step once a card gets somewhere). An unaccepted
proposal is no such task: words an agent read in a proposal, a file or a pull request comment are no
request of the owner's.

The result is actions with a confirmation and „Rückgängig“ (above the mic, as a notice on every open
page, in the card's conversation), a reply or a look-up, returned as the tool's result. Nothing goes
back to the agent as a note, answer or feedback (refused if it tries): it has the words. In the card's
conversation Obeya's reply stands under the agent's message its passing-on leads to (see The
conversation). An agent at
work may see the words only at its next tool call, so "gib frei" typed on a card costs a turn of
several seconds where the button „Freigeben“ is immediate.

### Commands to the Koordinator

A Koordinator turn reads the transcript as speech that may be misheard (typed words as written, and
it knows which, and in which field) and either acts or replies. One sentence may give up to 20
actions: new card, new idea, a review card for a pull request, start, out of the queue, note, answer, feedback, approve, accept,
dismiss, revise, stop, remember, Arbeitsrückschau, grouping and ungrouping cards, renaming a group,
`configure` (see The Konfiguration dialog), `wish` (see Wishes for Obeya's makers), `wait_for` (see A
step once a card gets somewhere); on ideas discuss, build, plan doc (also for a planned task nobody
has worked on), prototype, park, drop; on prototypes build on it, discard. Actions are checked
against the cards' states; one that does not fit goes back to the Koordinator, which may reply
instead.

#### New cards

A new card, a follow-up too, starts at once like "Agent starten" (conflict check, queue), unless the
owner says it should wait („nur notieren“, „für später“, „noch nicht starten“). One the owner names a
time for („Anfang Dezember“, „in zwei Wochen“) is planned and snoozed until then, starting by itself
at the time like a planned card the owner snoozed (see Snoozing a card); a day without an hour means
08:00 that day. Work on the machine
that changes no code (creating a repository, installing a tool, converting files) is a card too: its
agent has the shell and asks the owner's permission.

A new card or idea lands in view, centred where the pointer was when the owner stopped speaking or
sent the words, else in the middle of the view, moved to the nearest free spot wholly in view; with a
card or project open, in the view closing it returns to. A follow-up goes below the card it follows.
What comes without a pointer (a request an agent passed on) uses the view a page last reported: each
page reports it over its WebSocket on every change and when its window gets the focus back. The
camera flies only when the card landed out of view.

A new card or idea may go onto another canvas the owner names („leg auf Super 59 eine Aufgabe an“),
into that canvas's home repository, with the command's screenshots; the Koordinator hears the other
canvases' names with every command. A follow-up made there names the card it follows here, with its
canvas. „Bau das in einem neuen Repo unter ~/dev/super59“ builds an idea, or starts a planned task
nobody has worked on, in a new repository (see Building in a new repository); the card's own undo
window follows the command's.

Asking for an opinion or a way forward, with no agent on the open card, makes an idea with the
owner's words (see Ideas); a question of fact gets a reply. With a card open the Koordinator gets its
worker's whole summary, so "lege eine Folgeaufgabe für den ambient-Ton an" gets the context from it.

#### Other commands

Start on a queued card starts it now despite the conflict, like "Trotzdem starten"; the Koordinator
sees what queued cards wait for ("starte alle wartenden Aufgaben"); "nimm sie aus der Warteschlange"
takes a card back to planned. Replies answer questions ("Was ist seit gestern passiert?") as far as
the cards and their history do.

„Review PR #5“ (or a pull request's link, „schau dir den PR an“) makes a review card for a
contributor's pull request and starts it; a number is the PR of the card's repository (the first on
a canvas with several, unless the owner names one). What the owner adds („schau besonders auf
Security“) becomes its task. A PR with a card already opens that card, unless the owner has another
one open, and the words go to its worker; one Obeya cannot read, or closed, gets none, and the owner
reads why. On a canvas with a repository whose origin is on a server, one muted line under Obeya's
field names the command until a review card was there once or the owner closes it with × (see
Review cards); it stays quiet since the feature is a special one (the owner, 2026-10-27).

"Merk dir: …" is remember, with the open card as occasion, after the undo window (see Learning the owner's
rules).

What the owner says to the Koordinator about a proposal is, in doubt, a revision; accepting in the
same breath or while it is reworked is refused, so the owner sees what they take. A note, answer or
feedback the Koordinator passes on („sag dem Export, …“) waits for undo like every command to Obeya; spoken, it carries the remark that it may be misheard.

#### A step once a card gets somewhere

What can only follow once a card gets somewhere (starting „Login“ once „Export“ has landed, a new
card on another canvas once a task here is done) the Koordinator waits for, as a worker snoozes: `wait_for`
on a card, or on a new card of the same act, until it is done (default) or waits for the owner, with
the step written to stand on its own (cards named by title, since another session tags cards anew). A card already there or a step without
text is refused. The waited-on card's agent may read the step in its task; it asks Obeya for it in
vain (nothing is passed on without the owner's words, and the answer says Obeya takes that step). The
wait outlives a restart, and the Koordinator sees its waits with every command and drops one on the
owner's word.

On every board change, every 15 s and at start, waits whose card got there, or no longer can by
itself (stopped, archived, removed, dropped), are taken up by an exchange without words of the
owner's: the Koordinator hears what it meant to do and what became of the card (a card done also
counts for a wait until it waits for the owner), and acts or replies. The wait goes only once that
is decided, so a restart retries it and dropping it meanwhile takes back the decision; several steps
on one card each stand, and the usage limit holds such a turn as it holds the owner's words. The reply reaches the owner as a notice, „Rückgängig“ where it
acts, and stands where the waiting exchange was (the sheet, or the card then open). In the sheet the
announcing reply carries „◷ Wartet, bis „Repository anlegen“ erledigt ist“ (or „… auf dich wartet“)
with „Nicht mehr warten“; the exchange that takes it up opens with „„Repository anlegen“ ist
erledigt“ (or what else happened) in place of the owner's words.

#### Confirmation and undo

One confirmation covers all actions of a command; they run in order a few seconds after it reached
the owner, so „Rückgängig“ takes back anything, an approval included. A page opened in that window
shows the confirmation with „Rückgängig“ for the rest of it. Only talk to an idea goes on at once: it
changes nothing.

The owner's words to the Koordinator show at once (spoken ones once written down) in the conversation
of the open card, or else in the sheet, with „Obeya liest …“ until the confirmation follows (folded
away on a card), and „Zurückgenommen.“ when taken back. A reply that answers without acting stands in
the conversation, also for words an agent passed on. Words being read when Obeya stopped get a reply
that says so.

Words the usage limit keeps from the Koordinator wait as a worker does (see Turns that end without a
handover): the reply says when („Ich lese das um 19:20 von selbst.“), the sheet shows „Nutzungslimit
· liest das um 19:20 von selbst“, and after the reset they are read knowing when they were said, the
reply coming as a notice. Later words queue behind held ones. Held words survive a restart.

#### Commands on their way

The microphone is free at once after letting go, and the owner may navigate or speak again: the
target is fixed when the key goes down. Each recording gets a line above the microphone („„Export“ ·
wird verstanden …“, for a card's agent „… · wird aufgeschrieben …“) that becomes its confirmation with
„Rückgängig“, or disappears when the words went to the open card's agent. Several stack, oldest
first; the server reads them in order. A typed command gets no line while read (its conversation
shows it), except one typed in the configuration dialog. A confirmation for a card other than the
open one, for a request an agent passed on, or an answer looked up starts with the card it is about.
A reply standing in the open sheet gets no line, unless it has „Rückgängig“, which the sheet lacks;
nor does an answer Obeya looked up while the conversation of the card it stands on is open (on the
phone, that card's conversation panel).

### Voice latency

Pressing Space (or focusing a field the Koordinator reads) prepares while the owner speaks: the
sidecar loads its model (not with a cloud service) and the Koordinator's session starts (one that
fails is replaced once, for the same command). From letting go to the confirmation takes about
2.8 s on a small canvas, the first command after a start included, 2 s of it the Koordinator's turn;
the undo window starts with the confirmation.

### No voice out

Obeya does not speak. Confirmations and answers are written: in the card's conversation, the
Koordinator's sheet and the line above the mic. Demo narration is separate (see Demos).

### Decisions

- **Push-to-talk only in Obeya's window** (owner, 2026-10-29). Rejected: a key held while another
  app is in front, heard and recorded by the app's shell, which sent the command to wherever the
  owner had last been in Obeya: from the other app the owner could not tell which canvas and card
  that was.
- **The focus decides between dictating and sending** (2026-10-12). Rejected: always dictating (two
  steps per message), always sending at once (lost what was typed), a field in view deciding (on a
  card one almost always is, also when the owner wants to send at once).
- **The microphone opens on the first press, not on page load**: in the log of 1–5 Oct 2026 first
  recordings after a load failed no more often, and an early open keeps the browser's microphone
  indicator on.
- **Parakeet everywhere, the Mac included** (2026-10-14): 8 s of German on an M4 Pro took 0.23 s
  against 4.4 s for faster-whisper on the same CPU threads and 0.93 s for mlx-whisper on the GPU, same
  text; on a small fanless Windows box Whisper took about a minute. Whisper stays optional. Rejected:
  a smaller Whisper (misheard German), Moonshine (English only), the browser's recognition (missing
  in the Windows webview; silently sends audio to Google). Too slow even so: a cloud service, Groq
  first (free), Mistral (EU), or any OpenAI-compatible endpoint.
- **Whisper hears the spoken language, not the interface's** (2026-10-08): told to expect English it
  translated German into broken English, and long dictations ended in „not understood“.
- **Python sidecars come through uv on first use**, for voice and demos, app and checkout alike
  (2026-10-06). Rejected: bundling Python (hundreds of MB per platform, different per GPU, every
  native library signed and notarised), while the models, the large part, download on first use
  anyway.
- **Commands to Obeya are read by the Koordinator, not matched by rules, and wait a few seconds for
  undo** (2026-10-05). Exempt: talk to an idea and what the owner says to the open card's agent
  (feedback included, which keeps the approval, see Waiting for approval): it only adds to what the
  agent knows, and Send or letting go of Space is the deliberate act.
- **A confirmed command outlives the server** (2026-10-12): it waits for undo in the database; a stop
  or restart in the window leaves it to the next start, which runs it when the window is over: the owner has the confirmation and expects the card. A
  command that began to run is out of the database, so nothing runs twice.
- **On a card with an agent, words go straight to that agent**, which passes Obeya's commands on
  (2026-10-08). Typed and spoken take one way, so "gib frei" works both. Rejected: everything through
  the Koordinator first (about 2 s before a word reached the agent); the Koordinator reading along
  (two readers could both act; still a turn per message); the Koordinator in front while the words
  show at once (the agent still gets them late); two keys (choosing the listener every sentence);
  dictating for the owner to send (a step more). Cost: typed approvals wake the worker, and a request
  can wait behind a long step.
- **The owner's words to the Koordinator show at once** (2026-10-12). Rejected: showing them with the
  confirmation, which looked like recognition still at work.
- **A Koordinator reply that does not act stays in the conversation** (2026-10-21): folded away like
  a confirmation, a question on a proposal seemed unanswered.
- **A reply in the open sheet gets no line above the mic** (2026-10-17): the owner reads it there.
  The same for a looked-up answer in the open card's conversation (owner, 2026-10-29): the line
  repeated what stood beside it.
- **A new card starts unless told to wait**: left to judge, the Koordinator kept one in five plainly
  asked-for tasks planned.
- **A new card for a named later time is snoozed until then** (2026-10-22), in the same action that
  creates it. Without that, the Koordinator could only start such a card or plan it: it started a
  follow-up for „Anfang Dezember“, which went into the queue behind other work, and said it was set
  aside.
- **The Koordinator knows what a card's agent can do on the machine** (2026-10-18): otherwise it told
  the owner to `git init` themselves rather than make a card for it.
- **A new card lands where the owner looks** (2026-10-14). Rejected: a column right of everything.
- **The Koordinator makes cards on other canvases** (2026-10-28), though it works per canvas:
  „leg auf Super 59 eine Karte an“ said elsewhere, or a step it waited for, failed twice on one
  idea, and a card it then made on the wrong canvas could not start there. Its other actions stay
  on its own canvas.
- **The Koordinator's model stays**: Sonnet, Haiku or a shorter prompt saved nothing reliable.
- **Obeya does not speak** (2026-10-08): spoken confirmations and answers distracted the owner, who
  reads them anyway.
