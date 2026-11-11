## Running Obeya

A chapter of the [design doc](../design.md), whose header says how it is written.

### Server

Bun, TypeScript. HTTP + WebSocket to the UI, one API per canvas (`/api/c/<canvas>/…`,
`/api/canvases` lists them); SQLite under `~/.obeya/`. `obeya <repo>…` starts one canvas with the
given repositories (`--name` names it); `obeya` starts the canvases `~/.obeya/canvases.json` lists,
`obeya --config <file>` those of another file. Without that file (the first start) it serves no
canvas, and the page is the setup assistant (see Setup assistant).

One Obeya per home: a running one writes its port and its supervisor's pid into `server.json` in
its home, and a second start on that home says where the first runs and
ends. An entry whose process is gone, or alive but silent for 5 s (another program got the pid), is
stale. A supervisor restarting its server marks the entry `restarting`, and a start meanwhile waits
up to 90 s for it, so the app started during a checkout's self-update opens that Obeya.

The app and a checkout share the home (`OBEYA_HOME` moves it for both): canvases, settings, voices,
models and worktrees carry over, and workers one paused the other resumes. The database starts from
the schema Obeya was released with; later changes are migrations. An Obeya older than the database
(`PRAGMA user_version` above its migrations) leaves it alone and says to update; a database a
pre-release Obeya left below the release schema is left alone too, naming the commit to start once.

A page hears of changes over a WebSocket: its canvas's snapshot after every change, a card's new log
lines, what is server-wide (a waiting restart, a newer version, the usage limits, what waits for the
owner on each canvas). What goes to another device is compressed (`permessage-deflate`; the JSON
shrinks to about a tenth), what goes to this machine is not. A page that falls behind (more than a
quarter of a megabyte unsent, a phone on a slow network) gets no snapshot queued behind those it has
not received yet, those it is sent as it connects included: once it caught up, it gets the newest of
each canvas it missed one of, one after the other while it stays caught up.

#### Who may talk to it

Only the owner. The server listens on `127.0.0.1`, which every program and account on the machine
reaches, and some routes run commands as the owner. So every request and WebSocket upgrade is
checked first for coming from Obeya's own site and for naming the owner.

