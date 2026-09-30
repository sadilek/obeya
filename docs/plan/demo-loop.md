# M4 Demo loop

> Plan doc for milestone M4 of [`docs/plan.md`](../plan.md). Deleted when M4 ships; durable
> content moves into `docs/plan.md`.

## Goal

Every change comes back as a narrated demo on its card: the owner watches it, reads the short
report beside it, and approves or gives feedback, without reading code.

## Design

- **Recording.** The worker records with the `demo` skill (scripted walkthrough, narrated video,
  report) once the change is committed and the checks pass. The adapter tells it how to run the
  app for a demo (Obeya itself: a scratch instance from the worktree, on a scratch repository).
- **Handover.** `ready_for_review` takes the demo: its directory, the chapter titles in scene
  order, and the report (shown, not shown, findings, an open question when there is one). Obeya
  checks that the directory holds `demo.mp4` and `captions.vtt` and reads the chapter times from
  the captions (one cue per scene). The card goes to `waiting: demo`. Where the adapter does not
  require demos, a summary alone still goes to `waiting: review`.
- **On the card.** The unfolded card plays the video (poster, captions, chapters that seek and
  follow playback) with the summary, the open question, and the report in three columns. Approve
  or send feedback; feedback sends the card back to its worker, which renders the demo again.
- **Files.** Demos stay where the skill writes them (`~/demos/…`), never in git. Obeya serves the
  three media files of a card's demo, with range requests for seeking.

## Workstreams

- [x] **W1:** Handover with demo, chapters from captions, `waiting: demo`, media route.
- [ ] **W2:** Demo view on the card: player, chapters, report columns, approve and feedback.
- [ ] **W3:** Adapters: demo requirement and how to run the app for a demo (Obeya, Acme).
- [ ] **W4:** Obeya on Obeya: a real card comes back with a demo and is approved from it.
