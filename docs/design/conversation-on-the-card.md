## Conversation on the card

A chapter of the [design doc](../design.md), whose header says how it is written.

### The conversation

Every kind of card shows its exchanges as one conversation („Gespräch“), built once
(`src/ui/talk.ts`). Messages are the owner's words (spoken or typed, with screenshots, once, as the
agent got them); the agent's questions with their options and the owner's pick marked on them; its
replies; its handovers (the one a demo came with carries the report's question, with its options
and the owner's pick marked, muted once answered; a handover in the same turn as a reply stands
under it after a dashed line as „Übergabe“); and what the Koordinator looked up. Small lines between
them mark state changes (started, pull request, approved, landed, the demo's link put on the pull
request, stopped, errors, usage limit); an address in them is a link (the comment on the pull
request, say). Everything else (tool calls, thoughts, status
lines, Obeya's notes) folds away as „Verlauf“ under the agent's next message. Obeya's reply to what
the agent passed on (`to_obeya`) answers a step in that „Verlauf“, so it stands under that message,
with what Obeya says after it until then (the answer it looked up); while that message has not come
yet, below the agent at work. The owner's words or a state line before the message keep it where it
came, below the agent's steps up to there. What Obeya reads to look a question up on a card (asked
there by voice, or passed on by its agent) is not the agent's work: it stays out of the agent's
„Verlauf“ and its bubble at work, and folds under the answer Obeya looked up; while Obeya still
looks, under its reply that it does, where that reply stands. On a Question card Obeya's agent is
the card's own, so its reading is the card's agent at work. A note the worker
answered without `reply` counts as answered by its next words, unless a reply follows before the
owner says more. Once no agent works on the card and no question is open, steps after the last
message stand where they happened, the agent's last words among them as its message. A card that was
an idea continues the idea's conversation.

Claude login errors offer „Erneut anmelden“ in the conversation and in a failed start's explanation.
It opens the same terminal login as Setup, even when the login check still reports an account
after a session failed to refresh. The error stays visible. The action reports whether a terminal
opened, offers the manual command, and tells the owner to send the message again after signing in.
A session that signed in with a token instead of this machine's account (on another machine, or
here on `CLAUDE_CODE_OAUTH_TOKEN`), which its error records, gets „Neuen Token erstellen“ there
instead, since a new login here would leave the token expired: the terminal runs
`claude setup-token`, and the token it prints goes into a field beside the error, which Obeya keeps
as `claude-token` for the sessions that start from then on. The field is not kept as an unsent
draft, since it holds a secret. Errors recorded before sessions said how they signed in offer the
login.

