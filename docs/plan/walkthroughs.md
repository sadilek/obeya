# Answers as narrated walkthroughs

> Plan doc for answers that come as a short walkthrough with slides and narration, playing while
> the agent still writes it. Deleted when its last workstream ships; durable content moves into
> [`docs/design/voice.md`](../design/voice.md),
> [`docs/design/the-koordinator.md`](../design/the-koordinator.md) and
> [`docs/design/conversation-on-the-card.md`](../design/conversation-on-the-card.md).

## Goal

Where an answer explains something (how a flow goes through the code, what a change does, how two
variants differ), it comes as a short walkthrough with slides and narration instead of a block of
text, and live: it starts to play while the agent is still writing it. Looked-up answers and
Question cards get it first. The agent judges where a walkthrough explains more than text; every
text answer has "Show as walkthrough" for the cases where it judged otherwise.

## Where it stands

- *Walkthroughs* (design: The Koordinator → Walkthroughs; W1): a look-up agent (the Koordinator's
  or a project agent) tells an answer that explains how something works as a walkthrough, slide by
  slide through a tool that refuses malformed slides and reads code slides' lines from the
  repository. The player shows under the question from the first slide on, in Obeya's sheet, the
  log of the card it was asked on and a Question card's conversation; the answer's words come in
  above it without interrupting it. It is Obeya's own page code reading a JSON file of the thread's
  directory, so its look can change for every walkthrough at once (W6).
- *Voice* (design: Voice → Voice out): Obeya speaks walkthroughs and nothing else. One voice for the
  server voices them sentence by sentence in the voice of the demo settings, in the queue it shares
  with renders, a playing player's sentences first (design: Demos → A voice that stays loaded).
- *"Show as walkthrough"* (design: The Koordinator → Walkthroughs; W2) shows on hover in the head
  of every text answer: in Obeya's sheet, a card's conversation and on Question cards. It follows up
  in the answer's thread; for a direct answer it starts a look-up thread. The newest answer shows it
  in view until it has been used once.
- *Demos of walkthroughs* (owner, 2026-11-07): in a demo video of this feature, the walkthrough
  inside it speaks in Kokoro (a scratch Obeya staged with `"voice": {"voice": "kokoro"}`), so the
  presentation in the video is told apart from the video's own narration in the owner's voice.
- *A pointer word by word* (design: The Koordinator → Walkthroughs; W3): the caption marks the word
  being spoken, from voice in's recognition hearing each sentence back; a flow's boxes build up as
  the narration names them.
- *Not yet*: the tool checks a slide's
  form, not whether its lines say what it claims or its narration only reads it out (W4); the player
  is not tuned for the phone, demo settings without a voice end in "Voicing failed", and sentences
  left unvoiced by a restart stay so, the player saying the voicing stopped (W5); the look is the
  prototype's, in Obeya's colours (W6).

### What the prototypes showed

Two prototypes, measured on the owner's Mac with Qwen3 and the voice clone.

"B Obeyas eigener Walkthrough", the basis of this plan:

- The agent writes slides (a title, points, a simple flow diagram, code with real lines of the
  repository) and their narration, and hands them over slide by slide. Obeya voices them sentence
  by sentence in the voice of the demo settings. A player under the question plays slides and sound
  in step: points and diagram boxes light up when the narration reaches them, and the spoken
  sentence stands as a caption. The finished answer slides in above the player without
  interrupting it.
- Through "Show as walkthrough" the first sound comes 7–12 s after the click and starts by itself.
  For a new question the first slide stands there after 20–30 s, while the agent still reads, and
  the first sound 2–5 s after it.
- What made it that fast: a title slide speaks only its title first (a short sentence, voiced
  quickly); the voice loads on the click on the button; with several walkthroughs at once, the
  voice first makes what a playing player needs next. With three at once the player still waits
  2–5 s now and then, showing "Voicing …".
