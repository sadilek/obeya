# M6 Voice

> Plan doc for milestone M6 of [`docs/plan.md`](../plan.md). Deleted when M6 ships; durable
> content moves into `docs/plan.md`.

## Goal

The owner directs by voice: hold Space (or the microphone button), say what should happen, let
go. A short confirmation comes back, written and spoken, with undo. The transcript is not shown.

## Design

- **Target by focus.** Nothing unfolded: the Koordinator. An unfolded card: that card (its agent,
  its question, its demo). A project in focus: the Koordinator, told which project is meant.
- **Speech to text.** The browser records while the key is held and sends the audio to Obeya. A
  local Whisper (MLX) sidecar keeps the model loaded and transcribes it in German, with the
  canvas's vocabulary (card and project titles, Obeya's own words) as the prompt.
- **Meaning.** A short Koordinator turn reads the transcript, knowing it is speech and may carry
  recognition errors, with the focus and the cards around it, and picks one action: a new card,
  start, a note to the agent, an answer, feedback, approve, accept or dismiss a proposal, cut a
  card, stop — or a spoken reply when nothing fits. It writes the confirmation.
- **Undo.** Every action waits a few seconds before it runs; the confirmation offers
  "Rückgängig" until then, so even an approval by voice is safe.
- **Voice out.** macOS `say` with the default system voice renders the confirmation; the browser
  plays it.

## Workstreams

- [x] **W1:** Sidecar: Whisper (MLX) transcription with vocabulary; `say` for confirmations.
- [x] **W2:** Meaning: the Koordinator turns a transcript into one action; deferred run with undo.
- [ ] **W3:** Push-to-talk in the UI: Space and the mic button, level ring, target, confirmation.
- [ ] **W4:** End to end with recorded speech on Obeya itself.