Agent words are kept whole up to 12 000 characters (a worker's `reply` is cut at 2000). While the
worker works, the conversation ends with it at work and its latest step on one line, with its
background work that runs („Im Hintergrund“, each with how long it has run). Once the card waits for
the owner (handed over, asked) and the worker's turn has ended, nobody is at work on it, even while
its background work runs on (the app served for the owner to try): the conversation then shows only
that work, under „Im Hintergrund“, without the agent at work or its step, and there is nothing to
pause. Until 2026-10-22 it showed the agent at work as long as such work ran, which read as if it
were still working on the change while the card waited for the owner. A card that waits on a
question ends with it, its options and the card's one field.

How a question ended is one rule for every kind of card, read from what came after it: picked
options stand ticked (an answer in the owner's own words ticks the options it names); asked again in
the same words, it reads „Weiter unten erneut gefragt. ↓“, linking there, options greyed; passed
over by the owner's words and then a reply that does not ask it again, „Durch deine Nachricht
erledigt.“ without options (nothing while that reply is still being written); left without a word
when the card went on (built, taken on, parked, archived), „Offen geblieben.“, options greyed. A
rephrased question counts as settled. An answered question keeps only its orange label, not the
orange edge.

Which questions are open is one rule too (`openQuestions` in `src/core/types.ts`): an idea's while
its agent is not replying, a proposal's while not being reworked, a worker's while the card waits
for it, a demo report's until answered; a parked or dropped idea has none. Open questions move to
the conversation's end under „Frage an dich“ („Fragen an dich“), and only then does the field read
„Eigene Antwort oder Anmerkung – optional“ and „Antworten“. The owner's words the agent read only
after it asked (said while it worked, they reached it after the question) go along and stay below
the question, as everywhere in reading order: above it they would read as words the question took
into account, and once it is answered and back in place they would jump below it. Anything of an
agent's after the question leaves them where they were. The canvas card, the phone's count and
the Koordinator name the same questions. How agents ask: see Questions go to the owner.

Messages new to the owner (after the last event they had in view and their own last words) have an
orange edge until the conversation closes; the phone's button counts them. One that arrives while
the conversation is in view gets none; one that came while the page was hidden keeps it. Seen state is kept per browser, on desktop and phone alike.

A code block in a message (and in any Markdown text a card shows) wraps its lines and has a copy
button in its corner: agents put there what the owner is to take elsewhere as it is (a command, a
message to send). At the desk the button shows while the pointer is on the block, for newcomers too; on a
touch screen, which has no hover, always. The button puts the block's exact text on the
clipboard and reads „Kopiert“ for a moment. Where the page may not write the clipboard (served over
plain HTTP to another machine, as through a VPN, where browsers offer no clipboard API) it selects
the block's text and copies the selection; where even that fails, the text stays selected and the
button reads „Markiert: zum Kopieren lange drücken“.

A conversation scrolled to its end follows it as it grows; scrolled up, it stays put, and only the
owner's own words or actions take it to the end. Obeya's sheet does the same.

### Reading order

A conversation shows things in the order the agent saw them: the owner's words stand where the agent
read them, not where they were sent. Obeya holds them while the agent is in a turn and records after
which log line it took them in; the steps before close above them, the rest below. Until read, they
stand below the agent's work, muted and dashed, „Noch nicht gelesen · beim nächsten Schritt“ (on an
idea, proposal or Question card „… · nach der laufenden Antwort“). Each has a bin: taking it back
removes it, no agent hears it, and its text and screenshots return to the field if that is empty. No
undo. A page that lost its connection reloads each open card's log on reconnect, else words would
stay „Noch nicht gelesen“.

A worker reads them with the result of its next tool step, through the hook that also passes it
preferences and decisions, screenshots as file paths (a tool result carries no images); a turn that
ends before another step starts the next with them; a step that ends the turn (`ask`, say) carries
them in its result, which leaves the turn to the worker (see A worker's tools); a session
that ends first gets them with the message it resumes with, after a stop at the next start. An
idea's agent, a proposal's reviser and a Question card's agent read them when their next turn
starts. Words said between turns start the next turn.

### Replying to a message

On a card and in Obeya's sheet the owner can reply to one message, as in chat apps: a button in its
corner (at the desk while the pointer is on the message, for newcomers too; on a touch screen
always)
puts it as a quote above the field, removable with × or Escape (before Escape closes the card or the sidebar); typed or spoken words go out with
it. The quote is part of the field's draft, so it survives closing the card and reloads. The sent
message shows the quote's first lines; a click scrolls to the original. Only messages can be quoted,
not steps or state lines.

The agent reads `[In reply to your message: „…“]` above the words: about 160 characters of what it
already has in its session, else the whole message (Obeya's words, which the worker never got). The
Koordinator always gets the quote whole; in the sheet a looked-up answer by its tag (`A12`).

### Quoting marked text

To answer a part of a message, the owner marks it in the conversation, in anyone's message, their
own included; on a card with a field and in Obeya's sheet a small button with a quotation-mark icon
appears beside the marking (named „Zitieren“ beside the icon until used once). The same holds for
what such a card shows beside its conversation (an idea's brief and mocks, a task's text, an HTML
artifact, a file the card shows, formatted or as a page) and for a page an answer in the sheet comes
with: the quote goes into that card's field, on the phone opening the panel the field is in. A
framed page is the worker's and cannot be read from Obeya's page, so every page Obeya frames on its
own page (not a shared copy) tells it what is marked in it, with where its first and last line
stand. Only the frame the owner is in is heard, the button stays beside that frame whatever the
page says, and the text reaches the field only on the owner's press. There is one marking at a time: a new one in a frame takes away the
page's, a press on Obeya's page the frame's, as one page's marking would. At the desk it
stands at the end where the pointer let go, outside the marking; on a touch screen below the middle
of the marking's last line, clear of the selection handles and of the system's menu above. A press
puts the marked text, on one line, in quotation marks of the UI language into the field, followed by
„ - “, with the cursor behind it and the focus in the field (on the phone the keyboard opens at the
first tap). Where it goes depends on where the cursor stood when it left the field: at the end of
the text (or never in this field since it was shown), at the end, after a line break unless that is
the start of a line; anywhere else, as the line after the cursor's line. It is typed in as by hand,
so ⌘Z takes it back. Unlike replying to a message, the quote is plain text of the draft: the agent
reads it as the owner's words.

### The task as first message

Once the agent starts, a task's text and screenshots stand as the conversation's first message,
labelled by origin: „Du“, „Idee“ (a prototype), „Vorschlag“ (an accepted proposal), „Obeya“ (from
the Arbeitsrückschau). A long text folds under „mehr“, and „Voraussichtlich betroffen“ folds under
it. A card that was an idea shows its brief on the left instead; a workstream its plan-doc text
under „Plan-Doc“ (see Plan docs).

### Card layout

Every card with a conversation (idea, proposal, a task an agent worked on) is laid out the same way:
what it is about on the left (brief, proposal text, demo with chapters and sharing, result files,
pull request, what landed), the conversation on the right with the open questions and one field with
one Send, and the decisions (build, accept, approve, stop, archive) in a row below both. The last
demo stays while the worker works again (see The demo on the card). A task with nothing for the left
yet is its conversation alone, as narrow as that, and widens once there is a result. A task waiting
for its first start (planned, snoozed to start later, or in the queue) is a split: its full text
(editable where the owner wrote it) and what it waits for on the left, its conversation on the
right. Only a card the owner has just created stays its text alone until it closes or starts, so the
task goes into the text, not into a note.

On every planned card, a stopped one too, the field takes notes for the agent that takes the card on
(„Hinweis an den Agenten – er bekommt ihn, sobald er startet“). Typed notes stand unread („Noch nicht
gelesen · sobald der Agent startet“, with a bin to take them back) and go to the worker with the task
when it starts, by the owner's click, at the time it was snoozed to, or out of the queue; a stopped
card's worker gets them with the message it resumes with. Planned as a project, the card's worker
gets them with its task; discussed as an idea, its exploration agent opens the discussion with them.
Spoken words go to the Koordinator, which passes a note on the same way.

The field is the same on every card and in Obeya's sheet: one frame, the text growing up to 30 % of
the window (no scrollbar below that), the screenshot button, the microphone (see Voice in) and Send
in its bottom corner. Beside a short text the three stand side by side; once the text is about as
high as the three stacked (three lines on the phone), they stack in a narrow column and the text
gets the width; the switch is judged at the stacked width, so it does not flip back and forth. The
placeholder shows in full, on two lines where needed, since it often says what the agent does with a
message (the owner, 2026-10-17). Send is an arrow in a dark circle, as in chat apps; a button that
starts something rather than sends keeps its words („Prototyp starten“).

A review card's findings (see Review cards) stand above its demo, each with its choice; what the
owner chose stands above the field like a quote and goes out with its one Send, the words beside it.

Under a task's title stand its branch (and plan doc) and the size of its change („+120 −30 in 5
Dateien“; where the card shows its change list, the size stands below the list instead): before landing the workspace against where its base branch was, uncommitted and new files
included; after, what the landing put on the default branch (an archived card keeps it). A click
shows the whole diff over the page; „Pfad kopieren“ copies the workspace's directory (`host:/dir` on
another machine). The owner rarely reads code, so it stays a quiet line.

#### The files beside the demo

What a card's work made or changed is its result, shown on the left for folder and git cards alike.
The change list at the top of the column is also its row of tabs, so each file shows once: a line
per file with its sign (＋ added, ✎ changed, ↪ moved or renamed, ✕ deleted), its path cut at the
front so the name stays, its lines added and removed, and on a folder card what discarding would
leave. „▶ Demo“ comes first, then the files the worker named at its handover (`ready_for_review`'s
`files`, the caption under the path), then other changed files that can be shown, documents first;
last, greyed and not to be picked, deleted files, directories and files that are neither documents
nor text (their line counts still open their diff). The line picked is marked like a tab; a click on
a line shows its file below, a click on its line counts its changes there. Beside a demo, and while
the agent is at work (working, stopped, or asking), the list shows the demo and the named files
only, the other changed files folded under „N geänderte Dateien ▾“ (or „und N weitere ▾“ below named
files), and no file is picked until the owner picks one; handed over without a demo, the list is
open and its first file shows, so there is always a result to see. Unfolded, past eight lines „und
N weitere ▾“ unfolds the rest. The file picked stays in view when folded. Beside the toggle stands
the size of the whole change („+120 −30“), which shows the whole diff over the page. On a git card the lines are
the branch's files, on a folder card its change list. The phone shows the same list with lines tall
enough to tap. Markdown shows formatted (with its images), a PDF in the browser's
viewer (on a phone, and where the browser has none, its pages drawn by pdf.js one under the other
as wide as the column), an image as is, an HTML page as an HTML artifact, text and code as text; anything else as a
tile with „Auf dem Rechner öffnen“. A changed file first shows „Änderungen“, with „Formatiert“ or
„Ganze Datei“ beside. „Auf dem Rechner öffnen“ and „Im Ordner zeigen“ act on the machine Obeya runs
on (a non-document only in its folder, since opening would run it), and only for a request from that
machine; from another device the file downloads and „Im Ordner zeigen“ says it works only there.
The column keeps its tallest height so the card does not jump; a PDF's viewer is as high as the
column shows, so its scrollbar is the only one; a video left for another file stops.

A card with named files, or a folder card handed over without a demo but with files to show, is a
split even without a demo; the server decides at the handover so the layout does not jump. A worker
names only files of its change, at most twelve, or is asked again; without `files` later the earlier
ones stand, an empty list removes them. An open view reads its file afresh when a handover arrives
or the work changes it.

Obeya serves only the files the card made or changed and images their Markdown shows, nothing else
and no link the card made; on a branch it reads git's NUL-separated name list, as diff headers
misread names with spaces (`x b/notes.md`). It reads from the workspace while there is one, else the
landed commit or branch (to open a landed card's file, the checkout's copy). Files are served like
an HTML artifact (see The demo on the card), except a PDF: no browser shows one in a sandboxed frame
or under a CSP sandbox, so it comes unsandboxed with `nosniff` and a policy allowing nothing
(`default-src 'none'`, `form-action 'none'`, `Connection-Allowlist`). Chrome's viewer runs PDF
scripts; tested on 2026-10-21, a PDF submitting a form, opening a link or calling
`getURL`/`launchURL` sent nothing. pdf.js runs none of a PDF's scripts, links or forms; it comes
from Obeya itself (its legacy build, which phones' older browsers run), outside the page's bundle,
under the address of its version, so a browser caches it for good.

#### Trying the app by hand

„App öffnen ↗“ at the end of the branch line opens the app running in the card's workspace in a new
tab; a plain link, as it is rarely wanted. The worker reports the address with `app_running(url)`
(an empty url when it stops it); the card keeps it until cleared, parked or the workspace goes. The
link shows only while the app answers (any HTTP answer, probed by the open card). It goes through
Obeya, which keeps the app running at least 30 minutes after, so parking does not stop it under the
owner.

For a workspace on another machine (see Hosts) the probe and link go through an `ssh -L` forward of
that one port to a system-picked free port here (never the same number, which a local clone's stack
may need), made at the first probe, ended when the app is no longer offered or Obeya stops; its
remote command waits on stdin so it dies with Obeya. A dropped forward is remade on the same port,
so an open tab keeps working. A page calling an API on another port finds nothing (the worker's
brief says so).

### Screenshots

What the owner writes on a card may carry screenshots: pasted, dropped or picked with the field's
image button, scaled to at most 2000 px in the browser and uploaded at once. They show as thumbnails
in field and conversation and reach the agent as images in the message, with their paths. A click
enlarges one over the greyed page; Esc or a click shrinks it back. After the first screenshot picked
by file dialog, a hint under the thumbnails names the paste and capture keys (⌘V / Ctrl+V, ⌃⇧⌘4 /
Win+Shift+S), across sends and reloads, until „Verstanden“ or the first paste; never on a device
without mouse or trackpad.

A planned card's description takes screenshots too; its worker (or idea agent) gets them with the
task, and building an idea adds those from its discussion. A command in the Koordinator's sheet may
carry screenshots; they go with each action that creates or concerns a card, and join the task of a
card it starts. A spoken command takes the screenshots of the field it speaks to (see Drafts);
dropped on the microphone or pasted outside a text field, they land there. Only with no card open
and the sidebar closed does the microphone keep its own screenshots beside it; they move into the
sidebar's field when it opens and back when it closes (its words stay in the sidebar's field, the
paths of dropped files go back with them, see Other files). An
open card leaves them beside the microphone, out of sight until it closes; they are for Obeya, not
the card's agent.

### Other files

A file of another kind (a PDF, a log, a spreadsheet, a folder in the app) dropped on a field or on
the microphone, or together with screenshots, goes in by its path, as a terminal agent's prompt
takes a file dragged from the file manager, so the owner can have the agent read it, move it or
change it where it lies. The app knows the path from the system (see App). A browser does not tell
a page where a dropped file lies, so Obeya looks for it on its own machine: Spotlight on a Mac, else
(or when that finds none) Downloads, Desktop, Documents (also under OneDrive) a few levels deep and
the home itself, hidden folders left out; a file counts only with the same name, size and time
(within two seconds), and only if exactly one fits. Otherwise (a browser on another device, two
copies, a file elsewhere) Obeya keeps a copy under its home (`files/<canvas>/`, at most 100 MB, in a
folder of its own under its name made one word) and the copy's path goes in.

The path goes into the field's text at the cursor while the field has it (⌘Z takes it back), else
where the cursor last stood or at the end, parted by spaces, in quotes where it has a space; the
focus stays where it was, so the microphone still sends rather than dictates. Dropped on the
microphone with no field to take it, the path waits beside the microphone under the file's name (×
removes it) and goes with the next recording; it moves into Obeya's field when the sidebar opens,
and back beside the microphone when it closes, as the screenshots do, while it still stands in the
field's text (the words around it stay there).
While a file is looked for or uploads the field shows „lädt …“ and does not send, and a recording
waits for it (and for screenshots still uploading) before it goes. The image button's picker stays
for screenshots; its tooltip names dropping other files.

