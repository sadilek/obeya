## The canvas

A chapter of the [design doc](../design.md), whose header says how it is written.

The UI is a browser app with a custom canvas: camera with fly-to, unfold-in-place, semantic zoom,
edge indicators, minimap, and a frosted top bar the canvas slides under.

### The bar

Left, after the canvas switcher: „Suchen“, the archive's button (see Card lifecycle), the queue's
and "Neue Aufgabe". The queue's button counts the waiting cards; a click lists them in turn, each with what it
waits for, buttons to move it and a × that takes it out of the queue at once, as „Aus der Warteschlange nehmen“ on the card does (back to planned; no
undo, starting it again is the way back); a row opens its card. The switcher's, the archive's and
the queue's lists close on a click beside them and on Esc. Obeya's button is the rightmost (see
Sheets).

„Suchen“ (or `S`) drops down a field like the archive's, the quick way to a card. Before the first
word it lists every card on the canvas, the one where something happened last first: a change of
state, a line in its conversation (a message, a status, a report; not a worker's tool activity), an
edit. Moving a card, grouping it or folding a project does not count. A line above the list says
what the search looks through. With the first word, it finds the cards on the canvas, and below
them those in the archive, that hold every typed word, matched as the archive's search does. In each
part, cards with every word in the title come first, then those holding the words only in their
text, summary, last status, open question, a proposal's reason, label or a project's goal, with an
excerpt that shows the words there. Each list shows 30 cards and counts the rest.

The row under the pointer, or the one the arrow keys pick, lights its card up on the canvas with a
ring in its state's colour that breathes; the camera stays where it is. A card out of sight lights
up its edge indicator instead (shown for it even when it does not need the owner), a workstream of a
collapsed project its project; an archived row lights up nothing. Leaving the list or closing the
search ends it. Enter opens the picked row, as a click does. A card on the canvas opens in place and
the search closes (a workstream of a collapsed project opens its project). An archived card unfolds
from its row, and the list stays under the dim to fold back into, as in the archive. The search
keeps its words between openings. The archive and the search drop down one at a time. The phone
view has no search.

Right, before the workspace pool: the usage limits of the Claude plan that Claude Code on this
machine is logged in with, the session's (five hours) and the week's, each a short meter with its
percentage, the most used limit of each group, coloured in the grade the plan's usage endpoint gives
it (warning, critical). Hovering or a click lists every limit (the session, the week for all models,
the week for a single model) with when it starts anew, where the numbers come from and as of when,
and „Ausblenden“, which turns the setting off; „Nutzungslimits in der Menüzeile“ under Konfiguration →
Allgemein turns it on again (on until then). The phone view shows the same at the right of its bar.
The numbers come from the data behind Claude Code's `/usage`: one idle Claude Code session, which
sends no prompt and so uses none of the limits, is asked a little over every minute (it keeps an
answer for a minute) while the setting is on and a page of Obeya is open, and closed once neither
holds, half a minute after the last page closed: a reload or a switch to another canvas, which loads
the page anew, finds the numbers there and shows them in the bar from its first frame. Nothing shows for a login without plan limits (an API key, a cloud provider), a Claude Code
too old to answer, or numbers that could not be fetched again for five minutes. The workers on other
machines may use other logins; the bar shows this machine's.

The bar has no hint line. `?` (or the round `?` button) shows the legend of mouse and keys, ending
with the link „Wunsch oder Fehler melden“ (see Wishes for Obeya's makers). The button only teaches
the key: the legend says so, and once the key has been used the button is gone for good (per
browser).

The buttons always fit: when the contents outgrow the bar (a wide sheet, a narrow window), it gives
up in steps the wordmark and branch, then labels a few at a time, then the workspace pool, the usage limits and `?`,
then all but the sheets' buttons. The step is measured from the actual contents, since the same
width may hold a short or a long branch, one clone or three.

The logo (three cards in the inks of working, waiting and approved, "obeya" in Newsreader) opens
the bar, stands alone while the page loads (above "offline" when the server is gone), and is the
favicon and the app icon's source (`scripts/logo.tsx`).

### Creating cards

A double-click or `n` creates a card and unfolds it with the cursor in the text field. The title is
optional: a card closed or started with text or screenshots but no title gets one from a short
session of the „Kleine Aufgaben“ group (else the text's first line) before its start is judged;
meanwhile the canvas shows the first line, muted, and a title the owner types wins. A card left
empty is dropped (one left by a closed page on Obeya's next start). Deleting offers undo.

An empty canvas names speaking first (hold Space and say what to build; the card appears at the
pointer), the double-click second. The bar's "Neue Aufgabe" only teaches the double-click (a note
with "Got it") and goes for good (per browser) once a card has been created by double-click.

### Cards on the canvas

Cards have one fixed size; a delivered workstream shrinks to a chip (`W3` and its title) once its
agent is done. A project wraps its workstreams, which cannot be dragged out; new projects go below
the existing ones. A proposal or follow-up goes below its card, or, when that spot is taken (for a
workstream: by its own project), to the nearest spot clear of everything. The dashed line from a
proposal, follow-up or prototype to its card joins the facing sides and runs above projects but
below cards.

The arrow before a project's title collapses it to its head („Zuklappen“, „Aufklappen“), for
projects the owner does not work on (on a shared repository every colleague's plan docs are
projects). Collapsed, it shows title, progress, start button, the badge of workstreams that need the
owner, the bubble of its agent's unread answers (see Asking in a project's sheet), and a mark per workstream in its state's colour that names and opens it. Its workstreams stay
in the project's sheet and the queue, and an edge indicator for one that needs the owner points to
the project. Nothing around it moves. Collapsing is stored in this Obeya, not in the plan doc, so it
holds across reloads, devices and the archive.

A planned or queued card shows a play button under the pointer that starts it without unfolding.
Under the pointer a card also shows the waits around it (see Scheduling).

#### A project arranged by its dependencies

A project's workstreams can stand in columns by what builds on what: leftmost what can start at
once, each further column one step along the longest chain of open workstreams. Delivered
workstreams stay in rows of chips above. Within a column cards follow what they build on, so arrows
cross little, else the plan's order; a column holds four cards and overflows into one beside it.

Plan docs state dependencies in prose ("Needs W1", "after W2", or only implicitly), so the
Koordinator reads them in a turn of its own: for each open workstream the ones it builds on
directly. The reading is kept for the doc as it stood; under the pointer a workstream shows the open
ones it builds on as waits (see Scheduling), and the project's sheet lists the workstreams in this
order with what each builds on.

A project arriving with two or more open workstreams is arranged once read, unless the owner has
moved one of its cards meanwhile. "Anordnen" in its head (or in its sheet) arranges it again, after a
new reading if the doc has changed; it takes effect at once, with „Rückgängig“. A project that grows
into other cards moves to the nearest clear spot.

### Moving around

A card dragged to an edge of the view scrolls it, faster nearer the edge, but only as far as the
canvas reaches plus room to drop the card; a card picked up at an edge scrolls only once the pointer
moves towards it.

Panning and zooming stop while a strip of the nearest card is still in sight, so the view never lands
on emptiness; wider gaps are crossed via the minimap. When the last card leaves the view (cards go,
the window shrinks), the camera flies to the nearest. The minimap sits bottom left, clear of the
sheets; a click flies there, a moving press lets the view glide after the pointer.

### Unfolding a card

Opening a card takes about 300 ms (a flight to the middle, then the unfold), closing the reverse:
fast enough not to wait on, long enough to keep the context.

An unfolded card is as large as its content, up to the room between the window's top (over the
dimmed bar) and the microphone; beyond that it scrolls. Only a window too low for a usable panel lets
it reach under the microphone, with room for the last row to scroll past it. A card's row of
decisions stays in view at its foot while a long text scrolls, so a planned workstream shows „Agent
starten“ without scrolling.

A card whose conversation stands alone is a conversation wide. A card with a conversation beside
what it is about (an idea, a proposal, a task with a result) is a wide split, the conversation a
third, as tall as its taller column, centred left of a docked sheet and keeping at least a conversation's width beside it. Each
column scrolls on its own, the panel never. A Question card is its conversation alone at a card's
width, growing with it up to the room above the microphone before it scrolls, like a split's column:
a looked-up answer is long, and a box of fixed height left most of the window unused. A proposal's
text box grows until the reason below it would leave view.

### Sheets

The sheets (Obeya's, a project's, a plan doc being read) are a sidebar docked to the window's right
edge, full height. The canvas is the rest: the top bar, the microphone and its confirmations, the
edge indicators, the minimap and an unfolding card all keep to it. Opening, closing or resizing a
sheet shifts the view so its middle stays in the middle of the rest. A card opened beside a sheet
returns beside whatever sheet is open when it closes; a project's sheet stays, dimmed, while one of
its cards is open. A narrow window lays the sheet over the canvas.

Obeya's button, a speech bubble with its counts, stays where it is when its sheet opens and becomes
the sidebar's top corner that closes it; the sheet is headed "Obeya". Other sheets have a ✕.
Leaving a canvas (for another, or a reload) with Obeya's sheet open and something entered in its
field brings the sheet back open on return; with the field empty, or the sheet closed on leaving
(a draft in it or not), the canvas comes back with it closed (owner, 2026-10-30): an open sheet
with words in it is work in progress, an empty one was only a glance.

Esc closes a sheet, from a text field in it too, unless a field being edited takes it to cancel the
edit; with a card open beside a sheet, the first Esc closes the card.

The owner drags the sheet's left edge: one width for all sheets, another for reading a plan doc
(which follows the window until dragged). The browser remembers both; a double-click on the edge
restores the default.

### Visual identity

Index cards pinned to a wall, so that nobody takes Obeya for the stock AI-generated interface.

- *The card*: off-white card stock on a warm dotted board, nearly square corners, a short hard
  shadow, the state as a rule across the top in its ink (a band when zoomed out). No ruled lines.
  The owner's turn is an orange frame and a pulsing pushpin with "!" (the pulse, a halo growing and
  fading, changes nothing but size and opacity: an animation the browser has to repaint makes the
  whole card under it shimmer on a zoomed-out canvas, 2026-10-30); an idea is on rose stock; a
  proposal only pencilled in (dashed, no stock); a queued card's rule dashed; done and live cards
  fade and yellow slightly (not while their agent still works after landing: then only their state line is in the working ink, with the moving line). The state line at the
  card's foot stays one line, cut short with an ellipsis when it is longer, so it never runs into
  the text above it. Under the pointer a
  card lifts; dragged, it tilts as if held. "At work" is a pencil stroke drawn again and again.
