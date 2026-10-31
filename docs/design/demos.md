## Demos

A chapter of the [design doc](../design.md), whose header says how it is written.

### The demo skill

The demo pipeline (a scripted walkthrough of the app, recorded as a narrated video with a report
page) is part of the repository: `plugin/` is a Claude Code plugin named `obeya` whose skill `demo`
holds the instructions, the director, the overlay and the narration. The director drives the app
through Playwright on the local Chrome, else Edge, else Playwright's own Chromium (Linux on ARM has
no Chrome), cuts with ffmpeg and runs under plain Node on macOS, Linux and Windows (checked
2026-10-05).

Every page of the demo's browser, and of the browser skill's, gets a silent `speechSynthesis`:
Chrome's `--mute-audio` leaves the Web Speech API alone, so pages spoke through the system's voice.
The replacement keeps the API and speaks nothing: utterances queue, fire `start` and, after about as
long as saying them takes, `end`; `pause`, `resume` and `cancel` fire the spec's events, and a page
without a user activation gets `not-allowed`. So the page goes on as it would, which leaving the API
out (`--disable-speech-synthesis-api`) would not.

Both browsers show scrollbars as the machine's browser does (Playwright's headless launch hides
them by default), so a list scrolling in a fixed height, or two scrollbars side by side, shows in a
video and a screenshot. Permanent scrollbars on a Mac set to overlay ones would need Chrome started
without Playwright and were not wanted (owner, 2026-10-21).