A recording nothing came of, or that Obeya refused, leaves the screenshots where they were. When the
connection breaks before the answer, the page asks Obeya by the recording's id whether it arrived,
and returns words and screenshots to the field only if not; the command's line then says „Obeya hat
es; nur die Antwort kam nicht an.“ instead of „Das hat nicht geklappt“.

### Skills by `/`

In the field where a card's agent hears the owner's words (a task's, an idea's, a review card's; not
where the Koordinator reads them, nor on a Question card), `/` at the start of the text or of a word
opens a menu of the skills the agent can be asked for, as in Claude Code: the repository's, the
user's, those of the plugins the agent loads (Obeya's own for a worker) and Claude Code's own skills
(`/code-review`), in that order, each with its argument hint and the first line of its description;
not Claude Code's controls of a session (`/compact`, `/model`), which Obeya runs itself. A path
(`/src/ui`) opens none. What follows the slash filters: names that start with it first (also after a
plugin's prefix, `obeya:demo`), then those that contain it; the menu shows only while something
fits. The arrow keys mark, Enter, Tab or a click picks, Esc closes the menu and leaves the card
open. Picking types `/name ` over the word, as if by hand (⌘Z takes it back). The words reach the
agent as they are: Claude Code's skill tool takes `/name` in a message as the owner asking for that
skill, at the start or in the middle of a sentence. Until the owner has used the menu once (moved
through it with the arrow keys or picked a skill), a hint under the field says so while it has the cursor („„/“ ruft einen Skill des Agenten auf.“).

Claude Code says which skills there are: Obeya starts it in the repository's Lesestand with the
agent's plugins and settings, asks for its commands and skills, and ends it without a message (no
tokens; a few seconds). A repository whose Claude Code configuration waits for the owner's trust
(see Trusting a repository's commands) offers the user's skills alone, as its agents get them; so does a review
card, whose agent reads none of the repository's settings. A list is kept for two minutes per
place; after that it serves while it is asked again. A worker on another machine gets this
machine's list.

### Marking screenshots

A screenshot still in a field opens ready to be marked: a drag frames a region, a click sets a pin,
in signal red with a white edge, numbered together in order (a pin in a red circle, a frame in a red
tab at its corner, so a small frame does not read as a pin). Undo (⌘Z / Ctrl+Z) takes back the last
mark, down to the unmarked image; Done, Esc or a click beside closes. A hint shows until the owner
has marked once. On closing, the browser draws the marks in and uploads the result, which replaces
the original in the field (which waits to send until it is uploaded); the agent only gets the marked
image. The marks are kept as shapes, so reopening (even after a reload) shows the original with its
marks and Undo still works. A sent screenshot cannot be marked. The server sees one more uploaded
image.

### Decisions

- **A conversation, not the log** (2026-10-05). Rejected: both side by side. Workers answer notes
  with `reply`. Rejected: their last words before the owner's next message (often "Ich committe
  jetzt") and a small model summarizing each turn (cost on every turn). A note withdraws an open
  question rather than answering it, which would log a remark as a decision.
- **A planned card takes notes for its agent** (2026-10-30, GitHub issue #24): a scheduled task
  offered only to start it or to snooze it, so what the owner thought of meanwhile (what to watch
  out for) had to go into the task's text or wait for the agent. Rejected: notes only on queued
  cards (2026-10-16 until then); a field on a card just created, which offered two places for the
  task. Spoken words still go to the Koordinator, since „starte das“ and „stell das zurück“ are
  what is said to a planned card, and no agent is there yet to pass them on.
- **One layout for every card with a conversation** (2026-10-07). Rejected: a task stacking demo,
  buttons, feedback and conversation in one column, with the demo's question its own field and Send.
- **The task is the conversation's first message** (2026-10-08), so the conversation reads from the
  start (asked, done, added) and every card kind's starting point is in it. Rejected: an „Auftrag“
  section on the left.
- **The last demo stays while the worker works again** (2026-10-08); **a demo report's question
  stays on its handover** (2026-10-09). Rejected: hiding the demo on feedback; moving the question
  to the newest handover, orange as if open.
- **Agent words kept long** (2026-10-09). Rejected: a 600-character cut.
- **Replies to one message** (2026-10-09; sheet 2026-10-15), the quote part of the draft.
- **Quoting marked text into the field** (owner, 2026-10-22): the owner often answers single
  sentences or parts of them and did so by copy, paste, quotation marks and „ - “ by hand. The quote
  is text in the field rather than a reply chip, so several can stand in one message, each followed
  by its comment. From what the card shows too, artifacts and an idea's brief among it (owner, same
  day): those are what the owner answers most often. Rejected for framed pages: reading the
  selection from Obeya's page, which a sandboxed frame of origin `null` does not allow.
- **Code blocks copy at a click and wrap** (owner, 2026-10-22): marking a drafted text by hand was
  fiddly, on the phone above all. At the desk the button shows on hover (owner, same day), so it
  does not sit on every block; on a touch screen always, since there is no hover. The block wraps,
  since what it holds is mostly prose the owner reads before sending it on. Rejected: scrolling a
  long line sideways.
- **Order as the agent saw it** (2026-10-14): Obeya holds the words and passes them at the next
  step, so it knows where they were read and can take them back. Rejected: passing a note straight
  into the session; Obeya learned only at turn end what it took, and the SDK takes one back only by
  a control request.
- **Obeya's reply to a passed-on request under the agent's message** (owner, 2026-10-29): the agent
  passes the owner's words on and then says so; standing where it was logged, Obeya's „Moment, ich
  sehe nach“ came above the agent's message that triggered it. The passing-on step folds under that
  message, so the reply follows it. Rejected: holding the reply back in the server until the
  agent's message (it would be lost in a restart, and each kind of agent would need it).
- **Obeya's look-up apart from the agent's work** (2026-10-29): Obeya logs what it reads for a
  look-up on the card it was asked on, and it showed in the worker's bubble at work as if the worker
  read it. It now goes with Obeya's answer. Rejected: not logging it on the card (the owner would
  not see what the answer rests on).