- *Inks*: planned pencil grey, working clear blue, waiting for the owner strong orange (also every
  count of what waits), approved yellow-green, in PR petrol, proposal violet, idea madder red, live
  and done faded. Dark mode is black stock and white pencil with inks as far apart: blue and green
  never confusable, orange the loudest.
- *Light or dark*: as the system until the owner picks Hell or Dunkel (or the system again) in Konfiguration (`theme` in
  Obeya's `settings.json`). The page reads it before its first render and applies a change without
  reload; `color-scheme`
  follows so native controls and framed pages (a worker's HTML artifact, a mock) match. The site and shared demo pages follow the system.
- *Type*: titles and headings in Newsreader (a plan doc in the sheet too), the rest in IBM Plex
  Sans Condensed, code in the system monospace; both fonts SIL OFL and self-hosted, no Google Fonts.
- *Carried through*: menus, panel, sheets, dialogs, buttons and fields share palette, type, corners
  and hard shadow; dots, the microphone, spinners and the pin stay round. The site and shared demo
  pages use the same palette and type.

### Groups on the canvas

A group shows as a territory behind its cards: a soft glowing outline over a faint area in its
colour. Group colours appear only there and in the minimap, never on a card, so they do not compete
with the state inks. Zoomed far out, group names stand pale over their territories.

A territory is the contour of an energy field (Bubble Sets): the group's cards pull, near cards are
linked so they share one territory (not across another card), other cards push back, and where two
groups meet the stronger holds the ground (a card amid another group is an island). To keep the
edge tight, only the strongest pull counts at each point, not the sum (which bulges over every gap);
the narrow gap between two facing cards pulls like a card; and a card's pull is squeezed on a side
facing another card across a narrow gap, so the edge follows the gap's middle instead of hanging
down beside the other card as a tip. Contours are smoothed so they come out round, without grid
facets. Only fields that something moved near are recomputed, and a slow computation defers the
next, so a dragged card keeps the frame rate and its territory follows a little later; at rest
nothing is computed.

When cards change group, from wherever (the colour ring, the Koordinator, another page), a wave
runs out from where it was assigned, the territory overshoots and settles, and a light runs once
along the new edge, all in under a second (see the decision on large animations).

Marking: Shift + drag draws a lasso (without Shift it pans), Shift + click toggles a card (a
workstream: its project; a click beside a project's workstreams marks the project); a lasso adds to what is marked. Marked cards carry drifting dashes and a
line with their count and „Gruppe …“. Dragging a marked card moves all marked ones, an unmarked one
alone. A click on the empty canvas or Esc unmarks. Two hints teach it, each until used once: after a
card was moved alone, how to mark several; beside two or more marked cards, that dragging one moves
them all.

Assigning: „Gruppe …“, or a right click on a card (that card, a workstream's project, or all marked ones if it is among
them), opens a ring of colour balls: the groups, "+" (a new group, named in place) and "∅" (none).
Each group's name stands beside its ball with its count of cards still to be done (not finished, archived or a dropped idea; a project by its workstreams); a group at 0 goes
pale, a candidate for deleting. Behind the ring the canvas steps back under a frosted halo and holds
still. Moving towards a ball picks it, a click takes it, Esc closes the ring. The picked group's ×
deletes it (its cards, archived ones too, belong to none), with „Rückgängig“.

The Koordinator has the tools `group` (by name; a new name creates the group), `ungroup` and
`rename_group`, and sees each card's group.

### Refusals

The server words no UI text for refusals: it answers with a stable error code and an English detail
for developers (a failed start's log entry carries the code too). The UI shows its own text per
code, a generic one otherwise.

### Decisions

- **The search stays in the bar and is the quick way to a card** (2026-11-01, owner): before the
  first word it lists the canvas's cards, the last changed first, and the archive joins only with
  the first word so the list stays short; a row under the pointer lights its card up where it
  stands instead of flying there, since the view would jump with every movement of the mouse.
  Rejected: a sidebar on the right like Obeya's conversation (more work, and quick jumping does not
  need it); a button beside the microphone (the bottom middle is for what goes to agents, and the
  list would open over the middle of the canvas); the archive's filter for active cards too (no one
  looks for an active card in the archive).
- **The search across canvas and archive matches as the archive's filter does, with no fuzzy
  matching library** (2026-10-30, owner). Rejected: fuzzysort, whose subsequence matching tolerates
  left-out letters but, over a card's long text, finds nearly any scattered letters and needs score
  thresholds to keep that out; one way of matching across Obeya is easier to predict.

- **The look is the index card** (2026-10-10), prototyped beside a Swiss editorial card (black
  frame, solid state band, Schibsted Grotesk) that read better from afar but looked like a known
  designer style; a kanji seal and a kanban ticket were not pursued. Ruled lines and inks too close
  to each other (fountain-pen blue, bottle green) were dropped.
- **Groups are contours drawn in SVG** (2026-10-05): calm, no WebGL, no cost at rest. Rejected: two
  WebGL shader prototypes ("plasma" areas, a drifting honeycomb), livelier but costing frames all
  the time.
- **Nothing on the canvas animates a large area for a second or longer** (2026-10-15). Chrome's
  screen capture (a demo's screencast, a shared tab) locks onto a large area changing every frame;
  once it stops, the capture drops all changes for about 0.27 s. Hence the canvas holds still behind
  the colour ring and the group wave stays under a second. Rejected: dropping the halo's blur, which
  would leave the cards' text readable behind the ring's names.
- **The lasso marks cards rather than opening the colour ring** (owner, 2026-10-21): marking first,
  as in Figma or Miro, grouping a click away. Rejected: the ring on every lasso, closed by dragging a
  marked card.
- **A group ends with its last card** (2026-10-06): no empty groups to clean up. Deleting exists for
  groups whose last cards sit in the archive, out of the ring's reach.
- **A project the owner does not work on collapses** (2026-10-21): it stays in sight and needs no
  second list. Rejected: hiding projects into a list beside the archive, filtered by the plan doc's
  git author („Nur meine Projekte“).
- **`?` and "Neue Aufgabe" only teach** (2026-10-15). Rejected: a permanent `?` button, and "Neue
  Aufgabe" creating a card mid-view.
- **A card's title is optional** (2026-10-15). Rejected: a required title, which dropped untitled
  cards with their text.
- **Archive, queue and "Neue Aufgabe" sit left in the bar** (2026-10-09). Rejected: the queue inside
  the Koordinator's sheet.
- **The usage limits come from Claude Code's `/usage` data** (2026-10-28), asked through the
  Agent SDK of an idle session. Rejected: calling the plan's usage endpoint directly with the OAuth
  token read from the keychain or Claude Code's credentials file, which ties Obeya to where and how
  Claude Code keeps its login; and the rate-limit events of running agents alone, which say little
  until a limit is close and nothing while no agent runs. The SDK marks the call experimental: when
  it changes, the bar shows nothing until Obeya follows.
- **The usage limits outlast the last page by half a minute** (2026-10-29). Rejected: closing the
  session and forgetting the numbers with the last page, which left the bar without them for the
  seconds a new session takes after every switch of canvas.
- **The bar measures what fits** (2026-10-12). Rejected: container queries on the bar's width, which
  let a long branch or a large pool push buttons under the sheet.
- **An unfolded card is as large as its content, up to the room it has** (2026-10-08, 2026-10-21).
  Rejected: filling the room (empty space, stray scrollbars), a fixed size (small on a large
  screen), and a proposal sized by its text alone (a long conversation scrolled in a small box). It may reach over the bar (2026-10-09), as keeping the bar free cost moderate windows much
  room.
- **The sheets are a docked sidebar** (2026-10-06, 2026-10-09). Rejected: panels floating over a
  full-window canvas, which cut off cards and covered the microphone. Obeya's button becomes the
  sidebar's corner (the owner's wish) rather than sliding with the bar.
