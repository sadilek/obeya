## The canvas

A chapter of the [design doc](../design.md), whose header says how it is written.

The UI is a browser app with a custom canvas: camera with fly-to, unfold-in-place, semantic zoom,
edge indicators, minimap, and a frosted top bar the canvas slides under.

### The bar

Left, after the navigation's button (see The navigation): the search's place, the archive's button
(see Archive), the queue's and "New task". The queue's button counts the waiting cards; a click
lists them in turn, each with what it waits for, buttons to move it and a × that takes it out of the
queue at once, as "Take out of the queue" on the card does (back to planned; no undo, starting it
again is the way back); a row opens its card. The navigation's, the archive's and
the queue's lists close on a click beside them and on Esc. Obeya's button is the rightmost (see
Sheets).

`/` drops down a field like the archive's, the quick way to a card. The bar has no search button:
until `/` has been used once (per browser), a button "Type / to search" stands in the search's
place, shown only once the canvas holds more than five cards so that it does not distract a new
owner; a click on it explains the key, and after the first `/` it is gone for good once that search
closes. Opening and closing the search moves nothing else in the bar: without that button the
search's place takes no room. The empty field's placeholder says what the search looks through;
no line under it explains more. Only the list scrolls, under the field, which stays in sight; it ends above the microphone at
the bottom middle instead of covering it. Before the first
word the search lists every card on the canvas, the one where something happened last first: a
change the owner sees (its state, its title or text, also in its plan doc, its status, its
handover, its pull request), or a line in its conversation other than a worker's tool activity.
Moving a card, grouping it, folding a project and the bookkeeping behind a card (its session, its
workspace, what was read) do not count. With the first word, it finds the cards on the canvas, and below
them those in the archive, that hold every typed word, matched as the archive's search does. In each
part, the card a word names by its number comes first, then cards with every word in the title, then
those holding them only in another field the archive's search reads, with an excerpt that shows the
words there. Each list shows 30 cards and
counts the rest.

The row under the pointer, or the one the arrow keys pick, lights its card up on the canvas with a
ring in its state's colour that breathes; the camera stays where it is. A card out of sight lights
up its edge indicator instead (shown for it even when it does not need the owner), a workstream of a
collapsed project its project; an archived row lights up nothing. A card half or more behind the
open list counts as out of sight: its indicator stands beside the list and points under it, as does
any edge indicator that would stand under the list. Leaving the list or closing the
search ends it. Enter opens the picked row, as a click does. A card on the canvas opens in place and
the search closes (a workstream of a collapsed project opens its project). An archived card unfolds
from its row, and the list stays under the dim to fold back into, as in the archive. The search
keeps its words between openings. The archive and the search drop down one at a time. The phone
view has no search.