- **Words read after an open question stand below it** (2026-10-22), also while it waits at the
  end. Rejected: holding them back until the owner answers, which keeps from the worker what it
  could take in at once.
- **Orange edge only for what is new, never for what arrived in view** (2026-10-17). Rejected: edges
  on answered questions (looked open) and on messages the owner watched arrive.
- **The conversation stays where the owner scrolled** (2026-10-20). Rejected: every agent step
  jumping to the end.
- **One rule for ended and for open questions on every card kind** (2026-10-21). Rejected: per-kind
  logic, which disagreed between field, phone, canvas and Koordinator.
- **Screenshots as images in the message**, so the agent sees them without a step. Rejected: files
  to read (only where tool results carry no images).
- **Other files go in by their own path** (owner, 2026-10-26), so the agent can also move or change
  them; a PDF dropped on the microphone opened in a new tab instead. A browser never tells a page a
  dropped file's path, so for a browser Obeya looks for the file by name, size and time, and the app
  takes the path from the system (owner's choice of both). Rejected: always a copy (the agent could
  not touch the original); the File System Access API, whose handles carry no path. The path is
  text in the field, so it reaches every agent through what already carries the owner's words and
  stays editable. Rejected: a chip per file beside the screenshots, which every way a message
  travels would have had to carry. The picker stays for images: on a phone it opens the photos.
  The paths go back beside the microphone when the sidebar closes (owner, 2026-10-26): they stayed
  in its field and a recording went without them. Rejected: the microphone sending the closed
  sidebar's words, which stay apart from it on purpose.