The report page (`index.html` beside the video, for use without Obeya) holds the title, the summary
(what the change does, then what the owner needs to know beyond the video: a behaviour left out and
why, what is open or unverified, a defect found in someone else's change; a few short paragraphs),
the video with its chapters, the open question if any, and the provenance (branch, commits, stack).
Under Obeya the card shows the video and the handover summary instead, and a problem outside the
change is a proposal.

Obeya loads the plugin into every worker session (the Agent SDK's `plugins` option), so a worker has
`obeya:demo`, which its brief names, and `obeya:settings` (see Writing the settings). The skill also
runs without Obeya, as the plugin or as a user skill linking to `plugin/skills/demo`. Claude Code
lists a skill file once: when Obeya's plugin is the very directory such a user skill links to, the
session knows the skill as `demo`, not `obeya:demo` (Claude Code 2.1.299, 2026-10-14). So the brief
and the demand for a demo at `ready_for_review` name the skill as the session lists it, with the path
of its `SKILL.md` for a session that does not know it. At start, Obeya logs a warning when the
plugin's manifest or the demo skill is missing.

### The demo settings and voices

The demo settings (`demo.json` in Obeya's home) are the machine's, for every canvas: the narration
language (for narration, captions and report page; which one applies is under Language) and the
voice, a provider that takes text and gives a WAV. A repository's `demo.language` reaches the skill
as `DEMO_LANGUAGE` from Obeya, else from the `.obeya/settings.json` of the repository the skill runs
in. `node lib/settings.ts` prints what applies and where it came from, for the agent writing the
narration.

Local voices run as a command per clip with the text on stdin as UTF-8 (`PYTHONUTF8`: Piper on
Windows read the code page otherwise):

- Piper, the default (`de_DE-thorsten-high`, `en_US-ryan-high`; about twice real time on a laptop
  CPU, and Whisper heard its clips back word for word, 2026-10-02);
- Qwen3-TTS (1.7B, MLX on Apple Silicon, PyTorch elsewhere): a stock speaker, or a clone of a clip
  with its transcript beside it. A clone continues its clip, so a German clip carries German accent
  into English narration: the settings hold a clip per language (`references: { de, en }`; a single
  `reference` counts as the clip of its language). A language without a clip gets a stock speaker,
  nobody's own voice, so that narration is in the third person;
- macOS `say` (offered on a Mac only);
- the owner's own command (through the shell, writing the WAV to `$DEMO_WAV`).

Hosted voices are HTTP requests: Gemini, OpenAI (or another base URL with its API), ElevenLabs
(`eleven_v4` unless `DEMO_ELEVENLABS_MODEL` names another), Azure, or the owner's own endpoint (POST
JSON `{"text", "language"}`, audio back), each with its key from an environment variable or a key
file. Whatever comes back becomes a mono 16-bit WAV.

English terms in German narration ("Branch", "Feature", "Canvas") are respelt for the voices that
read every word by the narration language's rules: Piper (through espeak-ng, which made "Feature"
*fe-a-tu-re*) and `say`. The spoken form comes from a lexicon per language shipped with the skill
("Bräntsch", "Fietscher", "Kännwes", with inflected forms) and from a mark in the script,
`{Canvas|Kännwes}`, which wins. Whole words are replaced, longest first, before the clip cache is
keyed on the spoken text, so a lexicon change re-synthesises only the clips it touches; captions
show the written form. Other voices get the written form: Qwen3 sounded too German respelt, and the
hosted voices read English. A term enters the lexicon only where Piper got it wrong and the
respelling was heard back right through Whisper (2026-10-21); terms with no working respelling
("Branches", "mergen") are marked in the script where they matter. There is no English lexicon yet.

Voices are not labelled as generated, a clone included: the whole demo is generated, and that is
clear from where it is shown. „Das ist meine eigene Stimme“ in the settings decides the person: the
first person only in the owner's own voice, otherwise the narration presents the work without "I".
`DEMO_VOICE` overrides the voice for one render (another provider, never the owner's own, or a
`.wav` that Qwen3-TTS clones). A clone of the owner's voice never leaves the machine. Each clip is
synthesised once and kept as it comes (see Decisions).

#### The demo directory

Demos go into the demo directory, each into a directory of its own: `~/demos` unless the demo
settings name another (`directory` in `demo.json`, „Verzeichnis“ at the top of the dialog's Demos
section, which shows the path that applies). It is an absolute path or one from `~` (`~` is the
user's home on every platform, so `~/demos` holds on Windows too); a relative one would land
wherever the agent works, so it counts as none and the dialog says so. The skill reads it from the
settings (`node lib/settings.ts` prints it), so a session without Obeya follows it as well; Obeya's
brief names it for an HTML artifact. The demo directory is where demos are made, not where Obeya
looks for them: a handover names its demo by its absolute path, and the card serves it from there
wherever that is. A worker on a host puts its demos into the host's `~/demos` (see Hosts).

#### Disk space of demos

A render keeps the frames its video is cut from in its work directory (`.work/frames`, with their
list `.work/frames.txt`), about half a gigabyte a demo, which only re-voicing needs once the video
is made. Obeya deletes them a set time after the demo's last render: „Einzelbilder behalten“ in the
dialog's Demos section (`keepFrames` in `demo.json`: whole days, or `always`), two weeks unless set.
A render's last time is the newest change in its work directory (a re-voicing or a retake counts),
and a demo a render still holds (its `render.pid` names a running process) is left alone, checked
again right before deleting. A work directory or frames that are a link are not followed, and a
`demo.json` that does not read deletes nothing (read as the defaults, it would delete against an
owner's `always`). The rest
of the work directory stays: the narration's clips, so a render with the same words does not
synthesise them again (a hosted voice would be paid again), and the take's cuts, which are small.
Obeya looks a minute after it starts, every six hours after that, and at once when the setting or
the demo directory changes, over the renders in the demo directory (`<demo>/.work`, and
`<demo>/<voice>/.work` of a render in another voice); demos elsewhere and on hosts are not touched.
Looking through the demo directory and counting it never hold up the server: both go to the file
system asynchronously and a little at a time (looked through synchronously, a thousand demos held
it up for half a second).

The default applies only to the Obeya in the default home (`~/.obeya`): another one (a scratch
Obeya, a test, a render's own Obeya) shares the demo directory without sharing the owner's demo
settings, so it deletes frames only where its own `demo.json` says so (a scratch Obeya with the
default would go against an owner's `always`).

Below the setting the section shows what the demo directory takes and how much of it is in work
directories, counted in the background (some 30 s for two million files): after each deletion,
and when the section is opened and the last count is older than ten minutes or of another
directory than the settings name now. The last deletion
since Obeya started shows beside it (when, how many demos, how much freed).

#### Installing voices

Obeya installs Piper and Qwen3-TTS on request from the configuration dialog, which first shows what
is missing and about how large it is (each in its own uv-made Python environment under `voices/` in
Obeya's home, Qwen3's models in the Hugging Face cache, where one downloaded before counts as
installed; without Obeya the skill installs them the same way from the command line). A render
refuses a voice that is not installed and says how to install it. „Anhören“
plays a sentence in the chosen voice and narration language. For Qwen3-TTS the dialog has a field
per language for the clip to clone, each saying what keeps it from working (no such file, no
transcript beside it).

#### A voice that stays loaded

A voice that can stay loaded (so far Qwen3-TTS) is started on the first uncached clip of a render
(or an „Anhören“) and asked clip by clip, one JSON line each way over stdin and stdout: a ready line
once the model is loaded, a line per sentence done, then `ok` or `error` per clip. So the model and
the reference load once (a warm load costs about 2 s, a cold one 17 s, a clip 2–4 s). The libraries
print on stdout too, so the voice moves its stdout to stderr and keeps a duplicate for the protocol;
a stray line is shown and skipped. A voice that dies stops the render with the tail of its stderr;
one silent for 10 minutes while it loads or 5 minutes on a sentence (seconds on a GPU, a minute or
two on a slow CPU) is ended and its clip fails the same way. The sentence lines keep a long clip from
looking stuck.

Under Obeya the server holds this voice across renders as a child process. The spec says which voice
Obeya may hold (reference clip or stock speaker); the server builds the command itself, never from a
request. Workers and the dialog's sample get `OBEYA_URL`, the address of a narration server that
answers narration clips and nothing else, so a worker holds no key to the rest of the API (see Who
may talk to it). A clip goes to `POST /api/narration/clip` (`{voice, text, inline: true,
language}`, JSON only, so another page cannot send one without a preflight) and comes back as `ok`
with its seconds and WAV, or `error`; Obeya's own server answers the route too, with the owner's key,
and there may write to an absolute `out`. Clips of all renders wait in one queue, one at a time, and
each render asks for its next clip only once the last is done, so parallel renders take turns clip
by clip. The voice runs on for 5 minutes after the queue empties; a clip for another voice
(reference, speaker or language) ends it at once, as does Obeya's shutdown. The protocol and its
limits hold between server and voice; a voice that stops answering fails its clip and the next clip
starts a new one. Without `OBEYA_URL`, or when Obeya does not answer, the render loads the voice
itself.

#### One large model at a time

Parallel demos swapped the machine to a halt, so one render at a time loads a large model (Qwen3-TTS,
the owner's command): it takes the lock of `~/.cache/demo-skill/tts.lock` first and holds it to its
end (`flock`, a byte-range lock on Windows; compatible with `lockf` on the same file). A voice Obeya
holds takes no lock: renders go through Obeya turn by turn, with one model in memory.

### What a render needs

A setup check lists what a render needs: Node 22.18 or newer (TypeScript without flags), Playwright
and a browser, ffmpeg with libx264, uv (which brings Python) and the voice, each missing piece with
how to install it on this platform (Homebrew, winget, the Linux family's package manager, else a
page). The configuration dialog shows it below the demo settings („Was Demos auf diesem Rechner
brauchen“), again after an installation and on „Erneut prüfen“, naming what a voice lacks in the
narration language. A render runs the check first and stops with the whole list; an agent installs a
voice itself but asks the owner for system software. The machine setup guide is
`docs/demo-setup.md`. Not tried yet (2026-10-05): Edge as the fallback, a voice command through
`cmd.exe`, Qwen3-TTS through PyTorch.

### Recording a demo

How to run a project's app, for a demo too, is its settings' `app.run` (see Repository settings);
without Obeya the skill prints it for the repository it runs in. The worker records once the change is committed and checked, and hands over the directory and
chapter titles with `ready_for_review`. For Obeya itself the app is a scratch instance from the
worktree, staged by `scripts/scratch-obeya.ts` from a stage file before every take, its workers idle
unless the change is about agents (then their first take is recorded and retakes play it back, see
Agents played back), on a port the script picks so that parallel workers never
collide; staging again from the same stage file and code replaces the instance before, on its port.
A scratch Obeya speaks the stage's `language`, else the demos' language, and the stage's cards and
conversations are written in it, so the screen matches the narration. What an agent would do meanwhile (a line arriving in an open conversation, an
artifact handed over again) the script does as a staged card's agent through the server, which runs
that agent's own tools for it, so the page sees it as from a real agent. A staged HTML artifact is a
copy, so a take never changes the stage's files.

Before the first render the worker runs a dry run (`node demo.ts --dry`): the scenes against the app
without narration or recording, so a scene that waits for a state that never comes fails before
synthesis. A failing step names the page's URL, the screenshot and Playwright's message on lines of
their own. A call into the page with no answer within 20 s fails its step, as does a screencast that
sends no frame for 20 s. A computer that sleeps mid-take fails the take at once, named as such (the
director's timer ticking five seconds late; on a Mac the kernel's sleep time confirms it). On a Mac
the director holds `caffeinate -i` against idle sleep; a closed lid on battery sleeps regardless.

#### Cutting waits

A scene wraps a wait in `d.skip`: the page fades to white, the cut falls while it is white, and it
fades back in with how much later it is („31 Sekunden später“), about two seconds in all. The cut
comes out of frames, narration, chapters and captions alike; a clip the cut falls into goes on
across it, so a skip belongs after the scene's narration, and the next scene says the jump („Kurz
darauf“). The first five seconds of a wait are cut without a trace, only the rest falls into the
white. A wait that is only the app's latency is cut whole without flash or label (`quiet`). The
review table flags a scene with more than 5 s without narration. Each take keeps its cuts (wall
clock) in its work directory, for a playback of its agents.

#### Agents played back

A take whose agents are real can be recorded and played back, so that a retake (a scene, the
layout, the narration's timing) needs no new run: `scripts/scratch-obeya.ts --record <dir>` records
every agent session of the scratch Obeya (the Koordinator's, the workers', any other), and
`--replay <dir>` plays the recording back instead of running agents. A recording holds for each
session what the agent got (role, instructions, its tools with descriptions and schemas, the first
message) and then, in the order they happened and with their times, its events, its calls of
Obeya's tools with their arguments and results, the messages sent to it, the context updates taken
after its steps, and its end where it ended by itself. A worker's call also keeps the commits made
in its workspace since its call before (a git bundle), and a handover a copy of the demo it names,
without the demo's work files. The take's cuts go in too: the demo copies them in after the take,
or, for a recording in the demo's directory, the first playback takes them from there while they
are still the recorded take's.

Played back, a session Obeya starts gets the first recorded one not played yet of its role and
tools, the one with the same first message where several are left (so that two workers started in
another order each get their own). Its events go out again, its calls run Obeya's tools of the code
being run with the recorded arguments, a step recorded after a message waits until that message
comes, and one that read a context update (the owner's words in the middle of a turn) until there
is one. Before a worker's call its recorded commits go onto the card's workspace, picked one by one;
rewritten ones (an amend, a rebase) go as one commit of what they changed, or not at all where the
workspace holds that already (a rebase the landing of today did too). Before a handover the demo
goes back where it was. Everything else is Obeya's own code as it stands: card states, layout, held
comments, the handover, the landing; the page is always live, so a change to the UI never breaks a
playback. Card ids, branches, commits and paths differ in every staging: where a text the agent got
then and gets now (its instructions, a message, a tool's result) differ in such tokens alone, they
are paired, and what the agent says and calls is told in today's. The steps keep the recorded pace,
except that a gap within the recorded take's cuts lasts a moment; without the cuts no gap lasts
more than two seconds. Which sessions were played stays in Obeya's home, so a scratch Obeya that
starts again goes on with the next.

The playback refuses once the recording no longer fits: the instructions of an agent, a tool's
description or its schema, or its set of tools differ from the recorded ones (after pairing), a
tool refuses now what it took then, or recorded commits do not apply. The session then fails with
the reason on its card, `replay-refused.txt` in Obeya's home names it, and the take has to be
recorded anew. A message that differs from the recorded one is only logged: what the agents hear (a
spoken command, a comment) must stay as recorded, since the recorded agents act on the old words.
A session the recording has none for ends each turn at once. Not played back: what an agent leaves
uncommitted until its next call, files it writes outside its commits and its demo (a looked-up
answer's files), a folder without git's changes, and the app an agent ran, so the card offers no
link to it.

#### Pauses in every voice

Pause tags (`[short pause]`, `[long pause]`) are silence in every voice: ElevenLabs v3 and v4 read
them; for other voices the parts between them are spoken one by one and joined with 0.5 s or 1.5 s
of silence.

#### Sharp for a public page

A demo is recorded at one pixel per point and compressed to CRF 30 (about 2.5 MB a minute), small
enough to share, though flat colours go grainy on a large screen. A public video sets `sharp`: twice
the pixels, frames at JPEG quality 100 and CRF 18, so it looks as the app does live (2026-10-15).
The recording browser then runs at twice the device scale as a whole: Chrome's screencast sends
frames at one pixel per point whatever scale the page itself has (Chrome 156, 2026-10-31). The clock
strip is read from where it sits in the frame's own pixels, so frames at one pixel per point still
make a video, scaled up and with a warning.

#### The graphics card

The recording browser asks for the stronger graphics chip. On a Windows or macOS laptop with two (a
Windows laptop with an NVIDIA card, say, where it would otherwise take the integrated Intel chip) it
paints on that one while it records; Linux ignores the request, and a machine with one graphics chip
records as before.

#### Re-voicing

A demo that kept its frames (`.work/`) can be narrated anew in another language without recording it
again (`node demo.ts --revoice en`, or `node lib/revoice.ts <dir> en` when its script no longer
runs). It reads only what the render left in the directory (narration, chapters, caption timings,
report, whether it was sharp), so it works on a demo of any director version.

1. The first run writes the words to translate (`.work/revoice/source.json`: title, per scene its
   chapter title and narration, the report) and asks the agent running the skill for them in the
   language (`.work/revoice/en.json`, same shape). The agent reads the labels from the stills: the
   screen keeps its language, so the narration quotes a label as it appears with its meaning as an
   aside („Teilen“, share), which Qwen3 spoke more reliably than parentheses. A translation that
   drops a scene, an audio tag or a paragraph of the summary is refused with what is missing.
2. The clips are synthesised in that language's voice.
3. Each scene's narrated stretch is stretched or squeezed to its new clip, so an action timed with
   `untilSpoken` lands on the same word; leads, gaps and the cuts' flashes keep their length. A scene
   whose words change length by more than a third is flagged for a look at its stills.
4. Video, captions, chapters, stills, poster and report are rebuilt in place by the render's own
   code. The demo as recorded stays in `.work/revoice/original/`, which every later run reads from.

The card then shows it (`POST …/cards/<id>/demo-rebuilt`): the chapters are read again and the share
page's text is written anew in the report's language. A demo on a shared page is withdrawn first,
not changed under the page. `scripts/revoice-demos.ts` lists a canvas's latest re-voiceable demos
and has Obeya re-read and share them.

#### Frames on time

Frames go on the video by the time they were painted (see Decisions): the overlay paints the time
into a strip of 24 black and white cells at the page's bottom left, the director reads it from every
frame and paints the strip over. A frame painted within a second before one already on the video is
left out: the screencast now and then hands one over after later ones, and held in place it showed
the page as it was a moment before (a highlight ring seemed to blink). A clock read as hours earlier
(a strip under the white veil) or as later than the frame was handed over is misread: its frame
stays, timed as one whose strip cannot be read. The overlay runs in the top frame
only: Playwright runs init scripts in every frame, and each iframe would paint a strip of its own.
The strip is read in gray before it is cut out: ffmpeg 6 cuts a 4:2:0 JPEG (as Chrome encodes its
frames) to even heights only, and the one-pixel row failed on every frame.

During the take the recording browser's processes (its own, the GPU's, every renderer, again every
few seconds for one that starts later) and the director run above normal priority, and the encoding
after it at normal priority, so it gives way to another demo's take. Where raising a priority needs
rights (Linux, macOS) the take runs at normal priority (see Decisions).

#### Highlights

A highlight ring goes around what can be seen of its elements: each box is cut to every ancestor
that clips its overflow and to the window, while the ring follows scrolling; an element out of
sight does not count. One layer dims the rest of the page, with a hole per ring in its CSS clip
path (rejected: an SVG mask, whose removal stalled Chrome for about 0.27 s, a jerk in the video,
2026-10-15). A highlight on just the elements a ring of the scene has already stops the scene with
an error naming both labels, since its locator has mostly matched another element than meant; to
relabel an element, a scene clears its highlights first.

### The demo on the card

The card shows the demo on the left, beside the conversation (see Card layout). Obeya serves video,
poster and captions (with range requests) and takes the chapter times from the captions. A range is
read from disk at once and answered in one piece, up to 8 MiB per answer, the player asking for the
rest, and so is a whole file of up to 8 MiB (the poster, the captions). An answer carries only what
the file holds when it is read, with headers to match: a file a retake cuts meanwhile gives a
shorter answer, never one padded with other bytes. A video without a poster shows its first frame,
sized from its metadata (Chrome sizes an unplayed video by its poster).

When the result is something to look at rather than something that happens, the worker makes an HTML
artifact instead: a directory with an `index.html` and the files it loads, shown in a frame where
the video would be. Obeya serves any file of that directory and none outside it, by its real path (a
link to a file elsewhere is not served, published or exported), with a CSP sandbox and the frame's
`sandbox`, so the page's scripts run in an origin of their own, away from Obeya's API. That origin is
`null`, so what the page loads in CORS mode (a module script, `fetch()`, a font) needs
`Access-Control-Allow-Origin: null`, which would let any sandboxed page on any site read the files
too. So the page is redirected to `<directory>/~<key>/index.html`, the key an HMAC of the directory's
address with a secret new at every start; only an address with the key gets the header, and what
the page loads relative to itself carries it.

Nor does the page send anything to the internet: an agent steered by text it read could write a page
that sends it elsewhere the moment the owner opens the card, and writing an HTML file passes checks a
`curl` would not. Each file's CSP allows the files beside it, inline styles and scripts (`eval` too),
`data:` and `blob:`, and nothing else; a page brings what it needs along. The files are named by
`'self'` and by the address the request was sent to (the one behind `tailscale serve` too), since in
the sandbox Safari matches `'self'` against the origin `null`. Preconnects (whose host name alone
reaches a DNS server) and WebRTC, which a CSP does not reach, `Connection-Allowlist:
(response-origin)` stops (Chrome 152 on; Firefox and Safari know no such header, and stay open
there). DNS prefetching is off.

A page could also navigate its own frame elsewhere, which its CSP cannot stop; Obeya's page allows
its frames nothing but its own addresses (`frame-src`). A file that may run scripts (HTML, SVG),
opened in a window of its own (an answer's page from its link), comes in a sandboxed frame of a page
around it with the same rule (on `Sec-Fetch-Dest: document`; a browser that sends none gets the file
as it is). An idea's mock has no response of its own to carry these headers, so the card's frame
loads an empty page Obeya serves with them and writes the mock into it; the same CSP leads the mock
as a meta tag, ahead of its own HTML, so nothing in the mock can push it out of the head.

The artifact's `index.html` reports its height as a shared artifact's page does (see A shared
artifact), so the frame grows to the page (up to 30,000 px) without a scrollbar of its own and only the
card's column scrolls up and down. A page wider than the frame (a wide table on a phone) scrolls
sideways inside it. The page reports its own height, never its frame's: measured without a scrollbar
of its own, and not before the frame has a size. A page hears of its frame's new height a step late,
and a page of images as wide as itself, measured once beside its scrollbar and once without, or at
its frame's height, had its frame jump between two heights for a second as the card opened. On the
card it also reports what the owner marks in it, to be quoted
into the field (see Quoting marked text).

The addresses the card loads its demo from carry the handover (`?v=<handover>`), since a worker
often renders a new demo into the directory of the one before: a card left open loads the new demo
when it arrives.

A handover without a demo is refused, unless the card has one from an earlier handover, which then
stands: whether to record a demo again after feedback is the worker's call. While the worker works
again or waits on a question, the card shows the last demo without autoplay, with a hint that it is
the last handover's and the agent is on the task again; sharing stays beside it. Demos stay in
the demo directory, never in git; a pull request links a demo only once it is shared (see Sharing a demo).

#### Watching the demo

The demo plays by itself the first time the card is opened in a visible page (per browser; a new
render counts as new); after that, or when the browser blocks autoplay, it waits behind a big play
button. Z or the magnifier zooms the playing video out of the card to as large as the window allows
above the microphone; Z, Esc or a click beside it ends the zoom.

Space tapped plays and pauses; held, it records as everywhere (see Voice in), from the press, but
with a video open the microphone lights up only after 200 ms, so a tap does not flicker it. ← and →
jump 5 seconds. Browser video controls keep every key once clicked, so the video hands the focus
back to the page at once, except when the controls take it back within a second: their overflow
menu (⋮) takes the focus as it opens and closes when it loses it, and a press on the controls never
reaches the page, so only the timing tells the menu apart. Without a fine pointer there are no keys,
and the video keeps the focus. Hints for Z and the arrows show until first used.

#### Comments at a place in the video

What the owner types or says while the video stands in the middle is about that place. Space or the
microphone held while it plays pauses it, so the speech recognition does not hear the narration, and
letting go plays on; typing pauses it too, with the place quoted above the field („1:23 · chapter“,
× to remove it), and Enter sends and plays on. „Hier kommentieren“ beside the magnifier (both shown
on hover only, so they do not cover the picture) pauses and focuses the field; the legend (`?`) has
a section for the video. At the start or the end, words are about the work as a whole.

The browser uploads the frame as a screenshot; the server adds the chapter and the narration's
sentence at that time (estimated by its share of the scene's caption). The conversation shows the
words with the frame and „▶ 1:23 · chapter“, which plays the video from there.

On a card waiting for approval, Obeya holds such comments until the owner has finished watching, so
the worker reworks the demo once. They show at once, with a line under the last that they go to the
agent once the owner has watched, and „Jetzt senden“; they go when the owner sends them, the video
ends, the card closes, the video stands still for three minutes, the owner writes without a place
(in the same message, after them), or approves (the worker hears them with the approval, to propose
as a card what still matters); otherwise ten minutes after the last. Approving as the card folds
still takes them. Until they go, each stands dashed and unread at the end of the conversation, with
a bin to take it back (its words return to an empty field); once sent it moves to where it went. The
worker gets them in one message, each as `[Demo video at 1:23, chapter „…“, narration: „…“]` above
the words with its frame. Such a comment is no answer to the report's question. On a card at work or
finished, a comment with a place goes at once.

#### Earlier demos

A new demo replaces the one on the card, but the card keeps those before: a demo after feedback
often shows only what changed. A line above the video, left of „Teilen“, says which is shown
(„Neueste Demo 2 von 2 · 13:37“), with ‹ and › and „Zur neuesten“; an earlier one is marked in
colour („Frühere Demo 1 von 2“). Sharing is about the demo shown (see Several versions on one page).
Stepping does not count as having finished watching, and a new handover leaves the owner on the demo
they look at. A demo whose directory a later one reused, or whose files are gone, is not offered. A
comment on a place keeps its demo: a click shows that demo, and the worker hears it as about the
earlier video.

### UI checks

Workers check web UIs with the plugin's skill `browser` (`obeya:browser`): a headless browser driven
over CDP from the shell (open, nav, tabs, eval, text, screenshot, pdf, and `input` with trusted
clicks, drags, wheel, held keys, typing, waits and `@selector` targets), with the names and syntax
of the owner's earlier private skill `chrome-headless`, so workers' habits carried over. Each Claude
Code session has its own browser, muted and with the silent `speechSynthesis` (see The demo skill),
keyed by the session's process (`CLAUDE_PID`); the silencing must be in place before a page's first
script, in every out-of-process frame and every later document. The browser closes when the session
ends, at `stop` (through CDP, since on Windows killing its holder leaves it behind) or on a signal.
Without `CLAUDE_PID` (a terminal) there is one browser per user. `--fake-mic` plays a WAV as the
microphone.

The commands drive Chromium only. For WebKit (Safari's engine, and the macOS app's window), Firefox
or a script in Playwright's API, the skill's `playwright` prints the import line of the
`playwright-core` it launches its browser with, as a file URL that a script anywhere can import
(a bare `playwright-core` resolves only inside Obeya's tree), and whether Playwright's own WebKit
and Firefox are installed; `playwright install` installs them.

What headless Chromium can't reproduce (the on-screen keyboard and `visualViewport`, video
fullscreen, rotation) workers check in Obeya's repository with `scripts/android-phone.ts`: Chrome in
the Android emulator, driven from the shell (start, open, eval, tap, type, rotate, screenshot,
record, stop). Every wait in it is bounded and ends with an error naming what it waited for (workers
had built such helpers in /tmp for each card, at most of a run's tool calls, and their unbounded
waits were blocked). `start` boots the AVD read-only, so several checkouts each run their own
emulator of it. A tap is a real touch, so the keyboard opens (`tap` on a text field returns once it
is open and the page has settled) and fullscreen counts as a user's gesture. `open` turns off what
Chrome and Android lay over a page on their own (first-run screens, prompts to allow notifications,
translate or install, the first-fullscreen hint), which would catch taps meant for the page;
`rotate` turns the emulator's acceleration sensor, as a hand turns the phone.

### Decisions

- **A demo is a video or an HTML artifact, chosen by the worker** (2026-10-01): drafts to choose
  from (a logo) say more side by side on a page than in a recording.
- **There is no handover without a demo** (owner, 2026-10-15): without one the owner has to read to
  decide. Rejected: a `no_demo` handover with a reason, and a repository setting leaving demos to the
  worker; a settings file that still has `demo.required` shows it as a problem.
- **The demo report has no lists of what was shown, not shown and noticed** (2026-10-05): the owner
  never read the first two and rarely made a card of a finding. What matters goes into the summary;
  a problem worth a card is a proposal.
- **A demo's scratch Obeya is staged by a script from a stage file** (2026-10-01): staging by hand
  took longer than the change, with the same mistakes each time (the wrong API path, a server that
  restarted on the worker's commit, a staged working card a real agent resumed, agents the
  Koordinator started mid-take). The script writes cards straight into the database, so any state is
  a line in the stage file.
- **Retakes of a demo with real agents play a recording back** (owner, 2026-10-22): a hero render
  with a new run took about 13 minutes, cost Claude usage, and came out different each time (the
  form, the status lines, whether the agent proposed a card); a playback takes minutes and comes out
  the same. The release's render and a demo's first take with real workers stay real runs and record
  them: the only check in which a real agent goes through a worker's whole flow (start, demo, held
  comments, second demo, landing) on the build that ships. Every agent of the scratch Obeya is
  played back, or no render comes out the same twice. Rejected: a stand-in written by hand (idle
  workers have no turns, so the comments delivered would go nowhere, and the video would show no
  real run); real runs with only the early scenes shortened (the agents' scenes still vary and cost
  a run).
- **The playback checks the agents' instructions in full** (2026-10-22), not a fixed part without
  what is the card's: in a playback the card, its task and branch come from the same stage and the
  same recorded calls, so after pairing ids they are as recorded, and what differs is a change to
  Obeya's prompts or tools that the recording no longer fits.
- **Ids are paired from what the agent got** (2026-10-22), not kept by the stage's keys: the card
  the hero video's agents create has no key, and its id, branch and workspace reach the agents only
  in what Obeya tells them.
- **A playback keeps the recorded pace except across the take's cuts** (2026-10-22): the scenes then
  find the agents where the recorded take found them (the worker still at work when the video looks
  in), and what was cut costs no time.
- **The demo directory is a demo setting of the machine** (2026-10-26), in `demo.json` beside the
  voice: it is a local path of one computer (`/opt/work/demos` on one, nothing on another), and the
  skill already reads those settings without Obeya. Rejected: a repository setting (a path of the
  owner's machine in a file every colleague checks out); an environment variable (the skill run by
  hand would not see it, and the dialog could not show it); a symlink at `~/demos` (what users
  asked to be spared, and not without admin rights on Windows).
- **Old demos lose their frames, not their whole work directory** (2026-10-29, issue #18): the
  frames are nearly all of it (329 of 335 MB in one demo), and the clips beside them spare a
  re-render with unchanged narration from synthesising again, which with a hosted voice (the hero
  video's) costs credits each release. Deleted by time since the last render, which covers demos
  made without a card too. Rejected: deleting when the card lands or is archived (a demo is not
  always a card's, and a card's demos may live anywhere); deleting nothing by default (demos filled
  hundreds of gigabytes unnoticed).
- **Demo files are read at once, up to 8 MiB per answer** (2026-10-29, measured again 2026-10-31):
  a file streamed in pieces through the server's event loop stalls whenever the loop is busy, on
  Windows at about 1 MB/s; the card waited for the poster before it showed the video, and the video
  stopped with its buffer bar showing more loaded. Read synchronously, an 8 MiB range holds the loop
  for about 15 ms and arrives in one loop turn. Rejected: streaming the file (on Windows, with the
  loop blocked 100 of every 105 ms, 1–6 MB/s against 30–170 MB/s read at once; blocked 1000 of
  every 1005 ms, 10–50 s per range against 0.3–2 s); reading it asynchronously (as fast as at once on
  macOS, but on Windows two to four times slower under the same loads, 15–50 MB/s and 1.4–6 s per
  range); a range answered in full (a whole video read for one answer).
- **Every worker gets the plugin** (2026-10-08), not only those of a repository with demo settings,
  which otherwise had no way to the skill that writes them.
- **Demos do not listen back to their narration** (2026-10-15). Rejected: transcribing each clip and
  synthesising it again below a 95 % match: of 1,034 clips none had matched below 0.90, no retake
  came out better, and the owner found it overkill.
- **Earlier demos stay on the card** (2026-10-16): a demo after feedback often shows only the
  corrected part.
- **The demo zooms within the window** (2026-10-12). Rejected: full screen, too much on a large
  monitor.
- **Space and the arrows reach the video; the microphone's 200 ms wait holds only with a video
  open** (2026-10-14). Rejected: a microphone flickering at every tap, and controls that kept the
  keys once clicked.
- **Comments are tied to a place in the video and held until the owner has watched** (2026-10-12).
  Rejected: the owner naming the time while the video ran on; held comments standing where they were
  said, above worker steps that had not heard them (2026-10-15).
- **A dry run before the first render, and failures that say where**: twice a scene waited for a
  state that never came and showed it only after synthesis; a worker once took the screenshot's
  path, the only path in the message, for the page's address.
- **The browser skill names the Playwright it brings** (2026-10-30): a worker that wanted WebKit
  searched the whole home directory six levels deep for a `playwright-core`, which made macOS ask
  the owner for access to Music and iCloud Drive on the app's behalf. The skill says where it is.
  Rejected: forbidding the search in the prompt; WebKit and Firefox in the skill's own commands, which
  speak CDP, a protocol neither engine has.
- **Demos run under Node, not Bun** (2026-10-09): Bun 1.3.12 closed a child's pipe when it collected
  the process object, after the descriptor had gone to the next child, so the recording browser
  lost its DevTools pipe and every demo run with `bun` hung after its first scene. A demo started
  with `bun demo.ts` runs itself again under Node.
- **A render names a sleep of the computer and keeps no display awake** (2026-10-17): renders failed
  with "no frame for 20 s" to the second when the Mac went to sleep (lid closed, on battery); a
  sleeping display or locked screen costs a render nothing.
- **Waits are cut, but not short ones**: a demo of real agents had half a minute where nothing
  happened, and a flash for „2 Sekunden später“ disturbed more than the wait. A wait that is only
  the app's latency gets no label (2026-10-14): „5 seconds later“ over Obeya reading a command made
  its replies look slow.
- **Frames are timed by a clock painted into the page** (2026-10-08): on a busy machine the
  screencast handed frames over 1 to 5 s after they were painted, stamped with the hand-over, so the
  picture trailed the narration.
- **The recording browser asks for the stronger graphics chip** (2026-10-28): on a busy Windows
  laptop with an NVIDIA card, the screencast of a test page handed over 28–44 frames a second
  instead of 22–27 on the Intel chip. The cost: the stronger chip draws power while a demo records.
- **Encoding stays with libx264 on the processor** (2026-10-28). Rejected: NVIDIA's encoder, no
  faster (reading the JPEG frames takes most of the time) and, at the same quality, files twice the
  size.
- **The take runs above normal priority** (2026-10-30): on a busy machine (Windows, agents and
  builds on every core) the page still painted 60 frames a second, but the screencast delivered as
  few as 8: the copying, encoding and handing over of its frames waited for the CPU, and the video
  stuttered. Above normal priority it delivered 55 to 60 under the same load; high priority did no
  better. Rejected: acknowledging a frame before writing it, and a lower JPEG quality, which changed
  nothing measurable; rendering on a virtual clock, which would decouple the page from the live app
  and the agents it shows; encoding below normal priority, which a busy machine starved for over
  ten minutes.
- **A highlight ring takes only what can be seen** (2026-10-14): a ring around whole boxes took in
  a task message scrolled out of view and covered half the card.
- **A held voice that stops answering fails its clip** (2026-10-21): one sat at 0 % CPU for 40
  minutes, and every render and the dialog's sample waited behind it until it was killed by hand.
  Holding the voice saves a model load per render or „Anhören“, at 3–4 GB held for 5 minutes.
- **Respelling only for voices that need it** (2026-10-21). Rejected: English phonemes for Piper
  (Thorsten hardly has *w* and *ɹ*; Whisper heard "Pull Equest" and "Benz"), and recognising English
  words by themselves ("Demo", "Team", "Agent" belong to both languages).
- **An artifact's frame grows to its page** (2026-10-08). Rejected: a frame that scrolls inside the
  card's column, two scrollbars side by side; the size must count the border and a scrollbar across
  the page's foot, or the frame keeps a bar that scrolls by a few pixels.
- **An artifact's files are read under a key in their address** (2026-10-16): the CORS header alone
  would let any sandboxed page read the files of a card whose id it knows (an answer's files sit
  under a thread's plain number), and the frame's requests carry no `Referer` in Chrome, so only
  their address can tell them apart.
- **Each session has its own muted browser.** Rejected: one browser per machine in a shared state
  file, as `chrome-headless` had: sessions reused whatever instance ran, and an unmuted one that
  outlived its check played demo narration through the speakers.