Right, before the workspace pool: the usage limits of the plans Claude Code and Codex on this
machine are logged in with, every limit of a plan as a thin meter, one above the other in the
order of the list below, without labels or numbers (the session's, five hours, above the week's for
all models and the week's for a single model), coloured in the grade the plan's usage endpoint gives
it (warning, critical; for Codex, which gives none, from 80 % and at 100 %). A tick on each meter
marks how much of its window has gone by (Claude's session five hours, its week seven days, a Codex
window as long as Codex says it is, counted back from when it starts anew; no tick where the length
or the reset is unknown): green while the usage is at or under it, red once the usage runs ahead of
the time, so a glance tells whether the limit lasts until it starts anew. The bar shows
every plan with a login, whether agents run on it or not, each beside its name ("Claude", "Codex")
when it shows two, without one when it shows one. A click lists every limit of
every plan (the session, the week for all models, the week for a single model) with its meter and
percentage, when it starts anew and how long until then ("in 3 h 12 min", counting down while the
list is open), and where the numbers come from and as of when; a line under it says what the tick
means, for whoever sees it the first time, until they put it away with "Got it" (kept in the
browser). "Usage limits in the bar" under Configuration → General turns them off and on (on until then). The phone view shows
the same at the right of its bar; its list hangs from the bar as wide as the screen.
The numbers come from the data behind Claude Code's `/usage`: one idle Claude Code session, which
sends no prompt and so uses none of the limits, is asked a little over every minute (it keeps an
answer for a minute) while the setting is on and a page of Obeya is open, and closed once neither
holds, half a minute after the last page closed: a reload finds the numbers there and shows them
in the bar from its first frame, and a switch to another canvas keeps the bar as it is. Nothing shows for a login without plan limits (an API key, a cloud provider), a Claude Code
too old to answer, or numbers that could not be fetched again for five minutes. The workers on other
machines may use other logins; the bar shows this machine's.

Right of the usage limits, while "Costs" is on (see What agents cost in Agents and workspaces):
what all agents on the canvas cost so far ("≈ $5.52"), its archived cards' and Obeya's own agents'
included. A click lists the cards that cost the most (five at most, projects left out, since their
figure holds their workstreams'), each opening its card, and what the figure is.

The bar has no hint line. `?` (or the round `?` button) shows the legend of mouse and keys, ending
with the link "Report a wish or a bug" (see Wishes for Obeya's makers). The button only teaches
the key: the legend says so, and once the key has been used the button is gone for good (per
browser).

The buttons always fit: when the contents outgrow the bar (a wide sheet, a narrow window), it gives
up in steps the wordmark and branch, then labels a few at a time, then the workspace pool, the usage limits, the costs and `?`,
then all but the sheets' buttons and the navigation's, which keeps its count and loses the canvas's name. The step is measured from the actual contents, since the same
width may hold a short or a long branch, one clone or three.

The logo (three cards in the inks of working, waiting and approved, "obeya" in Newsreader) opens
the bar, stands alone while the page loads (above "offline" when the server is gone), and is the
favicon and the app icon's source (`scripts/logo.tsx`).

### The navigation

One element at the bar's left holds the canvases and what waits for the owner on all of them, in
place of a canvas switcher, a count of this canvas's cards that need the owner, and an inbox. Its
button names the canvas and its home branch (or its count of repositories) and counts, in the
orange of a waiting card, everything that waits for the owner on every canvas: the cards that need
them, and per canvas one for Obeya's answers waiting unread; the app's icon carries the same number
(see App). The count stands still: it always sits in the same place, so the eye finds it without a
pulse. A click lists under it "Needs you", the phone's list (see The phone view), built once
for both: the same entries in the same order. Its head carries no count, the button just above it
has it; pinned as the sidebar (below), where the button is gone, the head counts what waits on
every canvas in its stead. A snoozed card is neither listed nor counted until it comes back (see Snoozing a
card). Each entry is a light row, its title and what it waits for since when, without the waiting
card's orange frame, set apart from the next by a line, and the card open now is marked in it.
With several canvases, each canvas in the configuration's order heads what waits on it, in a
shaded head row that sets the canvases apart, the open one in full ink; a click on the row switches there, it counts what waits on that canvas, and it carries
its agents' pause (see Pausing a canvas's agents). An arrow at the head's left folds the canvas's
entries away and back; folded, the head keeps its count, and which canvases are folded holds per
browser, in the list and the pinned sidebar alike. With one canvas the list has no such heads. A
click on an entry opens its card, on this canvas or by switching to its own, and closes the list;
Obeya's answers open Obeya's sheet on their canvas. Nothing waiting says so, and the canvases are
still listed.

A switch to another canvas (its head in the list, an entry of it, a link to it, Back or Forward
between canvases) stays in the page instead of loading it anew: the canvas shown stays until the
other one's cards have arrived and then gives way to it at once, while the pinned navigation and the
bar stay where they are. The switch is a step in the browser's history, so Back returns; what the
owner entered on the canvas left (drafts, Obeya's sheet left open over one) is there again on
return, as after a reload. A canvas the page does not know yet (one started since it loaded) loads
as a page.

The entries only open cards: no button on them approves, accepts, answers or dismisses anything.
Tab still goes through the cards of this canvas that need the owner and Obeya's answers (see the
legend).

The list's head has a button that pins it as a sidebar docked to the window's left edge, full
height, as the sheets are on the right (see Sheets); the same button, pressed, unpins it. Pinned,
the bar's button is gone (the sidebar is its place now) and the open canvas's name heads the bar
in its stead, so which canvas is open reads at a glance rather than from the sidebar's ink, a click on an entry leaves it open, and
pinning holds per browser, on every canvas. Unlike a sheet it is not dimmed while a card is open:
the open card is marked in it, and a click on another entry opens that one in its place. A narrow window, or one that would leave the canvas
less than about a column of cards beside the sidebar and an open sheet, folds it back into the
bar's button until there is room again: the two sidebars never stack, neither over each other nor
side by side on one edge. In the app on a Mac the sidebar reaches up to the window's top, so the
traffic lights move from the bar into its head, which stays in place as the list scrolls and drags
the window as the bar does; the bar beside it then starts at its own edge.

### Creating cards

A double-click or `n` creates a card and unfolds it with the cursor in the text field. The title is
optional: a card closed or started with text or screenshots but no title gets one from a short
session of the "Small jobs" group (else the text's first line) before its start is judged;
meanwhile the canvas shows the first line, muted, and a title the owner types wins. A card left
empty is dropped (one left by a closed page on Obeya's next start). Deleting offers undo.

An empty canvas names speaking first (hold Space and say what to build; the card appears at the
pointer), the double-click second. The bar's "New task" only teaches the double-click (a note
with "Got it") and goes for good (per browser) once a card has been created by double-click.

### Cards on the canvas

Cards have one fixed size; a delivered workstream shrinks to a chip (`W3` and its title) once its
agent is done. A project wraps its workstreams, which cannot be dragged out; new projects go below
the existing ones. A proposal or follow-up goes below its card, or, when that spot is taken (for a
workstream: by its own project), to the nearest spot clear of everything. The dashed line from a
proposal, follow-up or prototype to its card joins the facing sides and runs above projects but
below cards. Where a wait joins the same two cards (a follow-up queued behind the card it came
from, say), only the wait's arrow shows: both lines would take the same course.

A project's head shows its title in full, wrapped where the project is narrow, with "Project", its
progress and its number after the last word. Only two lines fit above the workstreams, so a project
is at least as wide as its title needs for two (a collapsed one grows a line taller instead); the
server sizes projects too, so the title's width is estimated from its length, not measured. Its
buttons ("Arrange", "Start all N", "Archive" once done) show while the pointer is on the project,
at all times on a touch screen, and zoomed out as well, a size larger so they stay legible: beside the title where all of them fit on its line, else all
together in a "…" menu at the head's top right, whose room the title always leaves, so it never
reflows. Never some beside the title and some in the menu.

The arrow before a project's title collapses it to its head ("Collapse", "Expand"), for
projects the owner does not work on (on a shared repository every colleague's plan docs are
projects). Collapsed, it shows title, progress, start button, the badge of workstreams that need the
owner, the bubble of its agent's unread answers (see Asking in a project's sheet), and a mark per workstream in its state's colour that names and opens it. Its workstreams stay
in the project's sheet and the queue, and an edge indicator for one that needs the owner points to
the project. Nothing around it moves. Collapsing is stored in this Obeya, not in the plan doc, so it
holds across reloads, devices and the archive.

A planned or queued card shows a play button under the pointer that starts it without unfolding.

Every wait between cards on the canvas shows at all times as a thin, solid, grey arrow from the card
waited for to the card waiting, under the cards and above projects like the dashed line: only direct
waits, not the chain. All kinds of wait look alike (a card queued behind another, a workstream and
those it builds on, a card snoozed until another, an arrow the owner drew); a wait ends once the card
waited for is finished, so finished cards keep no lines. A workstream of a collapsed project shows
its waits at the project's head. The lines stay thin on screen however far the view zooms out.
Each line fades in from its start to its arrow head, so that where lines meet, the one that ends
there shows. Several lines meeting one side of a card spread along it instead of all ending in its
middle, in the order of the cards at their other ends, so that they do not cross on the way and an
arrow coming in stays apart from a line going out.
Under the pointer a card shows its waits both ways over every step instead, in the waiting colour:
the cards it waits for ("comes first") and those waiting for it ("waits for it"), each with a ring,
its own waits fully and each step further along fainter; a wait shows once, never as both. Only
colour and strength change: line, head and course stay as they were, so that moving the pointer
over the cards leaves the picture calm. What makes a card wait: see Scheduling.

Cards that wait for each other, directly or through others, can never start: Obeya refuses an arrow
that would close such a loop, but the waits it infers (a queue, a snooze, a plan doc read) can still
close one. A loop counts only the waits that hold a card back: a queue while the card is in it, a
snooze while it sleeps, an arrow or the plan doc's order until the card starts. A card at work still
shows its arrows and its plan doc's order as lines, but a loop through them stalls nothing and is
none. The waits of a loop are red at all times, and under the pointer a card in the loop with the
hovered one says it waits in a loop. One of its lines carries a button, "Resolve loop", that hands
the loop to Obeya in Obeya's conversation, which opens: its cards by number and title, and what holds
each wait in it. Obeya breaks it with the means it has for each kind of wait (starting a queued card
anyway, taking one out of the queue, waking a snoozed one), and says what it did.

The owner draws a dependency between two task cards: near the middle of a card's edge a dot appears
in the card's colour; a click on it starts an arrow that follows the pointer and snaps to the card
under it or close to it, a click there connects the two (Escape cancels). Until the owner has drawn
their first arrow, a line beside the pointer says what it will do while they draw: which card is to
be clicked, and once one is under the pointer, that it starts only once the other is done. The arrow
points from the prerequisite to the card that waits for it and stays on the canvas, as every wait
does, under the cards: a card it crosses stays clickable and draggable all over. Under the pointer
it shows a trash button that removes it at once, with "Undo"; the button sits on the arrow's
middle, or the nearest point along it no card covers. It is grey like the canvas's other remove
buttons, darker under the pointer, and keeps its size on screen at every zoom, as does the band
along the arrow that shows it. While the arrow holds a queued card, the
removal waits until the undo has run out (or the page closes), so taking it back never leaves a card
started. Projects and their workstreams get no dots, since the plan doc decides their order, and
inferred waits have no trash button. An arrow that would close a cycle with other arrows or waits is
refused, and the line says why: the card it starts from already waits for the other, directly or
through other cards, so the two would wait for each other. One to or from a project or a workstream
is refused the same way, saying the plan doc gives their order. A deleted or archived card's arrows are hidden and count for nothing; bringing the card
back brings them back, except one that would now close a cycle. How an arrow holds a card's start:
see Scheduling.

#### A project arranged by its dependencies

A project's workstreams can stand in columns by what builds on what: leftmost what can start at
once, each further column one step along the longest chain of open workstreams. Delivered
workstreams stay in rows of chips above. Within a column cards follow what they build on, so arrows
cross little, else the plan's order; a column holds four cards and overflows into one beside it.

Plan docs state dependencies in prose ("Needs W1", "after W2", or only implicitly), so the
Coordinator reads them in a turn of its own: for each open workstream the ones it builds on
directly. The reading is kept for the doc as it stood; under the pointer a workstream shows the open
ones it builds on as waits (see Cards on the canvas), and the project's sheet lists the
workstreams in this order with what each builds on.

A project arriving with two or more open workstreams is arranged once read, unless the owner has
moved one of its cards meanwhile. "Arrange" in its head (or in its sheet) arranges it again, after a
new reading if the doc has changed; it takes effect at once, with "Undo". A project that grows
into other cards moves to the nearest clear spot.

### Moving around

A press on the canvas drags or pans and never selects text: none of the canvas's text (a project's
title, say) is selectable, and a press first clears any selection left elsewhere on the page, which
would otherwise turn the drag into the browser's own drag of that text and leave the card in place.

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
decisions stays in view at its foot while a long text scrolls, so a planned workstream shows "Start
agent" without scrolling.

A card whose conversation stands alone is a conversation wide. A card with a conversation beside
what it is about (an idea, a proposal, a task with a result) is a wide split, the conversation a
third, as tall as its taller column. An open card sits in the middle of the canvas; where the canvas
is too narrow for it, it reaches over the docked sheet, which lies dimmed under it anyway, but not
over the pinned navigation, which stays usable beside it. Each
column scrolls on its own, the panel never. A Question card is its conversation alone at a card's
width, growing with it up to the room above the microphone before it scrolls, like a split's column:
a looked-up answer is long, and a box of fixed height left most of the window unused. A proposal's
text box grows until the reason below it would leave view.

### Addresses

The page's address names what it shows: `/c/<canvas>` a canvas, `/c/<canvas>/card/<code>` a card
or project open on it (the phone view: the card full screen). The code is the card's short code, the
first six hex digits of its id with one more digit for each card already holding those; its whole id
works in its place, and the page then shows the short one. The short code is given once, when the
card is made, and never changes, so a link stays good. Opening an address (a link, a bookmark, a
reload) opens that card at once, without the flight; an archived one unfolds from its
row in the archive, an archived workstream from its project's sheet; a code no card has leaves the
canvas open at its own address. Query addresses (`/?c=<canvas>&card=<id>`) are rewritten to this
form, so old links and bookmarks keep working. What else the page shows that is
not a place (`?view=phone`, the phone's open conversation `?talk`; on the canvas `?talk` opens
Obeya's sheet once, as the navigation's link to an answer on another canvas does) stays in the query.

Opening a card or a project is a step in the browser's history, on the canvas as on the phone: Back
closes it again, and closing it (Esc, the close button) goes back that step, so Back after closing
leaves the page rather than opening the card again. A card opened from a project's sheet is a step on
from the project's; one opened in place of another (by a link in it) takes over that one's step, so
Back from it returns to what was open before the first. Where a card names another (what a queued
card waits for, the card a follow-up or a proposal comes from, the card that replaced a proposal, a
prototype's idea and project, what Obeya waits on), the name is a link to that card while it is on
the canvas: a click opens it in place of the open one, a click with a modifier in a tab of its own.
Card faces on the canvas link nothing, since a click there opens the card itself.

### Card numbers

Every card has a number (`K42`): counting across all canvases of this Obeya, given once when the
card is made and never again, also once a card is deleted. A card keeps it when it moves to another
canvas. The number stands at the start of the card's state line on the canvas (its end is where
the card's buttons show under the pointer), at the top right of an entry in the phone's lists
(where the state line, wrapping on the narrow screen, has no room to set it apart), at the end of a
project's head, beside the close button of its sheet and at the end of the phone's bar over the
card. A click on it (outside the lists, whose entries open the card) puts it on the clipboard and
says "Copied" for a moment; under the pointer it shows a copy icon, on a touch screen always. Where
the page may not write the clipboard, it copies or selects the number as a code block's button does
(see Conversation on the card), also on the canvas, where no text is selectable otherwise; it says
"Copied" only when the number is on the clipboard. The form is the same in every language.

The owner names cards by it, to Obeya and to the agents, typed or spoken (speech recognition may
write `K 42` or `Ka 42`, which count too). The Coordinator knows every card by it (see Coordinator
memory); an agent that reads the owner's words (a note, an answer, feedback, the task) is told which
card each number in them names, with its title and where it is (another canvas, the archive,
deleted, the agent's own card).

### Sheets

The sheets (Obeya's, a project's, a plan doc being read) are a sidebar docked to the window's right
edge, full height; the pinned navigation is one on the left edge. The canvas is the rest between
them: the top bar, the microphone and its confirmations, the edge indicators, the minimap and an
unfolding card all keep to it. Opening, closing or resizing a sheet, or pinning the navigation,
shifts the view so its middle stays in the middle of the rest. What is docked as a canvas comes up (the
pinned navigation on every switch of canvas, a sheet that comes back) takes its room at once: the
view returns beside it without a shift, as if it had always been there. A card opened beside a sheet
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
  The owner's turn is an orange frame (thicker zoomed out, but on the same cards at every zoom: none
  on a snoozed card, 2026-11-11) and a pulsing pushpin with "!" (the pulse, a halo growing and
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
- *Light or dark*: as the system until the owner picks Light or Dark (or the system again) in Configuration (`theme` in
  Obeya's `settings.json`). The page reads it before its first render and applies a change without
  reload; `color-scheme`
  follows so native controls and framed pages (a worker's HTML artifact, a mock) match. The site and shared demo pages follow the system.
- *Type*: titles and headings in Newsreader (a plan doc in the sheet too), the rest in IBM Plex
  Sans Condensed, code in the system monospace; both fonts SIL OFL and self-hosted, no Google Fonts.
  A walkthrough's slides and captions alone take showntell's faces, Bricolage Grotesque and Inter
  (see Walkthroughs in The Coordinator).
- *Carried through*: menus, panel, sheets, dialogs, buttons and fields share palette, type, corners
  and hard shadow; dots, the microphone, spinners and the pin stay round. The site and shared demo
  pages use the same palette and type.

### Groups on the canvas

A group shows as a territory behind its cards: a soft glowing outline over a faint area in its
colour. Group colours appear only there, in the group's name and in the minimap, never on a card,
so they do not compete with the state inks. A group's name stands along the edge of its territory's
largest piece, the same for one card and for many: far out (below the zoom at which cards show only
their titles) large and pale, closer in as a small header in capitals in the group's colour, at a
fixed size on screen; the two cross-fade where the cards change look. It goes to the first spot
where it covers no card (nor a note on the canvas): above the top edge, centred, then slid along
that edge to the free spot nearest the middle; then hanging below the bottom edge, the same way;
then beside the side nearer the piece's centre of mass (on a tie, the right), then the other side,
centred vertically and then slid along it. A spot that also keeps clear of the other groups'
territories and of the names placed before it wins over one that only keeps clear of the cards, so
a name does not read as a neighbour's and two names do not run into each other. Only far out, where
nothing is free, it goes inside the piece over the cards, drawn above them, where it crosses the
fewest card titles, a project's workstreams included (on the blank part of a card below its title),
nearest the centre of mass, clear of the holes in the piece where other groups' cards stand;
closer in, where titles are what one reads, it stays above the top edge, under the cards that cover
it. Along an edge it is drawn over the territories and under every card. A name holds its spot
while that stays free and no better spot has opened, sliding back towards the middle as far as is
free, so a card dragged past does not make it flicker from side to side; once the card has gone it
is back where the rule puts it. Zooming does not move the names on every frame: they are placed
anew once the zoom has changed by a few per cent, in boxes that hold them at any zoom in between,
and a moved card moves only the names near it. Fitting the canvas into view (`0`) takes in the
names that stand outside the cards, at the zoom it comes to, so none ends up behind the bar where
the canvas fits at all.

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

When cards change group, from wherever (the colour ring, the Coordinator, another page), a wave
runs out from where it was assigned, the territory overshoots and settles, and a light runs once
along the new edge, all in under a second (see the decision on large animations).

Marking: Shift + drag draws a lasso (without Shift it pans), Shift + click toggles a card (a
workstream: its project; a click beside a project's workstreams marks the project); a lasso adds to what is marked. Marked cards carry drifting dashes and a
line with their count and "Group …". Dragging a marked card moves all marked ones, an unmarked one
alone. A click on the empty canvas or Esc unmarks. Two hints teach it, each until used once: after a
card was moved alone, how to mark several; beside two or more marked cards, that dragging one moves
them all.

Assigning: "Group …", or a right click on a card (that card, a workstream's project, or all marked ones if it is among
them), opens a ring of colour balls: the groups, "+" (a new group, named in place) and "∅" (none).
Each group's name stands beside its ball with its count of cards still to be done (not finished, archived or a dropped idea; a project by its workstreams); a group at 0 goes
pale, a candidate for deleting. Behind the ring the canvas steps back under a frosted halo and holds
still. Moving towards a ball picks it, a click takes it, Esc closes the ring. The picked group's ×
deletes it (its cards, archived ones too, belong to none), with "Undo".

The Coordinator has the tools `group` (by name; a new name creates the group), `ungroup` and
`rename_group`, and sees each card's group.

### Refusals

The server words no UI text for refusals: it answers with a stable error code and an English detail
for developers (a failed start's log entry carries the code too). The UI shows its own text per
code, a generic one otherwise.

### Decisions

- **A group's name stands along its territory's edge, at every zoom** (2026-11-12; its colour
  closer in kept by the owner, 2026-11-13): at the territory's centre and drawn over the cards it
  landed on a title (with one card, right over it), and closer in a group could be told only by its
  colour. The small header closer in keeps the group's colour, which ties it to its territory.
  Rejected: a solid tab on the top edge (heavier, and a group colour over a card); hiding a name
  that finds no free spot (it should stay visible); showing names only far out.
- **The search stays in the bar and is the quick way to a card** (2026-11-01, owner): before the
  first word it lists the canvas's cards, the last changed first, and the archive joins only with
  the first word so the list stays short; a row under the pointer lights its card up where it
  stands instead of flying there, since the view would jump with every movement of the mouse.
  It opens with `/`, the key that searches on GitHub and elsewhere, and the bar teaches the key with
  a button that goes once the key is known, as `?` does, instead of a search button there for good
  (owner, 2026-11-04). Rejected: a sidebar on the right like Obeya's conversation (it would take
  the edge Obeya's sheet docks at, for a list that is closed again after one pick); a button beside the microphone (the bottom middle is for what goes to agents, and the
  list would open over the middle of the canvas); the archive's filter for active cards too (no one
  looks for an active card in the archive).
- **The search across canvas and archive matches as the archive's filter does, with no fuzzy
  matching library** (2026-10-30, owner). Rejected: fuzzysort, whose subsequence matching tolerates
  left-out letters but, over a card's long text, finds nearly any scattered letters and needs score
  thresholds to keep that out; one way of matching across Obeya is easier to predict.

- **Cards have a running number, `K42`, counting across all canvases** (owner, 2026-11-03): the
  owner names cards by number to Obeya, and a tag given afresh in each session (K1, K2, …) made
  „archiviere K7“ in a later session hit another card. The number is what the owner already typed,
  is easy to say, and stays the card's own wherever it goes. Rejected: `#42`,
  which GitHub turns into a link to the issue or pull request of that number in commit messages and
  comments; the hex short code of the address, which is hard to dictate and to recognise; a number
  per canvas, which a card moving to another canvas would lose and which would name two cards where
  the Coordinator or a worker speaks of another canvas's card.
- **One navigation on the left for canvases and what waits** (owner, 2026-11-02): what waits for the
  owner was split between "need you" (this canvas), the switcher's counts (the others) and the
  cards themselves; an inbox would have been a fourth place. Its list is the phone's "Needs you", so
  the two never drift apart. A click on an entry always leads to another context, so the list is a
  popover that closes, pinned only by choice on a large screen. Rejected: one-click actions on the
  entries (approve, accept, dismiss, keep or remove, an answer option), since a click there is made
  blind to the card's demo, open questions and remarks, and a decision the owner can make blind is
  one the agent should not have asked for; an inbox as a sheet on the right, which competes
  with Obeya's sheet for the same edge; and the phone's card faces in the list, whose orange frames
  say nothing where every entry waits for the owner and make the list loud.
- **The navigation's count does not pulse** (owner, 2026-11-09): it pulsed to draw the eye, but
  it always sits in the same place, so it is found without. The pulse made every recording of the
  canvas jerk: together with the bar's backdrop blur and the demo overlay's clock strip, which
  changes every frame, Chrome's screencast sent no frame for 0.27 s once per pulse (every 1.8 s);
  as a compositor-only scaled layer it did the same. Rejected: dropping the bar's blur or changing
  the overlay instead, which either also ends the gaps; the bar keeps its look and the overlay its
  clock.
- **The total is counted once on screen** (owner, 2026-11-11): the list opened under the button
  repeated the button's count in its head, right below it. Docked, the button is gone, so the
  sidebar's head keeps the total.
- **A snoozed card leaves "Needs you"** (issue #50, 2026-11-03): the owner put it off, so it
  waits for nobody until it comes back, and listing it under what needs them (uncounted, at the
  end) only made the list longer. On the canvas it still stands, greyed; on the phone it moves to
  the end of "Running", which already ended in the snoozed cards there.
- **Each canvas folds by itself, not as an accordion** (2026-11-03, issue #49): the
  owner folds away canvases they are not attending to while keeping several open side by side; an
  accordion would close one canvas as another opens, hiding what waits there. The counts on the
  heads keep a folded canvas's waiting cards in view.
- **Waits are always on the canvas, as faint lines** (owner, 2026-11-02): with waits shown only
  under the pointer, the overall picture was missing, and one forgot that Obeya tracks them at all.
  There is no switch to hide them. Rejected: stubs at the cards' edges only (they say there is a
  dependency but not the picture), and a layer behind a button (it does not keep the waits in
  mind).
- **A loop of waits is red, and Obeya resolves it** (owner, 2026-11-05): a loop stalls every card in
  it without anything saying so. Obeya resolves it rather than the owner picking a wait to drop,
  since it knows why it inferred each one. Rejected: a proposed card for the resolution (a card
  would take a worker and a workspace for what is a reordering).
- **The owner may draw dependencies between task cards** (2026-11-02), beside the waits Obeya
  infers: single cards have no plan doc to say what comes first, and the owner sometimes knows an
  order that a conflict check cannot see, without wanting to turn the cards into a project.
  Rejected: arrows to or from projects and workstreams, whose order the plan doc decides; a trash
  button on inferred waits, which Obeya would infer again at the next start; a confirmation dialog
  before removing an arrow, where "Undo" does the same with one click fewer.
- **Path addresses with short card codes** (owner, 2026-11-01): a card's address is a permalink
  that survives a reload and can be passed on, and paths leave room for views nested deeper. The
  code is stored, not derived from the cards there are at the time, so a later card whose id starts
  alike cannot make an earlier link ambiguous. Rejected: query parameters (`?c=`, `?card=`), and
  the whole id in the address, which is long to read and pass on.
- **Switching canvases stays in the page** (owner, 2026-11-03): loading the page anew blanked it
  for a moment on every switch, the pinned navigation included. Rejected: a page load smoothed over
  by cross-document view transitions, which still reveal the new page's first frame before its
  canvas has arrived, and not in every browser.
- **Closing a card goes back a step** (owner, 2026-11-02): an open card is a view over the canvas,
  like a dialog, and the phone already closed cards that way. Rejected: closing as a step of its own,
  after which Back opened the card that was just closed.
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
  git author ("Only my projects").
- **A project's buttons go into a "…" menu where they do not fit beside its title** (owner,
  2026-11-09): the title had shrunk to its first letter in a project of one column. Rejected: a row
  of their own under the title (it lies under the first workstream once the title wraps, unless
  every project's workstreams start lower), the top right beside a narrower title (a long one
  then needs a third line and reflows as the pointer enters), and the project's top edge (covers
  what lies just above it).
- **`?` and "New task" only teach** (2026-10-15). Rejected: a permanent `?` button, and "New
  task" creating a card mid-view.
- **A card's title is optional** (2026-10-15). Rejected: a required title, which dropped untitled
  cards with their text.
- **Archive, queue and "New task" sit left in the bar** (2026-10-09). Rejected: the queue inside
  the Coordinator's sheet.
- **The usage limits come from Claude Code's `/usage` data** (2026-10-28), asked through the
  Agent SDK of an idle session. Rejected: calling the plan's usage endpoint directly with the OAuth
  token read from the keychain or Claude Code's credentials file, which ties Obeya to where and how
  Claude Code keeps its login; and the rate-limit events of running agents alone, which say little
  until a limit is close and nothing while no agent runs. The SDK marks the call experimental: when
  it changes, the bar shows nothing until Obeya follows.
- **Codex's limits come from its app server's `account/rateLimits/read`** (2026-11-03), asked of an
  idle app server as Claude Code's are of an idle session; its windows take the session's and the
  week's place by their length.
- **The bar shows every plan with a login** (owner, 2026-11-04): what is left of a plan is what the
  owner decides on before starting an agent on it, a card on Codex say, so it shows while no agent
  runs there yet. Rejected: only the plans agents run on, which hid Codex's limits until a Codex
  agent ran; the owner pinning plans, a setting more.
- **The bar's usage limits are a meter per limit without labels or numbers** (owner, 2026-11-05), on
  the desktop as on the phone: a meter with its label and percentage per group took much of the bar
  and ran off a phone's screen, the list under it cut off with it. The numbers are in the list.
  Every limit has its meter, not only the most used of its group, so the bar shows what the list
  shows. Rejected: only the most used limit's percentage per plan, with or without a meter under
  it, and a ring per plan, which fit as well but merge the limits into one value. The list has no "Hide":
  the phone has no configuration to show the limits again, and the setting is where turning them off
  belongs.
- **The usage limits outlast the last page by half a minute** (2026-10-29). Rejected: closing the
  session and forgetting the numbers with the last page, which left the bar without them for the
  seconds a new session takes after every switch of canvas.
- **The bar's lists open on a click, not on hover** (owner, 2026-11-02 for the usage limits,
  2026-11-03 for the workspace pool), as its other menus do; the pool's pill, like the usage limits,
  shows no "▾". Rejected: hovering, which spread the list over the canvas whenever the pointer crossed the
  bar.
- **The bar measures what fits** (2026-10-12). Rejected: container queries on the bar's width, which
  let a long branch or a large pool push buttons under the sheet.
- **An unfolded card is as large as its content, up to the room it has** (2026-10-08, 2026-10-21).
  Rejected: filling the room (empty space, stray scrollbars), a fixed size (small on a large
  screen), and a proposal sized by its text alone (a long conversation scrolled in a small box). It may reach over the bar (2026-10-09), as keeping the bar free cost moderate windows much
  room, and over a docked sheet (owner, 2026-11-02): the sheet is dimmed and out of use while a card
  is open, and keeping beside it squeezed a split into the canvas's width.
- **The sheets are a docked sidebar** (2026-10-06, 2026-10-09). Rejected: panels floating over a
  full-window canvas, which cut off cards and covered the microphone. Obeya's button becomes the
  sidebar's corner (the owner's wish) rather than sliding with the bar.