- **A spoken command takes the screenshots of its field** (2026-10-12). Rejected: a separate
  microphone store, which left pasted screenshots behind. **Obeya says whether a cut-off command
  arrived** (2026-10-16). Rejected: treating it as failed, or detecting a leaving page by
  `pagehide`; both sent screenshots twice. The microphone's screenshots move into the sidebar rather
  than hide (2026-10-17).
- **Marking: the gesture decides** (owner, 2026-10-14); frames numbered like pins (owner,
  2026-10-15). Rejected: a free pen (rough on a trackpad) and a tool switch.
- **The worker reports the app's address; the link shows only while it answers** (2026-10-16).
  Rejected: Obeya guessing ports (Docker listens elsewhere, only the worker knows the page), a mark
  on the canvas card, starting a parked app from the link. Only the reported port is forwarded
  (owner): more would need the worker to name them and keep their numbers here.
- **A card's files are its result, in tabs beside the demo** (owner, 2026-10-21), named files first.
  Rejected: an open button per change-list entry (no place for the result, Markdown unread in the
  browser), Markdown formatted only in the diff overlay (the result hidden behind „Ansehen“), a
  bundled pdf.js everywhere. A file opened from another device downloads; an answer's files do the same.
- **On a phone, pdf.js draws a PDF** (2026-10-22): Chrome on Android shows an empty frame for a PDF,
  so the owner saw nothing of a PDF on the phone; Safari on the iPhone is no more reliable in a frame.
  Rejected: a tile that opens the file in the phone's PDF app (the result to judge would be one tap
  and an app away, unlike every other kind of file) and drawing pages on the server (no tool that
  runs on every platform). The desktop keeps the browser's viewer, which searches and selects text.