*Its own site.* Any page in the owner's browser may send requests to `127.0.0.1` (a `text/plain`
POST needs no preflight and is parsed as JSON all the same), and a DNS name rebound to `127.0.0.1`
reaches it under that name. So `Host` (and `X-Forwarded-Host`) must be one of Obeya's names
(`localhost`, `127.0.0.1`, `[::1]`, and while other devices reach it the tailnet name or the address
it listens on; any port), else 421; an `Origin`, where present, must be Obeya's own (as
`X-Forwarded-Proto`/`-Host` say behind `tailscale serve`), and `Sec-Fetch-Site: cross-site` is
refused, else 403. A top-level navigation from another site to a page outside `/api/`
(`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`) passes: it only shows the page, and a phone
scanning the QR code often arrives that way; in another site's frame the page gets nothing. Requests
with neither header (the app's shell, scripts)
pass. Bun serves an HTML bundle past any handler, so the page lives at a
path made up at every start, fetched from there once the request passed.

*The owner's key.* 32 random bytes in `owner.key` in the home, readable by the owner alone. The
app's shell and Obeya's scripts send it as `X-Obeya-Key`; the page carries it in an
`HttpOnly; SameSite=Strict` cookie `obeya-<port>` (browsers keep cookies per host, not port).
Without it the API answers 401 `notOwner`, the page says "This browser is not signed in
to Obeya" with how to sign in, and no WebSocket opens. A page opened by a link from another site
lacks the `Strict` cookie: it gets a page that opens the same address again, now with it.

A browser gets the cookie from a link, as in Jupyter: `/login?token=…` (optionally `&next=<path>`)
sets it and goes on from a page of its own, since a redirect in a cross-site navigation (from another
app, the app shell's `tauri:` page) carries no `Strict` cookie. The token is made at every server
start and signs in any number of browsers until it stops; an older link says it no longer holds. Only
a holder of the key gets it (`POST /api/login-link`, local only): Obeya prints it at every start, and
a second start prints the running one's; the app's window signs in through it; "Open in
browser" (File menu on a Mac, the configuration) opens the default browser with a one-time token
(`once`), through the system's `open`, whose command line other accounts see;
`scripts/scratch-obeya.ts` prints it as `url` (`--login <port>` again). Once signed in, the address
alone opens Obeya: the cookie lives as long as browsers allow (400 days). Workers hold no key: their
narration goes to a server of its own that answers nothing else (their `OBEYA_URL`).

*The workers' files.* An HTML artifact or an answer's files load in a sandboxed frame of origin
`null`, so what its page loads goes without the cookie; it carries instead the key in the address
the frame's page is redirected to (see The demo on the card), which only the owner or a paired
device ever sees. The gate of other devices still applies.

The cookie goes to any server on `127.0.0.1` whatever its port: a page the owner opens there from
another account on the machine would see it.

#### Other devices

The owner's phone reaches Obeya over the owner's own private network; Obeya runs no service of its
own for it and is never on the open internet. "Reachable from other devices" (`remote` in
`settings.json`) is off by default (Obeya answers only on this machine). On, it is one of:

- *Through Tailscale*: Obeya stays on `127.0.0.1` and runs `tailscale serve --bg --https=<port>
  http://127.0.0.1:<its port>`, proxying HTTPS and WebSockets from `https://<machine>.<tailnet>.ts.net`.
  It takes 443, else 8443, else 10000, whichever no entry serves, and touches no other entry; it notes
  its own in `tailscale-serve.json` in the home, so it can move or remove exactly that one, after a
  restart too. Stopping, Obeya removes it, so a program taking its port later is not served to the
  tailnet. Renamed in the tailnet, the machine keeps its entries under the old name: nothing reaches
  them any more, but they hold their ports, since Tailscale keeps ports per machine. Obeya then
  removes its own there (the one it noted, and any that proxies to its port) and serves the new name
  on the best port they held, so the address stays without a port where it had none; other entries
  stay. `tailscale serve --https=<port> off` reaches only entries under the current name, so Obeya
  removes entries through `tailscale serve set-raw`, with the configuration it read minus its own. Bun's dev server answers for scripts only under the name it listens on, so an Obeya with
  `--dev` shows a blank page through `tailscale serve`.
- *At an address*: Obeya also listens, in plain HTTP, on an address of one of the machine's
  interfaces (another VPN's). The section says a phone's browser allows microphone and push only over
  HTTPS.

The configuration's section "Other devices" and the dialog "Connect a phone" show what the
network lacks, each with its one step: Tailscale missing (how to install it per platform), not
running, logged out, HTTPS off in the tailnet (a link to the admin console's DNS page), on Linux the
operator right `tailscale serve` needs (`sudo tailscale set --operator=$USER`), all three ports
taken. Ready, they name the Tailscale account for the phone to log in with, and while the tailnet has
no other device they say the phone is not in it yet and cannot resolve the address. While open they
check every few seconds, so each fixed step shows, and Obeya serves through Tailscale, without a click.
A `tailscale status` that takes longer than its 10 s (a machine under load) keeps the state found
before instead of calling Tailscale stopped. They also say that other devices
reach Obeya only while it runs here.

A request is *local* when it comes from loopback under one of this machine's names, unforwarded (no
`X-Forwarded-For`, `-Host`, `Forwarded`); through `tailscale serve` it is forwarded and counts as
remote, as does anything on the other address. A remote request needs a paired device; without one
the page is "This device is not connected to Obeya" with how to connect and a field for the code
(401), the API answers 401 `notPaired`, and no WebSocket opens.

*Pairing.* "Connect a phone", below the paired devices in the section, opens a dialog with a QR
code of `<address>/pair?code=<code>`, the address and the code in large digits. The code has six
digits, holds five minutes (renewed while the dialog is open) and only while the address stays the
one it was made at, and pairs one device; five wrong tries
spend it (counted only from Obeya's own page or without `Sec-Fetch-Site: cross-site`, so another site
cannot spend them). The phone gets the device cookie `obeya-device` (32 random bytes; the database
keeps its SHA-256, a name from the user agent such as "iPhone · Safari", and when it was paired and
last seen) and goes on to the phone view, and the dialog says "iPhone · Safari is connected.". The cookie is `HttpOnly`, over HTTPS
`Secure; SameSite=None`, over HTTP `SameSite=Lax`.

*Devices.* The section lists them with when paired and last seen, each with "Remove", which acts
at once without undo: its open pages lose their WebSocket and reload to the page that says how to
connect. A device stays paired until removed or unused for 90 days. Pairing, devices and the setting
are managed only on this machine (`/api/access…` answers another device 403 `onlyHere`, and the
section shows it only its heading and hint).

*The app on the home screen keeps its address.* Added to a phone's home screen, Obeya opens the
address it was added at, which Obeya cannot change afterwards; once Obeya's address changes (the
machine renamed in the tailnet, another port, another address picked), that app gets no answer. Its
page says, whenever it connects, that it runs as that app (`?app` on its WebSocket), and Obeya keeps
per device the address it came under (`X-Forwarded-Proto`/`-Host` behind `tailscale serve`). While
that address is not the one other devices reach Obeya at now, the dialog "Connect a phone" and the
section say so above all else: "The address has changed", which device's app still opens which
address, and to delete it, scan the code and add Obeya to the home screen anew. A browser keeps its
cookie per name, so a new name means pairing anew: the new pairing replaces the entry of the same
device name whose app keeps another address (the most recently seen one), and the dialog then says to
add Obeya to the home screen anew and delete the old app. A new port keeps the cookie and the entry;
the notice goes once the new app has connected. The phone's own "Obeya is not answering" names a
changed address as one of the reasons and points to "Connect a phone".

*Keeping the machine awake.* While the setting is on, Obeya keeps its machine from idle sleep per the
switch "Keep this computer awake": *While an agent works* (default), while a worker is in a turn,
waits for its background work or lands, until two minutes after the last; or *Always*, so the phone
can give tasks while no agent works (`awake: "always"` in `remote`). Per platform:
`caffeinate -i -w <pid>` on macOS, `systemd-inhibit --what=idle:sleep` around `tail --pid=<pid>` on
Linux (both end with Obeya), `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` through
`bun:ffi` on Windows. The display may still sleep, and a closed laptop lid sleeps anyway, which the
switch's hint says. Workers on SSH hosts keep Obeya's machine awake, not their hosts.

#### The phone view

On a phone the page shows the phone view instead of the canvas, at the same address and from the
same bundle. A phone is a device with a coarse pointer whose screen's shorter side is under 600 px;
a tablet and a narrow window at the desk keep the canvas. `?view=phone` or `?view=canvas` decides
instead. The view is settled at load; turning the phone does not switch it. It holds one WebSocket
for every canvas (`/api/ws`): each message about one canvas names it, the server-wide ones come once,
and what waits for the owner is left out, since the canvases' snapshots hold it. Once the last canvas
stops while it is open, it goes to `/` (setup, or a canvas started since), as a canvas's own page
does once its canvas is gone. It shows five lists:

- **"Needs you"**: what waits for the owner across every canvas, canvas by canvas and within one in
  Tab's order, then "Obeya answered" where an answer waits unread, framed in a waiting card's orange
  (the answer is finished and waits for the owner, so nothing on it moves). Each card says what it waits
  for (its state line: "Demo ready", "Question for you" …) and since when (the server keeps that across
  restarts). A card the owner snoozed leaves it until it comes back (see Snoozing a card), and so
  does one set aside on the phone (below). Its heading counts what it shows. The canvas's
  navigation shows the same entries in the same order, built once for both, as light rows, those
  set aside on the phone among them (see The navigation).
- **"Running"**: the cards an agent or Obeya is at that wait for nobody (working, taking in the owner's
  words, landing, queued, in a PR, an idea's agent thinking …), with their status line, snoozed ones
  at the end, those the owner snoozed while they waited for them among them. Every card that leaves
  "Needs you" without being done stands here, unless it is set aside.
- **"Set aside"**: the cards of the two lists above that the owner set aside on this phone (below).
- **"Planned"**: the tasks no agent has started yet and that wait for nobody: planned ones (a follow-up
  the owner accepted, say), stopped ones, and those set to start at a time. Opened, a card offers
  what it does on the canvas ("Start agent", "Later …"), so a task can be started from the phone.
- **"Done"**: the finished cards that are not archived yet, those the archive's "Archive …
  finished cards" would take but projects, and none the lists above hold.

*Setting a card aside.* A card swiped sideways (past a third of its width, or flicked; as the lines
above the microphone) does what stands behind it as it moves. Swiped to the right in "Needs you" or
"Running" ("Set aside on this phone"), it leaves both for "Set aside", for what the owner would
rather handle at the desk than on the phone, until it needs the owner anew: it comes back by itself
once it waits for them with a wait other than the one it was set aside in (a card set aside while it
ran, at its next question or handover; one set aside while it waited, after it went on at the desk
and waits again), while the same wait leaves it aside however long it lasts. Swiped to the left, a
card in "Needs you" opens the "Later …" menu beside it instead (see Snoozing a card) and stays
until a time is picked; one in "Running" is set aside that way too, since snoozing would stop its
agent. Swiped either way in "Set aside" ("Bring back"), a card comes back at once.

The phone keeps what is set aside in its browser, the same in each of its tabs: the canvas at the
desk, its navigation and the pushes show every card as before, and "Set aside" says so above its
cards. A card whose canvas is not running stays set aside and is so again when the canvas is back;
one removed from its canvas is forgotten. "Needs you" says "Nothing else waits for you." when all
that waits is set aside ("Running" likewise, each for its own cards). Until the owner has swiped a
card once in this browser, a line says how above the first card in sight that can be swiped (in
"Needs you", else in "Running"), which nudges aside and back.

"Set aside", "Planned" and "Done" are closed until their head (with the count) is tapped, since
each may hold many cards the owner rarely needs on the phone. Opened, the head moves up to the bar
so its cards show; it stays open while a card is open and over a reload, and is closed again in a
new tab. Without such cards it is not there.

With several canvases, each list holds its cards canvas by canvas in the switcher's order, each
canvas under a head with its name and how many cards it has there (orange in "Needs you", as the
navigation counts; in "Running" split as "2 + 1", the snoozed cards and those whose agent has yet
to take up the owner's words, then in blue those an agent or Obeya is at, since the list holds both;
either alone without the "+"); a tap on the head folds that canvas's cards in that list away and keeps the
count, as the navigation folds its canvases, kept per list and canvas in the browser. A canvas
without cards in a list has no head there. The cards look as on the canvas, as wide as the screen
and without the pin; where two of at least 340 px fit (the phone turned) they stand side by side.

*Obeya's conversation* is a panel over the list, opened by the canvas's speech-bubble button with its
unread count across canvases, left of the microphone at a finger's size, or by the card "Obeya
answered". With several canvases a picker right of the microphone names whose Obeya it is, which
is also whom the microphone speaks to with no card open (none with one canvas or a card open). The
button opens the conversation an answer waits in when the picked one has none, and the picker
follows. The panel holds the conversation, its field and below it room for the microphone, which
never stands over the field; only the conversation scrolls. Its address is `?talk`; its answers count
as read once it is open. A card opened from it opens over it; Back returns.

The panel takes the part of the screen the keyboard leaves, its field right above the keyboard: the
page asks to be shrunk while the keyboard is up (`interactive-widget=resizes-content`, heeded by
Chrome on Android) and follows the visual viewport elsewhere (Safari); Chrome's visual viewport alone
is off by its own bars. The panel's top is a grip: the panel follows the finger and stays where let
go, the page under it scrolling on until all of it can stand above the panel; within 15 % of the screen's top it takes the full height, within 15 % of the bottom it closes;
let go while moving it glides on, slowing evenly, so a short swipe up fills the screen and one down
closes it, while a finger still for 50 ms before lifting leaves it where it is. It opens at the full
height (half beside a demo video). The button, Back and Esc close it.

The lines above the microphone (Obeya's reply, a confirmation with "Undo", a command still being
read) are swiped aside to either side: past a third of their width or flicked they fly out, else
spring back. Swiping takes nothing back: "Undo" goes unused, a command being read is carried out
without its confirmation. Until the owner has swiped one in this browser, each line nudges aside once
as a hint. The canvas has no such gesture.

*A card* opens full screen at a tap, at its address `/c/<canvas>/card/<code>` (see Addresses in
The canvas; a reload or restart opens it again); Back (the
button, the browser's, Esc) returns to the list where it was scrolled. It is the canvas's detail view
with the same answer options, demo, approve buttons and undo, its page the only thing that scrolls;
plan docs and the configuration are not opened from there. Its conversation is in the same panel as
Obeya's, at the card's address with `?talk`, opened by the button left of the microphone, whose
number counts the messages the conversation shows (not the agent's folded words between steps; a
reply and the handover under it in the same message count once) since the owner last had it open or
wrote there, plus one for the open questions, however many stand in their block. Every card kind
gets there the same way, through the shared detail view. A working card and one waiting for answers
open with the panel up, a working one
as a half sheet so title, state line and buttons stay in view; others open on their page. While an
agent or Obeya is at work, the button carries a working card's moving line. The conversation opens
with the first unseen message at the top of the panel, else at its end; new messages carry the
orange edge (see The conversation). Beside a demo video the panel is a half sheet and the video
scrolls into the upper half, so a comment at a place in the video ("Comment here" brings the
panel up with the cursor in the field) is written with the video in view, as on the canvas; turned
sideways the panel opens at the full height there too.

Calls go to the API of the canvas in view; a call or words about a card go to its own canvas's API,
whichever is in view as they leave (closing a card puts Obeya's canvas in view before its last calls
go).

*The microphone* at the bottom is held by a finger (pointer events, no long-press menu, no text
selection; lifting or the browser taking the gesture ends it) and speaks to the open card's agent,
else to Obeya. No line names whom (what is in view fills the screen), nor shows "→ into the field" or "send with
Enter"; the line under it says when it hears only silence. While the
keyboard is up it hides, with the conversation button and the picker, and the field's own microphone
dictates. The keyboard counts as up while a text field has the focus and the page is more than 150
px shorter than the tallest it had at that width (the phone's own button closes the keyboard but
leaves the focus). Shown again with the cursor in a field, the microphone dictates into the field.
On both microphones the touch is only the press (`touchstart` cancelled): otherwise Chrome takes a
half-second press for a long press on the field, selects text, closes the keyboard and cancels the
recording.

A tap on a button next to a field acts at the first tap: the screenshot button and Send leave the
cursor in the field, so the keyboard stays up, and back from the image picker the field takes the
focus again. A tap into a field while the keyboard is down only places the cursor and brings the
keyboard up; otherwise Chrome's spelling suggestions, opened by that tap, closed the keyboard just
opening. That holds only for fields one types into: a tap on a date and time field stays the
browser's and opens the phone's own picker (taken over too, it did nothing). Texts that name the space bar name the microphone. Enter breaks the line and only Send sends
(a phone's Enter is its line break, and a half-written message cannot be taken back). The screenshot
button offers photo library and camera, and marking a screenshot works with a finger. Drafts are kept
per tab apart from the canvas's, the field of Obeya's conversation one per canvas.

*Turned sideways* (the screen under 600 px high) the microphone stands at the right edge, halfway up
under the thumb, in a strip of its own beside the content, with the screenshot button above it, the
picker at the strip's top and Obeya's conversation button at its bottom. The fade goes, the bar is
slimmer and scrolls away on the list. The panel leaves no room under its field, and with the keyboard
up the field takes the strip's width too. Confirmations stand at the bottom of the content (in the
panel, above the field). Upright nothing changes.

*A demo video* goes full screen from Obeya's button at its top right; its own controls' full-screen
button is hidden. Full screen locks the screen to the video's orientation (landscape), however the
phone is held; once the phone has been turned to match, turning it back (held 300 ms, read from the
orientation sensor) ends it, as do the button and Back. Turning into landscape while the video plays
in view starts it. Obeya does this itself because Chrome's own handling is racy (it releases the lock
while the screen may still report the old orientation, so turning sometimes ends or starts full
screen wrongly); Obeya holds the lock until full screen ends. Where only the video can go full screen
(Safari on an iPhone) there is no button and the video's own controls stay.

*When the server does not answer* for 3 s, a line at the top says "Obeya is not answering · since
14:02" and why that may be; the page reconnects by itself, at once when it comes back into view, and
the 3 s count from then (a phone back from its lock screen reconnects within them). A sleeping
machine refuses nothing, so a connection not open within 3 s counts as not answering, and one not
open after 10 s is tried anew.

*Why it does not answer.* The line says the likely cause, from what the phone can see on its own: a
request to Obeya's address (`/api/reach`, through no cache, given 3 s), sent as the connection is
lost, again every 10 s, and on coming back into view or onto a network. The line waits for the first
one to come back (3 s at most beyond its own 3 s), so it shows with its cause rather than changing
its words a moment later. In this order:

- the browser has no network: the phone has none;
- the address answers 502 to 504, a gateway with nothing behind it (`tailscale serve` while Obeya is
  not listening): the computer runs, Obeya does not;
- the address answers anything else: Obeya answers, the page connects again in a moment;
- a push was sent in the last 10 minutes (the one the owner tapped to open the app, say): Obeya was
  running then, so the phone's way to the computer is the likely cause. A push older than that says
  nothing about now, nor does one stamped more than 10 minutes ahead of the phone's clock; the time
  is when Obeya sent it (in the push), since the push service holds a push for a phone that is off
  for up to a day, and a push without it counts not at all;
- the request failed within 2 s: the phone has no way to the address (no name for it, no route), or
  the computer refused it because Obeya does not listen there. The browser cannot tell the two apart,
  so the line names both;
- it hung: the computer does not answer, asleep or switched off.

Whether the phone reaches Obeya through Tailscale the page asks Obeya while connected (a device's
`GET /api/access` answers `{ local: false, tailnet }`: true when Obeya is served through Tailscale or
listens on one of the machine's addresses in the tailnet) and keeps the answer for when it is not;
before it ever had one, an address that looks like a tailnet's (a `.ts.net` name, 100.64.0.0/10,
fd7a:115c:a1e0::/48) counts. Through Tailscale, the line names Tailscale on the phone being off as a
cause; elsewhere it names none and asks whether the phone is in the computer's network or VPN. The
line gives the cause in a sentence or two; behind "More about this" stands the rest: that
notifications still arrive because they go through the browser's push service while cards and
videos come only through Tailscale, that "Connect a phone" helps where the address changed, and, on
Android only, that Android often stops Tailscale in the background and how to keep it from that
(battery use "Unrestricted", "Always-on VPN"). On Android, where Tailscale may be the cause, the line also has
the button "Open Tailscale" (an `intent:` link to the app's `tailscale://navigate`, which Chrome
sends to the Play Store where the app is missing). The service worker notes when the last push was
sent (in a cache of its own) and tells an open page.

#### Notifications on the phone

Obeya tells the owner's phone when something starts to wait for them, by Web Push to the browser's
own push service: no account, no service of Obeya's. Messages are encrypted for the device (RFC 8291)
and requests signed with Obeya's VAPID key (RFC 8292), with WebCrypto; the push service sees neither
title nor text. The key is made at the first start and kept in `vapid.json` in the home.

*Turning them on.* A paired device holds at most one subscription; removing the device removes it,
and one the push service answers with 404 or 410 goes. An iPhone gets pushes only from the home
screen (iOS 16.4+): in Safari the phone view says how ("Share", "Add to Home Screen"). There, and
in a phone's Chrome, a box at the top asks "Turn on notifications"; its button asks for the
permission (iOS asks only after a tap), and the box stays until it is given or refused. Given, the
page hands its subscription to the server (`PUT /api/push`) at every load. Over plain HTTP there are
no pushes; the section "Other devices" says so and which devices have them on.

*What is pushed:* a card that starts waiting for the owner, with what it waits for as the text ("Demo
ready", "A question for you" …), its title and, with several canvases, its canvas; a failed landing
("Landing failed"); a stuck worker (its turn failed or ended twice without a handover and
Obeya made a question of it: "The agent is stuck"). Not Obeya's answers in its conversation (the
owner asked from where they are), nor cards waiting already when Obeya starts.

*Not while the owner uses Obeya:* nothing is pushed while a page on this machine was in use in the
last three minutes, or while a page on a paired device is in use. A page is in use while in view and
the owner moved, typed or scrolled or a video played within the last half minute (it reports that
every 30 s and on coming into view); a canvas left in view with nobody at it holds nothing off. The
phone view is in use whenever in view, and its hold ends at once when it goes out of view, closes or
is silent for 45 s. What starts waiting while the owner is there is not pushed later either.

Pushes go `Urgency: high`, which lets the push service wake a sleeping phone; whether it does is the
phone's choice (Android held Chrome's messages until unlock on the owner's Pixel, 2026-10-16).
*Several at once:* the first goes out at once; what starts waiting within the minute after goes out
as one push at its end ("3 cards wait for you", the titles as text, leaving out what no longer
waits), and a further minute starts. *Tapping a push* opens its card in the phone view
(at its address), "Needs you" for several, in the open app if there is one; a later push for the same
card replaces the earlier.

*The web app.* The page names a manifest (standalone, icons `/icons/180.png`, `/icons/512.png`), and
the phone view registers a service worker at `/sw.js`; neither needs pairing. The worker shows the
pushes and keeps the page's shell, served from its cache when the network fails or takes over 3 s.
So the app opened while the machine sleeps shows the phone view saying Obeya does not answer within
about 7 s: the page waits 3 s for its language and canvases, then goes on with the browser's language
and the canvases it last had. The worker requests the page anew rather than passing the request on:
Android's Chrome marks a home-screen launch `Sec-Fetch-Site: cross-site`, and passed on it loses
`Sec-Fetch-Mode: navigate`, so *Its own site* would refuse it. The canvas page registers no worker.

#### Stalls

Obeya's server runs on one thread: while it computes or waits in a synchronous call (a git command,
say), it answers no page and hears no agent, and the canvas seems frozen. Every stall of half a
second or more goes into the server's output and into `stalls.log` in the home, which outlives
restarts (past 1 MB it starts afresh, the one before kept as `stalls.previous.log`). An entry gives
the time, the stall's length, the few places in the code where most of it went with their share
(the runtime function the thread was in, `spawnSync` or `stringify`, then the functions of Obeya
that called it, by file and line), and each process the server waited for longer than 50 ms, by its
command line. It also says whether the machine, not the code, held the server up: how long the
server's thread computed (on the CPU, in its own code or the system's on its behalf), the pages the
process read back from disk or swap (major page faults) and, on Linux, the times the system took the
CPU from it for another (involuntary context switches). The counts go on a line of their own where
they are above zero; the thread's time only where it waited through half the stall or more,
neither computing nor waiting for a process it ran. Then the first line says so in words: from
1,000 pages on "it waited for 4,200 pages from disk or swap", else that its thread computed for
so long of it and waited the rest (for the disk, swap, the system or a busy machine). An entry of
code that was slow thus reads as before. Windows counts no page faults that mean this (its count
includes those of memory already there) and no context switches, macOS no involuntary ones (it
counts every one as such, the profiler's several hundred a second too), so there the entry leaves
them out. macOS counts as page-ins only the pages of files (one mapped into memory, the program's
own code), not memory brought back from its compressor or swap file, and no platform counts a file
read into memory as page faults; the thread's time tells of those. A pause the thread did not run
in at all (the machine slept) is no stall; one it spent waiting for a process is, also on Windows,
where the profiler takes no samples while the thread waits and samples only about every 16 ms
whatever interval it is asked for. There the wait itself is what tells the two apart, so a sleep
during a process the server waited for counts as a stall on Windows alone; elsewhere the samples
taken during the wait decide.

What happens often or many times at once therefore never waits for a process: starting an agent and
landing work read git without blocking, and so do starting the canvases, applying a saved
configuration, restarting a repository's agents, checking the configuration and confirming a
repository's commands, whatever the number of canvases and repositories. A repository's `origin` as
configured (before git's `insteadOf`) is read with the rest of it, and a host's GitHub login is read
in the background from the start and again once it is ten minutes old, the one before standing
meanwhile; a command on the host waits only for the first. Most processes Obeya runs without
blocking and reads once they end, with their exit code and output (git calls above all, and the
commands on a host), start on two threads of their own, not the server's: starting a process holds
the thread that starts it until the system has created it, on Windows tens of milliseconds on an
idle machine and seconds each under load. A few such ones (Tailscale's commands, the reads for a
theme, Codex), and those it talks to while they run or reads as their output comes (an agent, a
voice sidecar, a stream of git objects), still start on the server's thread. On Windows one process
starts at a time across all of these, so none inherits another's pipes. Which skill name a worker's session knows the demo skill by is known
while the user's skills directory holds the same skills. Sharing on a demo site Obeya keeps reads and writes
its files without blocking, and touches only the page it changes: what it has read of the site's
directory (each page's `meta.json`, which pages hold their files) it keeps while it runs, since only
Obeya changes that directory, and lists the directory afresh to notice a page that went. A site of a
few hundred pages read page by page held the server up for up to a second with every share
(2026-11-05).

What the server reads of its database with every change of a canvas, every command to the
Coordinator, every input of the owner's and every pass over the shared pages costs about the same
however long the history behind it: each such read finds its rows through an index, bounded by a
window of time or a limit, or keeps what it read and reads again only what was written since. The
Coordinator's history of the last days and the news since its last command (the milestones of the
cards' logs, the cards made), what the owner said in the last days, the exchanges whose reply waits
on a card, the workstreams and costs of the projects shown: each by index. The shared cards (every
page ever shared, archived cards' too, which the notice of outdated pages and every pass over a
site's pages go over) are read once; the database logs which of them were written since, came or
went, and the canvas reads those again, keeping with each unchanged row what it made of it (its
page, its tags, what leaves it outdated, its part in the notice). A pass over the shared pages finds
each page's card and repository from its row, without making the archived cards into cards, and
makes the target of each site once. A test holds these rounds to a budget over a history ten times
the owner's of 9 November 2026 (see Decisions).

A page reports its own freezes of half a second or more over its WebSocket, and the server logs them
in the same places, naming the device and the canvas: where the browser says where the time went
(Chromium's long animation frames: the scripts by what invoked them, and style and layout), the
largest parts; and the server's messages the page took in during the three seconds before, by type
and size. Safari and Firefox tell only the length. Each entry also says what the page ran in: the
browser by name and major version (or the Obeya app and its platform), whether its window was the
one in use (had the focus as the stall began or as it ended), and how long before the stall the
owner last moved, typed or scrolled in it. A page finds its freezes by a heartbeat from a worker
thread, which it has to take in: one taken in half a second or more after it was sent means the
page's thread was busy that long. A page whose timers the browser merely holds back reports nothing:
WebKit runs a page's timers about once a second while its window seems idle to it (not in front,
nothing drawn for a while), with the page still in view, and a worker's timers on. Where the browser
tells no long frames (Safari, the app's webview, Firefox), a page whose window is in the background
reports nothing either: nothing tells a page held back by the system from a busy one, and nobody
uses it meanwhile. A page out of view is not watched, as the browser holds it back by itself; one
that froze while its connection was down reports once it is back. A page that stalls again and again
the same way (from the same page, with its time going to the same places, its window in use or not
alike) gets one entry for the first, and the ones like it that follow, each within a minute of the
one before, are counted: one line says how many, over what span and how long each was, once a minute
has passed without another, or every hour while they go on, so that such a page cannot push the
server's own stalls out of `stalls.log`.

### Setup assistant

One list of what Obeya needs on this machine, in four parts: *Agents* (Claude Code and its login,
Codex and its login, git, and git's name and e-mail, without which an agent's commit fails; either
harness with its login is enough, the other one's pieces then marked as not needed, and while
neither is ready Claude Code is the one asked for, Codex offered instead); *Pull requests* (gh and its login,
needed at the first approval in a repository on GitHub); *Voice commands* and *Demos* (the
configuration dialog's checks, each with the size still to download; uv above the speech recognition,
whose "Install" waits for it; see The Voice input settings). Where agents run on the
machine's own Claude Code (see Agents), the list names the version Obeya was checked with when that
differs. Logins come from `claude auth status`, `codex login status` and `gh auth status`. What a
check finds of the harnesses also decides which one a group the owner chose none for runs on (see
Harnesses, models and effort); Obeya looks once as it starts.

"Install" installs what needs no admin rights: Claude Code and uv with their official installers,
the speech recognition, a demo's voice. System software (git, gh, ffmpeg, Node, a browser) comes with
the command for this platform and a copy button, installed at a click where that needs no password
(Homebrew, winget). Codex has no installer of its own: Homebrew's cask on a Mac, else npm's package,
at a click where npm needs no admin rights (not on Linux). A login opens a terminal with
`claude auth login`, `codex login` or `gh auth login` (none found:
the command to run by hand); git's name and e-mail are two fields. The list checks again when the
window gets the focus back. Obeya puts `~/.local/bin` and on a Mac Homebrew's directories on its
`PATH`, so what was installed is found from a process the desktop started; on Windows every check
rereads `PATH` from the registry.

#### The first canvas

On the first start the page ends with "Where is your project?": two cards with a radio button each,
"Already on this computer" (a folder: a path or, from a browser on this machine, the system's folder dialog) and "On GitHub / a
server" (a clone: `owner/name` through `gh repo clone` where gh is logged in, else by URL; any git
URL; into the home directory unless another is given). It shows the main branch Obeya found there. A
folder without git gets the offer to set it up (see Setting up git in a folder), whose confirmation
also creates the canvas. Obeya writes `canvases.json` (worktrees, or two clones when the repository's
settings say clones), starts the canvas at once (see Live configuration) and the page opens it, with
a first card that says what to try. Later "Check setup" in the Configuration dialog opens the
same list over the canvas, without the first canvas. A scratch Obeya with `"setup": true` starts like
a first start.

### Setting up git in a folder

Where the first canvas or "+ Repository" is given a folder in which git finds no repository, it
offers "Use without git" (`"git": false` in its entry; see Folders without git) and "Set up a
git repository here", each with a line on what it means. The latter first shows what the first
commit would hold: the folder's entries with file counts and sizes, files from 1 MB listed as large,
what stays out, and the default `.gitignore` (build output, dependencies, secrets: `node_modules/`,
`dist/`, `.env*` but `.env.example`, keys) Obeya writes where the folder has none. The preview uses a
git directory of its own in the temp directory, so looking changes nothing; the owner keeps more out
with a `.gitignore` and "Look again". Confirming runs `git init` on git's `init.defaultBranch`, else
`main`, and commits every file not ignored (workers see only committed files) under git's name and
e-mail (none: it says so and does nothing). A failed step undoes the ones before. Building a card
in a new repository sets git up the same way, without the preview (see Building in a new
repository).

### Self-update

Obeya runs from a checkout that work lands on, so `live` must mean running (the compiled binary has
no checkout and never restarts for new code). Without `--dev` the `obeya` process supervises the
server: when the checkout moves to commits that change code (not only `docs/`, `design/`, `site/`,
`.github/` or `.md` files), it restarts the server, running `bun install --frozen-lockfile` first
when `package.json` or `bun.lock` changed (a failure is logged and the restart goes ahead). Workers
resume, and an open page reloads when it reconnects to a new server process. What counts as new is
measured from the commit the server started from, and a restart waits until HEAD has held still for
a round (a landing under way finishes first), HEAD checked once more after git has told what
changed. While nothing moves, the watch starts no process: every two seconds it compares the files
HEAD stands on (HEAD, each ref it names on the way to a commit, a branch possibly naming another,
and `packed-refs`; refs of a worktree's own, such as `refs/worktree/` and `refs/bisect/`, are in its
own git directory) and asks git what HEAD is only once one of them changed. Where the files cannot
tell (refs in a reftable, a symbolic ref whose target cannot be read safely), git is asked every
round.

#### Waiting for the workers

The restart waits until no worker is in a turn or waiting for its background work, even one that
has asked or handed over in it (at most 15 minutes), since it stops whatever a worker runs. Those
workers are told it is due: they start nothing
long, stop background work they can restart, and pause at the next safe point by ending their turn
(no nudge, no question to the owner; the card's log says so). A turn that starts meanwhile (a message,
finished background work) hears that it keeps Obeya waiting: the worker takes the message in, leaves
the work until it is resumed and ends the turn at once. A resumed worker hears that what ran was
stopped (exit code 137). A worker waiting for its landed work's restart is not in a turn.

While the restart is due, a card whose worker paused for it, with no background work left that the
restart waits for, says so in place of "Agent at work" ("Agent waits for restart", "Done ·
agent waits for restart"), in muted ink without the moving line, and offers no pause; a turn that
starts before the restart shows it at work again.

#### Waiting for the owner

The restart also waits, past the 15 minutes, while the owner watches a demo video or dictates (from
the press until the words are in the field or Obeya has read them): the page reports both over its
WebSocket, and a page that closes lets go. The server itself holds the restart while it transcribes a
recording, and while a command is in its undo window until it has run.

While a restart waits, the bar shows it ("Restart waits for N agents", "… for your video", "… for
your dictation"; with agents only, until when at most); hovering names why and the cards it waits for,
across canvases, and "Restart now" (`POST /api/restart`) has it go ahead at once, its hover
saying what that cuts off.

#### Keeping the page

The page that reloads keeps what was open: just before, it writes down per tab the open card, project
(plan doc read or not) and sheet, the scroll positions in them, the drafts and where the demo video
stood (playing on only in a tab in sight); the new page reopens them without flights or unfold. The
camera is kept anyway.

#### Pulling from the upstream

Obeya from a clone of its repository moves only when its owner pulls. So the supervised server
fetches its branch's upstream at start and every hour (only that branch, into its remote-tracking
ref). While the upstream has commits that change code (the restart's test), the bar shows "Update: 12
new commits", the newest ten on hover, and a "git pull" button, which fetches again and
fast-forwards; the restart follows as after a landing. Where Obeya cannot fast-forward there is no
button, and the hover says why and what to do: commits of the checkout's own, uncommitted changes to
files the new commits change (named), or git's message for anything else. Back on the page, Obeya
looks again without fetching. A branch without upstream, a detached HEAD, `--dev`, the app and the
compiled binary (the app has its own updates) have nothing to pull.

### Stopping

Ctrl-C, SIGTERM or `POST /api/stop` (the app; Windows has no SIGTERM) stops Obeya the way a restart
goes, only nothing starts again: workers in a turn are told Obeya is about to stop and pause at a
safe point, and Obeya ends once none is in a turn (at most 15 minutes). The bar shows it ("Shutdown
waits for N agents", "Shut down now"), and a second Ctrl-C ends it at once (supervisor and server
both get the terminal's Ctrl-C, so signals within a second count as one press). A stop does not wait
for the owner's video or dictation (the owner asked for it), and turns a waiting restart into a stop. The next start resumes
the stopped workers.

The sidecars (transcription, speech, narration voice), the agents' Claude Code processes, the `ssh`
of remote sessions and the process keeping the machine awake run outside the terminal's process
group, so its Ctrl-C reaches none of them: in it, Ctrl-C broke every agent's turn off at once. They
hear of the stop from Obeya and go on meanwhile. Once Obeya ends, it closes the sidecars' stdin, which
they finish as a normal end after their current request (one still there after 30 s is killed), and
sends SIGTERM to each agent's process group, so no agent goes on with a turn nobody hears. On Windows,
where a detached process opens a console window for every program it starts, the Python sidecars
ignore Ctrl-C instead, and the agents stay in the console (a stop through the app still waits for
them).

On Windows every program Obeya starts runs without a window (git above all, many times a minute;
the narration voice's installer and samples too), except one meant to be seen (Explorer, a terminal
for a login). An Obeya without a console of its own (a scratch Obeya, one started without a
terminal) would otherwise give each a window: with Windows Terminal as the default terminal, one
flashes up per call and takes the focus from what the owner is typing in, several a second while
workers are busy.

### Scratch Obeyas

A scratch Obeya (`scripts/scratch-obeya.ts`, for a demo, a live check or a prototype; see Recording
a demo) is staged with the checkout the script ran from (`OBEYA_SCRATCH`), and ends by itself, as a
stop goes but without waiting for its workers:

- once that checkout is gone or has another branch checked out than at staging: its card's work
  has landed or was discarded (the worktree goes), or the clone went to another card;
- once nothing has used it for 30 minutes (`OBEYA_SCRATCH_IDLE`, in seconds, sets another time for a
  live check): no page open on it, no request to it (the API, a page loading, the probe of an open
  card's "Open app ↗"), and none of its own agents in a turn. An idle worker's card counts as no
  agent. A demo's take keeps it, since it has a page open, and a worker's checks do, since each
  calls its API or opens a page.

Its log says why it ended, and the script's `--login`, `--say` and `--artifact` repeat that,
telling to stage afresh. It loads the speech recognition only for a recording (the owner pressed
to speak) or a walkthrough that needs it, not ahead when the cursor goes into Obeya's field, as
the owner's Obeya does.

Every staging also stops, in the background, the scratch Obeyas whose code does not end them so
(staged before this rule, from an older commit with `--code`, or started by hand on a scratch dir):
those whose working directory is gone, and those that have run for more than 12 hours; it ends what
each had started (its speech recognition, its agents) and notes each in `obeya-scratch-sweep.log`
beside the scratch dirs.

### Decisions

- **Scratch Obeyas end by themselves** (2026-11-09, the owner): on a Mac with 48 GB that had
  swapped out 9.3 GB, eight scratch Obeyas had run for one to four days after their cards were done,
  three with a speech recognition of their own (about 730 MB each), 2.8 GB together. Each ends with
  its checkout, which goes once its card's work is done, or after 30 minutes nothing used it. Thirty
  minutes because staging afresh takes a second while an idle instance holds 40 to 70 MB: the time
  only has to outlast a worker's pause between two looks at the same instance, and it is also how
  long an app the owner opened from a card runs at least (Parking). Rejected: stopping them through
  the repository's `app.stop` when the card parks (only a card waiting for the owner, and only
  instances staged from a card), and a time since staging (it would end a take that runs long).
  The owner's own Obeya keeps its speech recognition loaded once it has started it (the owner).
- **A scratch Obeya loads the speech recognition only when someone speaks** (2026-11-09): demos and
  checks click into Obeya's field far more often than they dictate, and every such click had started
  a recognition of about 730 MB that stayed as long as the instance.
- **Older scratch Obeyas are swept by stagings, not by the owner's Obeya** (2026-11-09): stagings
  happen many times a day on a machine where scratch Obeyas are used at all, and the owner's Obeya
  stays out of what a script of this repository starts. One that does not end by itself cannot tell
  when it was last used, so 12 hours: a take stages afresh, and a check that long without staging
  again does not happen.
- **Other devices over the owner's private network, paired by a QR code** (2026-10-16, plan "Obeya
  from the phone"). Rejected: a public tunnel (agents with shell rights on the open internet), a relay
  of Obeya's own (a cloud service), a messenger bot (a third party sees all, and it is only a chat). A
  device stays paired until removed or unused for 90 days, not for a fixed time (a phone in daily use need not pair again, one forgotten
  drops out by itself); devices are managed
  only on the machine, so a lost phone cannot keep itself in. The device cookie is `SameSite=None`
  over HTTPS, not `Strict`: with `Strict` a worker's HTML artifact could not load its own files.
- **Every request is checked for `Host` and `Origin`, from this machine too** (2026-10-16): otherwise
  any site in the owner's browser could start and approve cards with a `text/plain` POST, and a
  rebound DNS name could do everything. No token in the page is needed: what a foreign page may send
  without a preflight carries its `Origin`, and preflights get no CORS headers.
- **The machine stays awake while a worker works, or always if the owner says so** (2026-10-16, the
  owner): always awake is too much as a default (a laptop on battery), but the owner wants to give
  tasks from the phone while no agent works. Rejected: a hint how to keep it awake by hand (the switch does it
  without leaving Obeya).
- **A changed address is shown on the machine, from where each device's app last connected**
  (2026-11-03, the owner): a web app on the home screen keeps the address it was added at, and
  nothing Obeya serves elsewhere can reach it. Only the app's own page knows it runs as one, so it
  reports that; the address a device last used in its browser would not do, since with a new port the
  browser follows the new address while the app does not.
- **"Connect a phone" only in the configuration** (2026-10-16): a phone is connected once, so it
  takes no place in the bar. Rejected: a phone icon in the bar.
- **The phone view is a view of its own in the same page, not the canvas made touch-capable**
  (2026-10-16, plan "Obeya from the phone"): readable cards on 390 px mean mostly panning. It goes by
  coarse pointer and short side, not window width, so a narrow window at the desk keeps the canvas.
  It reuses the canvas's detail view, conversation, drafts and confirmations rather than copies.
- **The phone view's one WebSocket for every canvas** (2026-11-06, the owner's phone over Tailscale
  said Obeya was not answering and showed no cards): a browser opens WebSockets to one address one at
  a time, so with nine canvases, a slow link or a busy machine, the later sockets were still waiting
  for their turn past the 3 s after which the page says Obeya does not answer, and past the 10 s
  after which a socket is given up and tried anew. One socket opens in one handshake. Rejected: a
  socket per canvas (2026-10-16), which left the server's messages as they were.
- **Planned tasks on the phone** (2026-10-31): without "Planned" an accepted proposal left the phone
  until it was started.
- **Done cards on the phone in a list of their own, closed by default** (2026-10-28, the owner):
  the owner wants to see what is done but not archived from the phone, without it pushing what
  waits and what runs further down.
- **Cards are set aside on the phone by a swipe, until they need the owner anew** (2026-11-06, the
  owner): with many cards at work the phone's lists overwhelmed, though much of it the owner only
  handles at the desk. It ends with a new wait, not with a time (that is snoozing, which also takes
  the card off the canvas's lists) and not when the owner acts at the desk (the card would be back
  while it runs, which the owner did not want to see on the phone). Kept in the phone's browser,
  not on the server: it sorts the phone's lists only, and a second phone sorts its own. Rejected: a
  button on each card (clutter for an action of the list, not of the card).
- **Swiped the other way, a card waiting for the owner is snoozed** (2026-11-07, the owner): besides
  handling it at the desk, putting it off until later is the other way to be rid of an orange card
  for now. The swipe opens the "Later …" menu rather than picking a time itself, so the owner picks
  as on the card; on a card at work it sets aside too, since snoozing stops its agent. What the
  swipe does stands behind the card while it moves, and the set-aside one says it holds on this
  phone only.
- **The phone's lists group their cards by canvas under foldable heads** (2026-11-06, the owner):
  one column of cards from every canvas ran together; a head per canvas, folded as in the
  navigation, replaces the canvas's name in each card's kind line.
- **Phone conversations are a panel from below, sized with a grip** (2026-10-17). Rejected: the
  conversation as a box in the scrolling page (a scroll area inside another, and the page scrolled
  past the field to make room for the microphone); a grip that only closes or springs back. Cards
  whose conversation is the point (working, asking) open with it up (2026-10-19).
- **Real full screen for phone demo videos, with Chrome's notice** (2026-10-17, the owner): Chrome on
  Android shows "… to exit full screen: drag from the top" each time, and no page can turn it
  off. Rejected: a player covering the page without full screen (Chrome's bars stay, and Chrome locks
  the orientation only in full screen).
- **Pushes by Web Push to the web app on the home screen** (2026-10-16, plan "Obeya from the phone").
  Rejected: ntfy or a messenger (a third party for nothing Web Push lacks); a native app (nothing a
  home-screen web app cannot do here). WebCrypto rather than a library: the two RFCs are a few dozen
  lines, checked against RFC 8291's example. A page at the machine holds pushes off while in use, not
  merely in view, or a canvas left open would hold them off until the screen locks.
- **The phone names the likely cause of not reaching Obeya, from what it sees itself** (2026-11-09:
  Android stops Tailscale in the background, and the page used to send the owner to the computer
  instead). A push sent a moment ago says Obeya was running, since pushes do not take the way
  through Tailscale; only a recent one, since the computer may sleep since. Whether the way is
  Tailscale's comes from Obeya, not the address alone: other VPNs use 100.64.0.0/10 too. Rejected:
  keeping the connection up the way pushes arrive. They come through the browser's push service,
  which Android keeps alive for every app, carry a few kilobytes each and must each show a
  notification (Chrome allows no silent ones); cards, conversations and videos need the direct way to
  the computer, and keeping that up is Tailscale's, which Android lets do with "Always-on VPN" and
  unrestricted battery use. Rejected too: a request to a public address to tell no internet from no
  Tailscale (a third party sees the phone, and the browser's network state tells enough).
- **No pushes while the owner uses the phone view either** (2026-10-17): they add nothing while the
  owner works through the cards there. Its hold ends the moment it goes out of view, not three
  minutes later, so what starts waiting right after the phone is locked is pushed.
- **Stalls are always watched, with the JavaScript engine's sampling profiler running all along**
  (2026-10-29, the owner): freezes of a few seconds came now and then (after an approval, say) and
  could not be traced afterwards. The profiler samples the thread's stack from a thread of its own,
  also while it waits in a synchronous call; it costs under half a percent of a core while Obeya is
  idle and a few percent of its speed while busy. Rejected: timing chosen
  calls only (a stall in code nobody thought of goes unnamed); profiling only on demand (the stall
  is over by the time someone asks); a slow-request log (the page acts on a click before the
  server answers, so a slow answer freezes nothing).
- **A server stall says whether the machine held it up** (2026-11-09, from `stalls.log`): stalls of
  0.5–1.5 s had their time in SQLite reads that take a few milliseconds when warm; they came with
  restarts and a 4 GB voice model loading while the machine had 11.6 GB in swap, and read like a
  fault of the code. The counts are read at each tick (under a microsecond); an entry gets their
  difference between the ticks before and after the stall, which span up to a tick more than the
  stall, so the share waited through errs low. Every process the server waited for counts as such,
  the ones too short to be named too, less what the thread computed meanwhile (a burst of short git
  calls is no machine holding the server up). Page faults alone would miss most of such stalls on macOS
  (memory from the compressor or swap file is no page-in there, nor is a file read by `read()`
  anywhere, as SQLite reads), so the thread's own CPU time comes with them: a thread that neither
  computed nor waited for a process it ran was held up. Its own, not the process's, which the
  profiler and the threads that start processes add to. The threshold for the page-ins in words is
  fixed (1,000 pages, each a tenth to half a millisecond from disk, a share of a half-second stall
  worth naming) rather than scaled with the stall's length, so it reads the same in every entry.
- **The server's rounds read by index or keep what they read, so their cost does not grow with the
  history** (2026-11-09, from `stalls.log`): from 30 October to 8 November the server stalled 99
  times for 0.5 to 6.9 s, most of it in reads that went over whole tables and grew with every day of
  use (by then 55 MB: 158,000 events, 1,700 cards, 1,000 exchanges with the Coordinator over 40
  days): the brief of every command and the learner's look at every input of the owner's went
  through every event of the canvas's cards, the steps the Coordinator waited on through every
  exchange, a change to a shared card made the notice of outdated pages over every shared card, a
  pass over the shared pages built every archived shared card, and each rebuild of the canvas view
  summed the costs over every card of the canvas. Most of those stalls came with a busy machine (see
  the entry before), but what made them long was how much there was to read. A test writes a
  history ten times as long (1.6 million events over 400 days, 9,000 archived cards on the canvas,
  4,500 shared pages, 10,000 exchanges) and measures each round in rebuilds of the view of a canvas
  with the same cards and no history (a millisecond and a half on a laptop): before, the brief and
  the learner's look cost over 200 such rebuilds each, a change to a shared card 27, a pass over
  the shared pages 38, a rebuild of the view itself 3; since, a fraction of one for the first two,
  about 3, 4 and 1. Each round has a budget of a few such rebuilds, so a round that goes over the
  history again fails it, on any machine, since the unit is measured beside it. Indexes rather
  than a canvas column on the events: what an event's card belongs to is one lookup by key, and the
  window of time bounds how many are looked up. The shared cards' log is written by the database
  as the rows are, as the marks of the shared cards and the archive are (2026-11-05), so no write
  can forget it; one board per canvas reads it and drops what it read. A pass over the shared pages
  still goes over every page, as a site is asked about all of them, but half a microsecond each.
  Rejected: reading in a worker thread (the code reads between its writes and needs the rows at
  once, and every read would still grow with the history); a mark from the shared cards' times of
  last write (rejected before: a status line moves it); keeping the shared cards' rows only as long
  as the archive's mark stands (it moves with every card archived, and a run sharing many pages
  again writes archived cards one after the other).
- **The archive comes a page at a time, and the server searches it** (2026-11-09): opening the
  archive built every archived card of the canvas for the page (the newest first on their own, then
  all of them), as did a proposal for a site's tags; over the long history's 9,000 archived cards
  that held the server for about 110 ms, growing with every card archived. Now the page asks for 50
  cards at a time as the owner scrolls down the list (and through it to a card opened from its
  address), each page read by an index in the archive's order and continued after the last card of
  the one before (when archived, when created, its id), so a card archived meanwhile does not shift
  the pages; the page reads again what it shows once the archive's mark moves, as far as the owner
  had scrolled. A page costs a quarter of a rebuild of the canvas view, at the start of the archive
  and thousands of cards down. Since the page no longer holds the archive, the server searches it,
  for the archive's filter and the bar's search alike: the first search reads what it needs of every
  archived card (its text as the search reads it, its label as a key) in slices of a hundred cards,
  about one rebuild each, the server answering between them; it keeps that for ten minutes after the
  last search and reads again only the entries the database logs as written since (the log written
  as the archive's mark is, by triggers on the cards). A search then costs about one rebuild, and
  only the cards of its page are built. The labels the search matches (Stopped, Idea · parked) come
  with the search in the page's language, since the server does not know which the page shows. A
  proposal for a site's tags reads the archive page by page only as far back as its brief has room
  for. Rejected: SQLite's full-text search (its trigram tokenizer, which would match inside words,
  ignores accents only from SQLite 3.45, newer than the system SQLite some machines run Bun with,
  and the text a search reads partly comes from plan docs and JSON columns); reading the whole
  archive in the background and keeping it built (memory for thousands of cards nobody looks at,
  and every write to an archived card would build it again); offsets for the pages (a page far down
  would walk thousands of index entries, and a card archived meanwhile shifts every page after).
- **Agent starts and landings read git without the server waiting, and reuse what was read while
  the refs stand still** (2026-10-31): with many cards landing in a row, the trust check at each
  agent start and the settings read after each landing called git synchronously, a few calls each,
  and held the server up for up to 1.1 s. Whether the main branch moved is told by `stat`s of the
  refs, so an agent whose repository did not move starts at once. Rejected: every agent start
  waiting for git (each start later, though the main branch rarely moved); watching the refs for
  changes (the event comes after a commit made just before the start); a cap on git processes
  running at once (a fetch or clone taking minutes would hold a place, and the trust check of an
  agent start would queue behind it).
- **Canvases start and take a configuration with git read ahead, never waited for** (2026-11-05,
  from `stalls.log`): reading every repository of every canvas one git call after the other held the
  server up for up to 4.7 s on a save, and the origin URL asked again at each configuration check
  for up to 0.7 s. What a configuration needs of git (each repository, each listed workspace) is read
  for all of them at once first, then applied in one go; configurations saved meanwhile apply one
  after the other. The save answers once its canvases took it over. Rejected: reading lazily where a
  value is used (a canvas would start on half-read repositories, its ids and read tree unsettled).
  Two reads that came at each reading of the plan docs and at each review card's agent start go the
  same way: whether the read tree holds what a live workstream landed is asked in the background
  (not held meanwhile; the card is planned again once git says it is) and known while the read tree
  stands where it was (its own moves, the checkout's HEAD and branch by `stat`); the default
  branch's CLAUDE.md for a review card's session is read while the session waits to start, and
  stands while the refs do.
- **Processes start off the server's thread** (2026-11-06, from `stalls.log` of a busy Windows
  machine): on Windows the system creates a process synchronously on the thread that asks, through
  Bun's async spawn too; with antivirus and many git calls at once that took seconds each, and a
  burst (a git call in each clone, landings, the upstream's fetch) held the server up for 10–22 s,
  in which phones showed "Obeya is not answering" and WebSockets timed out opening. The processes Obeya
  runs most often and reads once they end (git above all) are started by two worker threads, which hand back the exit code and output; options
  that cannot cross to a thread (a stream as input), or no thread to be had, start on the server's
  thread as before. A thread that fails or ends before its code ran started nothing: what it was
  given starts on the server's thread. One that fails or ends later fails what it was running, and
  nothing is started twice (a push, a landing). What a thread answers settles in a turn of the event
  loop of its own: settled straight from the thread's message, a promise `bun test` waits for with
  `expect(…).rejects` or `.resolves` stayed pending (Bun 1.4.3) and the test file hung. Settled so,
  a rejection that only `expect(…).rejects` waits for still counted as unhandled on the CI runner
  once the file's tests were through, failing the run though every test passed: tests take such a
  rejection with a handler of their own. Rejected:
  starting only a few per turn of the event loop (what it was until then: each start still held
  the thread, and four slow ones in a row were seconds); a cap on
  processes running at once (see the trust check above); fewer git calls alone (the bursts come
  from many clones and canvases, each call needed).
- **A plan doc's history is read without the server waiting** (2026-11-09): a card whose
  workstream left its doc takes its title from the doc's history in git when neither the doc as
  last read nor the card knows it, and so does the repair of keys an older Obeya gave. That
  history (the doc as each of its last 200 commits left it, a large output for a long-lived doc)
  was read and parsed synchronously while the canvas view was being built (380 ms for 200 versions
  of a 30 KB doc on a Mac). It is now read like any other git call off the server's thread and
  parsed a version per turn of the event loop (13 ms at most at a time), once per text of the doc
  and Lesestand, and the view is built meanwhile: the card waits in its project, as it does for a workspace to come back, and a project
  whose repair needs the history shows its doc as last read; once git is through, the plan docs
  are read again and the cards move. A read for a doc that changed meanwhile is dropped and done
  anew. Rejected: reading the history of every doc ahead (most docs never need it, and each change
  would read it again); building the view with what is known meanwhile (a card would leave under
  its branch's name instead of its title, or give its log to another workstream, and not come back).
- **On Windows, one process starts at a time across all threads** (2026-11-08): Bun starts a
  process through libuv, which makes the child's ends of its pipes inheritable until the system has
  created it. A process another thread creates in that moment inherits them and holds them open
  while it runs: a quick git call started next to a fetch or push reached the end of its output only
  once that one ended, and a `Bun.spawnSync` on the server's thread would have stalled the server as
  long. So every start (`Bun.spawn` until it returns, the whole of a `Bun.spawnSync`, which starts
  and waits in one call, node's `child_process`, which starts through them) takes a lock shared by
  the server's thread and the process threads (an `Atomics` lock in shared memory); a thread that
  ends gives it back once it has ended. The server's thread waits for the lock only when it starts a
  process itself, and goes first: no thread starts waiting for the lock while it waits, so it waits
  for the start underway and at most one a thread had already headed for, not for the threads'
  queue (a burst of twenty starts next to four slow ones: a quick call on the server's thread took
  8 s before, as long as the slow ones, and at most about 0.4 s since). The price: the starts take
  turns, so a slow one holds up the others (a quick call on a thread waited up to about a second in
  that burst), and while the server's thread runs a `Bun.spawnSync` (a git call on a remote host,
  over ssh: seconds), the threads start nothing. Whoever waits takes the lock over from a holder
  that has kept it 10 s: a start does not take that long, so the holder hung in one, ended without
  giving it back, or runs a `Bun.spawnSync` whose process has long been created; waiting on would
  leave every start, and on the server's thread the whole server, stuck for good; taking it over
  risks only what the lock is for, a process started meanwhile inheriting a hung start's pipes. It
  counts on the monotonic clock, and a holder that gave the lock back and took it anew holds it
  afresh. Not on macOS and Linux, whose pipes are never inheritable.
  Rejected: starting every process on one thread on Windows (the server's own starts would still
  race with it); pipes created non-inheritable and handed over in an explicit handle list (Bun
  offers no such option; it would mean calling
  `CreateProcess` ourselves).
- **Synchronous file and process calls in the server's code are counted against a list with reasons**
  (2026-11-09): a test lists, per file, how many calls of each synchronous API (every function
  ending in `Sync`: `Bun.spawnSync`, `existsSync`) the file may make and
  why they may stay (startup before the server listens, the plugin's scripts, the stall watcher's
  own log, a stat of a known path where the caller cannot wait). A new one fails it until it is
  made asynchronous or listed with its reason, and a list that allows more than the code has fails
  too, so the list only shrinks. It counts names, not callers: a synchronous helper of Obeya's own
  whose name does not end in `Sync` (the git calls of `gitOrNull`) counts once, by what it calls.
  Rejected: a lint rule (the repository has no linter); forbidding every synchronous call (startup,
  scripts and a stat of a known path are fine). What the plugin's scripts read of a repository
  (its main branch, its settings) they read with the server's asynchronous functions, waiting at
  their top level: no function has a synchronous twin for them (2026-11-11). With
  it, what still waited on the server's thread went asynchronous: a canvas's repository settings
  and adapter module are only ever those read when the canvas resolved or its repository moved
  (no fallback read with git), the first canvas's folder is read without waiting, a demo site's
  page reads its versions' captions, posters and sound beforehand, the demo directory's sweep
  reads its settings without waiting, and a repository's theme for a page about to go out is read
  without the server waiting (the page waits for it). A demo site's overview over its pages is
  built at once: 6 ms over 401 pages the first time, 2 ms after, as each page's facts are kept.
- **Programs run without a window on Windows by default, not by an option at each call**
  (2026-11-01): one call forgotten brings the flashing windows back. A program meant to be seen asks
  for its window.
- **What reacts to a change on the canvas hears of it once the code that changed it is through, once
  for all it changed** (2026-10-31): a landing or a card moving on changes the canvas dozens of
  times in a row, and each reaction asks for the canvas as the page sees it, which took a few
  milliseconds to build on a canvas with hundreds of archived and shared cards; when many cards
  landed one after another, the server stood still for half a second at a time. The cards alone
  (what code reads back between its writes) are built apart from the rest of that view (the sheet's
  outdated pages, the workspaces, the notes on the plan directories), and one archived card is built
  without the whole archive. Which cards are prototypes (an idea lists its own, archived ones too)
  is read once per change, and each is made into a card when one first needs it, once per change
  too, not again for every card looked up: a pass of sharing looks up every shared card, hundreds of
  them, and stood still for half a second doing so. Such a pass (asking each site which pages
  another machine withdrew, naming a site's other pages to its deploy, picking the pages to share
  again) builds the shared cards it goes over together, archived ones in one go, and reads where
  each page goes from the share it already holds (2026-11-05): built one after the other, and again
  for each question asked of a card, the pass after a start stood still for up to five seconds on a
  canvas with some 350 shared cards. A write to one card (2026-11-02) makes only
  that card's row into a card anew: what the other rows made (their demos and pages, with a look at
  the demos' files) is kept while those rows stay the same, until anything else changes, when the
  files are looked at again (a demo deleted by hand shows as gone then); and the reads each change
  makes find their cards through indexes rather than going through the archive. The owner's
  settings file, asked for the language with every text the server writes, is read again only once
  it changed. Together this cut a run of thirty landings from a third of a second of CPU on a laptop
  (a second in CI) to a fifth of that. Rejected: patching only the written card into the canvas's
  cards (what other cards show depends on it: an idea's prototypes, the waits, a card's place in a
  queue); reacting to each change at once and only making the view cheaper (the reactions still
  build it once per change).
- **The notice of outdated pages is made anew only when what it is made of changes, and never
  waits for the disk** (2026-11-05): it went through every shared card of the canvas, archived ones
  included, with every change, and for each outdated page looked whether its demo's files were still
  on disk; once a new theme left nearly every page outdated, that was hundreds of looks at the disk
  per change, and the server stood still for up to seven seconds at a time. Now the database keeps a
  mark per canvas that moves whenever a shared card changes in what the notice reads (its page,
  title, repository, demos), one stops being shared or goes, and the notice is made again only when
  that mark, the run sharing pages again, what the owner hid, or a theme or vocabulary of tags of a
  repository with shared pages differs. The demos' files are looked at in the background: those the
  notice meets for the first time count as there until that look a moment later, and all of them
  are looked at again once a minute (demos are deleted by hand, outside Obeya), so the count follows
  a deletion within a minute. What a card on the canvas offers, and each page a run shares again,
  still looks at the disk directly: a few cards, not hundreds. Rejected: watching the demo directories for changes (hundreds of watches, or a
  recursive one over folders holding thousands of recordings, and not the same on every system);
  a mark made of the shared cards' times of last write (a status line on a shared card at work
  would move it, and two writes within a millisecond would not).
- **A rebuild of the canvas view reads the canvas's cards once, and what of it lies in the archive
  only once the archive changed** (2026-11-05): with the notice of outdated pages made anew only
  when needed, a rebuild after a write to one card still cost a few milliseconds of the server's
  thread on a canvas of a thousand cards, seconds when the machine was busy: a third of it
  went over every archived card with its workstreams and prototypes for the archive's mark the
  page compares, a third read the canvas's cards and projects again for each part of the view (the
  notes on the plan directories, the projects that ended, those that came, their origins). Now the
  database keeps the archive's mark, moving it with every write to a row the archive's items are
  made of, that row coming or going (an archived card, a workstream of an archived project, a
  prototype of an archived idea), as it keeps the mark of the shared cards; the cards read for the
  canvas serve the whole view; and the archived projects and cards whose work added plan docs are
  read again only once that mark moved. Asking which projects wait for their arrangement, on every
  change too, reads only the projects on the canvas that have one stored. Together this cut a
  rebuild to about a third. Rejected: the mark made of the archived rows' count and times of last
  write, read with each rebuild (it is what went over the archive); patching the view's parts from
  the written card (what they show depends on other cards).
- **A page's freezes are found by a worker's heartbeat, not by its own timer running late**
  (2026-10-30): the app's webview on macOS runs a page's timers about once a second when its window
  is not in front, with the page still in view, and logged a stall of about a second every second
  all night. A worker's timer runs on, and its message waits only for a busy thread. Rejected:
  taking every page without focus for one held back (a page shown beside the window in use freezes
  there as well, and where the browser tells long frames they show it; see below for the others);
  counting late timers only where the browser tells long animation frames (WebKit tells none, so it
  would watch nothing).
- **Without long frames, a page in a window in the background reports no stalls** (2026-11-05):
  from 2 to 5 November the app's window logged 106 stalls of up to 36 s with no cause, in bursts
  that each fell into a time nobody was at the screen: its display off and the screen locked (the
  lock screen is then the app in front, so no other window has the focus), the user idle by the
  system's count, or minutes after a restart. Ordinary CPU load on all cores made no stall in a
  test webview in the background, so what held the page back stays unknown; it came while nobody
  could see the page, and a stall of the window in use is still logged. Chromium's pages still report from the background: their long frames show the
  time went to the page's own scripts. Rejected: telling a held-back page from a busy one by the
  heartbeat (the worker runs on while the page's thread waits, either way); asking the system
  whether the screen is locked (macOS only, and the page in use says as much by its focus).
- **Obeya restarts itself for new code on its own checkout instead of hot reloading**: workers resume
  by session id anyway; hot reloading keeps old state alive next to new code. It also restarts for
  commits made outside Obeya.
- **A due restart is announced to the workers, which pause for it themselves** (2026-10-01): an agent
  knows where its work can stop. Rejected: waiting for a moment no worker is busy (with six in
  parallel it rarely came, and the 15 minutes ran out in test runs and renders); a lock agents set
  before long commands (rests on every agent remembering it); restarting workers one by one (one
  server process).
- **A turn that starts while a restart is due ends at once** (2026-10-14). Rejected: letting it finish
  its step: a worker sent back for a conflict landed its work before pausing, and one woken by its
  render went on rendering, holding the restart all along.
- **A worker paused for a due restart shows as waiting for it, not at work** (2026-11-02): a card
  approved while a restart waited for other workers read "Done · agent working" for minutes
  while its agent had long said there was nothing left. Rejected: ending a finished card's session
  at its paused turn (the worker may have left real work for after the restart, which the message
  told it to).
- **A restart waits for the owner only where it would destroy what they do** (2026-10-02): a playing
  video, a dictation until its words are in, a command in its undo window. Everything else is kept
  across the reload, so a page merely open does not hold new code back. The server, not the page,
  holds the dictation until transcribed and the undo window (2026-10-12, 2026-10-14): released with
  the key, a restart lost a long dictation mid-transcription; held by the page, a reload in the window
  lost the confirmed command.
- **Sidecars end through their stdin**, not by being killed: killed, Python left the model download's
  progress-bar semaphore behind and its resource tracker warned on the terminal.
- **The watch for new code reads files, not git, while nothing moves** (2026-10-29): on Windows,
  starting a process holds up the server's one thread even when it does not wait for the process;
  on a busy laptop `git rev-parse HEAD` held it 330 ms at the median and up to 11 s waited for
  (`spawnSync`), 60 ms and up to 1.5 s started without waiting. Asked every two seconds, it delayed
  the requests in that rhythm, a video's ranges among them. The files are told apart by inode, size
  and mtime in nanoseconds: `packed-refs` written anew can keep both its size and its millisecond.
  Rejected: git without waiting alone (still a process every two seconds, each holding the server
  up to a second); watching the git directory (watches miss changes, which is why plan
  directories are polled as well).
- **Git is called directly, and test repositories are copied**: on macOS Obeya calls the binary
  `xcrun --find git` names, not the `/usr/bin/git` shim, which looks it up on every call (10 ms instead
  of 4, over a few thousand calls a test run); on Windows the `git.exe` in git's exec path, not Git
  for Windows' `cmd\git.exe`, a launcher that starts it as a second process (2026-11-06). Starting a
  process costs 50 ms to over a second there (the virus scanner looks at each, more on a loaded
  machine), so the launcher doubled what each call costs; the real one finds its helpers (sh, ssh,
  the credential manager) by itself. Test repositories are copies of a template committed once, and
  the clones tests set up copies of a clone of it: a clone starts four processes on Windows, a shell
  among them, and took several seconds. Together they halved the test suite on macOS. Tests run
  without git's automatic maintenance (a process more after each commit and fetch), set by the checks'
  runner in the environment the test processes start with: what a test or the preload sets in Bun's
  `process.env` reaches no process it starts. On Windows,
  where the suite is bound by process starts, a test, a hook and a wait for an event get five times
  the time: with Bun's 5 s, half the suite timed out there. The checks' runner sets that timeout, so a
  `--timeout` given to it still holds. A repository's main branch and its commit are read with
  one `for-each-ref` (2026-10-15), not four to seven calls each time.
- **Tests run a file per process** (`bun test --parallel`, Bun 1.4+, 2026-10-15): one after the other
  the suite took 165 s, mostly waiting for git; in parallel 27 s. The longest file sets the run's
  length, so large test files are split by theme around a shared fixture. On Windows a quarter of the
  cores (2026-11-06): starting processes is what the suite waits for there, and the machine starts
  only so many at once, however many cores it has; a process per core made each test wait so long
  that half of them timed out, and eleven of the slowest files took 40 minutes instead of 14. The
  checks run `bun run test`, which picks the number by platform.
- **The first canvas is chosen with two cards and radio buttons**: pills read as buttons in a user
  test, not as a choice.
