# M3 Koordinator

> Plan doc for milestone M3 of [`docs/plan.md`](../plan.md). Deleted when M3 ships; durable
> content moves into `docs/plan.md`.

## Goal

With worktrees several workers run at once. The Koordinator (the Chief of Staff, without voice
for now) keeps that from hurting: it does not start a card whose changes are likely to collide
with work in progress but queues it, cuts large cards into packages that can run in parallel,
answers the questions of standalone cards, and learns the owner's preferences.

## Design

- **Scope.** Before a card starts, a read-only Koordinator session estimates which files it will
  change (tool `scope(files, collides_with, reason)`), given the card and the cards in progress
  with their estimated and actual files (`git diff` of their workspaces). The estimate is stored
  on the card.
- **Collision.** A card collides with a card in progress when their files overlap (a path ending
  in `/` covers the directory) or when the Koordinator names it in `collides_with`. Paths the
  adapter marks as soft (docs, plan docs) do not count: overlapping edits there are resolved when
  the branch is rebased.
- **Queue.** "Agent starten" asks the Koordinator. No collision: the worker starts. Collision: the
  card waits, showing whom it waits for and why; it starts as soon as nothing it collides with is
  in progress any more (landed, approved or stopped). The owner can start it anyway or take it
  out of the queue. Starts are decided one at a time, so two cards cannot both slip through.
- **Cutting.** "Aufteilen" on a planned card lets the Koordinator cut it into packages that touch
  different files, each with its scope; they replace the card (with undo).
- **Questions.** A standalone card's question goes to the Koordinator, which answers from the
  preference memory and the canvas's decisions or escalates, like a project agent.
- **Preference memory.** After an owner answer, note or review feedback, the Koordinator decides
  whether it states a lasting preference and records it as a short rule. Workers, project agents
  and the Koordinator get the rules in their instructions. The owner sees and edits them in the
  Koordinator's sheet, which also shows the queue.

## Workstreams

- [x] **W1:** Scope and queue. Scope estimate, collision check, queue, start when free, force
  start and dequeue; card and panel show the waiting state.
- [ ] **W2:** Cutting. "Aufteilen" replaces a card by parallel packages.
- [x] **W3:** Questions of standalone cards through the Koordinator.
- [ ] **W4:** Preference memory. Rules learned from answers, notes and feedback; used by every
  agent; the Koordinator sheet shows rules and queue.