- **The change list is the row of tabs** (owner, 2026-10-21): files showed twice before, as a list
  across the card and as tabs below it. Rejected: tabs alone with the list folded away (what stays
  before „Änderungen verwerfen“ would no longer show at a glance, files without a view would be
  hidden) and tabs down the side of the file (they take the document's width).
- **Beside a demo and during the work, the changed files start folded** (owner, 2026-10-21): the
  owner works on requirements and judges the result by its demo and the files named as the result,
  not by reading the code; a dozen changed files above the video put the code in front, on the
  phone above all. The named files stay in view, being results themselves; a handover without demo
  or named files shows its files open, since some result must show. The size of the change moved
  from the branch line to the folded list, so count, size and files stand together.
- **Claude Code lists the skills, and the owner's `/name` reaches the agent unchanged** (2026-10-30,
  GitHub issue #27). Rejected: Obeya reading the skill directories itself (plugins, marketplaces,
  the account's and Claude Code's own skills: Claude Code's discovery to rebuild and keep up with);
  the list of a running session alone (none for a card waiting to start or done); passing a message
  that starts with `/name` to Claude Code as a slash command (Obeya says what the owner's words are,
  a note on a handover, say, so they never start the message, and words that reach the agent during
  a turn come with a tool result, where nothing is expanded).