- The agent chose a walkthrough by itself for 2 of 3 questions ("how does an approved card get onto
  main", "what happens when a demo is rendered"); "idea card or Question card" came as text, and
  the button turned it into a walkthrough.
- It never chose a code slide, because its instructions say that the owner does not read code.
- Headless Chrome records no sound: demos of walkthroughs mix the clips in afterwards, at the
  moments the player started them.

"A showntell, wie es ist", which loaded [showntell](https://github.com/rahimnathwani/showntell)'s
Claude Code plugin into the look-up agent:

- Worth taking over: its look. The slides' design; a player whose progress bar is cut into one
  segment per slide; the spoken sentence shown large enough to read along with every word, switched
  on and off with one click (and C). Also a pointer that follows the narration word by word; checks that tell the agent
  what is wrong while it writes (a line that does not exist, a slide too full, narration that only
  reads the slide out), on which it revised four slides; diagrams that build up as they are
  narrated.
- A warning: its player loaded straight from a local service (`localhost:4747`), which needed
  Obeya's CSP opened for that origin and cannot play from the phone or another machine.
- showntell's skill alone made the agent answer all three questions as text; only a sharper hint
  ("how something works or what happens when → walkthrough") and a live player moved it to choose
  walkthroughs by itself.

## Design

### Decisions

- **Obeya's own walkthrough, played live** (owner, 2026-11-06). Rejected: showntell as it is
  (English only, a dependency on a young project with one author, not playable from the phone);
  showntell with Obeya's voice (changing showntell to do what Obeya's own walkthrough already does);
  rendered MP4 explainer videos (the whole render time passes before the first frame).
- **Looked-up answers and Question cards first** (owner, 2026-11-06), not idea agents or workers.
- **The agent decides, the owner can ask** (owner, 2026-11-06): the agent judges where a walkthrough
  explains more than text; every text answer has "Show as walkthrough", which asks the same thread
  to tell its answer as a walkthrough, arriving as the next answer.
- **Code slides only when the owner asks for code** (owner, 2026-11-06); otherwise points and
  diagrams. The rule that the owner does not read code stays, with this one exception.
- **Obeya speaks walkthroughs** (owner, 2026-11-06): "Obeya does not speak" gives way for them.
  Confirmations and answers in text stay written.
- **The look follows showntell's** (owner, 2026-11-06): its slide design, the progress bar in one
  segment per slide, and captions to read along that one click switches on and off. Obeya's demo
  videos take over the same player look.

### The live walkthrough

- The agent hands slides over one at a time, the title slide as soon as it knows what the
  walkthrough answers, each further one once it has checked what it says; then it answers with a
  sentence or two on what the walkthrough shows. 4 to 8 slides, the narration in the owner's
  language as spoken prose that explains rather than reads out, one text per slide or one part per
  item (point, step, code range), each spoken while its item shows.
- Slide kinds: title; points (up to five); flow (three to six boxes joined by arrows); code (real
  lines of the repository, at most 30, read by Obeya from the file by their line numbers, with
  ranges highlighted one after the other).
- With the first slide, the player shows under the question, before the answer's words. An answer
  therefore no longer arrives in one piece: its walkthrough may show before its text.
- Obeya voices sentence by sentence with the voice it holds, in the queue it shares with renders.
  What a playing player needs next goes first. The voice loads on the click on "Show as
  walkthrough". A walkthrough asked for with the button starts by itself (the click allows the
  sound); one the agent chose shows its first slide and plays on the owner's click.
- The player and its clips come through Obeya's server, as every answer file does, so they play
  wherever the page plays: from the phone and from other machines too.

## Workstreams

- [x] **W1:** The live walkthrough. Built on the branch of the prototype "B Obeyas eigener
  Walkthrough": the slide format, the hand-over slide by slide, voicing sentence by sentence with
  the playing player first, the player under the question served through Obeya's server, the
  finished answer sliding in above it without interrupting it. The rule that an answer arrives in
  one piece changes accordingly. The look-up agent's instructions say when a walkthrough comes and
  that code slides come only when the owner asks for code. With tests against the fake runtime;
  the chapters Voice (the decision "Obeya does not speak" rewritten), The Koordinator and
  Conversation on the card describe the walkthrough.
- [x] **W2:** "Show as walkthrough" everywhere. Needs W1's way of continuing a thread. The button
  shows on every text answer in Obeya's sheet, on Question cards and in card conversations, built
  once in shared code: in the answer's head beside "Make it a card" on hover, always on the phone.
  A direct answer has no thread, so there the button first starts a look-up thread for it. A hint
  shows first-time users the button until they have used it once.
- [x] **W3:** A pointer word by word. Needs W1. The caption marks the word being spoken, with the
  times from Parakeet hearing each sentence back; diagram boxes build up as the narration reaches
  them.
- [ ] **W4:** Checks while the agent writes. Needs W1. A slide handed over is checked at once (the
  code lines exist and say what the slide claims, the slide is not too full, the narration does more
  than read the slide out), and what fails goes back to the agent in the tool's reply, so it revises
  the slide before going on.
- [ ] **W5:** Phone, no voice, restart. Needs W1. The player on the phone works as on the desktop;
  demo settings without a voice play the slides with captions at a reading pace; a walkthrough
  being voiced when Obeya restarts is voiced on afterwards and plays on.

- [ ] **W6:** The walkthrough's look. Needs W1. Slides and player take showntell's design as their
  model: the slides' typography, layout and colours, in Obeya's light and dark; a progress bar cut
  into one segment per slide, which jumps to a slide on a click; the spoken sentence as a caption
  large enough to read every word along, switched on and off with one click on the player (and C),
  the choice kept for the next walkthrough.
- [ ] **W7:** The demo videos' player in the same look. After W6. The demo on the card and on the
  shared demo pages plays in a player of the walkthrough's look, from the same code where it fits:
  the progress bar in one segment per chapter, the captions to read along, switched on and off with
  one click, and the keys the demo player has today.

W3, W4, W5 and W6 can run side by side once W1 has landed; W2 needs only W1's thread path; W7
follows W6. Each
workstream keeps the chapters it touches current in the same change.
