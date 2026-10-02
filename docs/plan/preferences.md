# Learning preferences

> Plan doc for learning the owner's preferences from everyday work. Deleted when it ships; durable
> content moves into [`docs/design.md`](../design.md).

## Goal

Obeya learns enough of the owner's preferences from everyday work that the owner never has to say
the same thing twice. A rule it learns is put to the owner as a proposal first; a rule the owner
accepts applies to every agent at once, not from its next session.

## Where it stands

- Learning runs through `Koordinator.learn` → `distill` (`src/server/koordinator.ts`): one reading
  session per utterance with `LEARN_SYSTEM`. The prompt is strict on purpose ("Most answers only
  decide the case at hand"). The session sees the card's title, the question if any, the text and
  the rules so far; not the card's body, its log or earlier utterances, so it cannot notice a
  repetition. What it recognises is proposed (W1); the card's log says "Schlägt vor: …".
- Sources (`OwnerInput`, wired in `src/server/canvas.ts`): notes and feedback to workers, the
  owner's own answers to worker and demo questions (option clicks included), the discussion of an
  idea. Spoken commands the Koordinator turns into a note, answer, feedback or discussion on a card
  go the same way, in its rewording.
- Not learned from: the conversation with the Koordinator itself (reply, look_up), the text of new
  cards and ideas, answers given in the owner's name (`workers.ts` passes only `by === 'owner'`),
  clicks without text.
- When the owner overrules an answer given in their name, the learner does not see the overruled
  answer, although `docs/design.md` (Communication) says overruling feeds the preference memory.
- How rules reach agents: workers get them in their instructions and, since 2026-10-01, a changed
  rule once at their next tool call (`AgentSpec.contextUpdate`); idea agents (`explorers.ts`) only
  when their session starts or resumes; project agents, Koordinator questions, look-ups and cuts
  with every message; the voice Koordinator (`commands.ts`) not at all.
- The Koordinator's sheet (`src/ui/koordinator.tsx`) lists the rules; they can be edited, deleted
  and added by hand.

## Design

- **Proposals instead of silent storing.** `preferences` (`db.ts`) gets a state (`proposed`,
  `active`, `rejected`), its occasion (card and quote, or "Rückschau") and an optional `replaces`,
  the rule a proposal would change. Every learned rule and every learned change to a rule is a
  proposal first; the card's log says "Schlägt vor: …" instead of "Merkt sich: …". Open proposals
  stand above the rules in the Koordinator's sheet, with their occasion; the owner accepts one,
  edits it before accepting, or rejects it. The Koordinator button shows their count; they do not
  count among the cards that need the owner and do not show on cards. Rejected proposals are kept,
  and the learner sees them so the same proposal does not come back. Agents get active rules only;
  the rules stored today stay active.
- **Explicit rules apply at once.** A rule added by hand in the sheet is active at once, as today.
  "Merk dir: …" to the Koordinator becomes a `remember` action in `commands.ts`: active at once,
  with undo like any other command.
- **More sources** (new `OwnerInput` kinds): the conversation with the Koordinator (commands without
  a card, reply and look_up, from `Commander.hear`); the text of new cards and ideas, spoken or on
  the canvas; overruling: a note or answer from the owner on a card whose last question was
  answered in their name goes to the learner with the overruled answer as context.
- **A filter with context.** The learner gets the card's body, the agent's last message, the
  owner's utterances of the last days, the active rules, the open proposals and the rejected ones.
  The prompt names the signals for a proposal: phrased generally ("immer", "nie", "ab jetzt"), a
  correction of *how* an agent works, or a repetition of something said before. Since everything is
  a proposal first, it may be looser than today, but should make few, good proposals.
- **Taking effect at once.** An accepted or changed rule reaches running sessions the way it
  reaches workers today, through `contextUpdate` at their next tool call, without interrupting:
  idea agents get it too. The voice Koordinator gets the active rules with every command.
- **Rückschau.** After about 20 new owner inputs since the last one (texts and clicks without
  text; the counter is a setting in the DB, so it survives restarts), a Koordinator session reads
  the history in between: inputs, decisions, approvals, dismissed proposals, undos, "Trotz
  Überschneidung gestartet", accepted and rejected preference proposals. It looks for patterns
  across cards and proposes rules with the occasion "Rückschau". Clicks without text count only
  here.
- **Rejected.** Storing silently as today: the owner wants to see every learned rule before it
  applies. Counting proposals among the cards that need the owner, or showing them on the card:
  the count on the Koordinator button is enough. A daily Rückschau, or one only on request: it runs
  after about 20 inputs.

Every package keeps `docs/design.md` current in the same change (Concepts: Preference memory;
Architecture: Koordinator; Communication: overruling).

## Workstreams

- [x] **W1:** Proposals. State, occasion and `replaces` on `preferences`, with the stored rules
  migrated as active; `distill` records proposals ("Schlägt vor: …"); agents read active rules
  only; the sheet shows open proposals with their occasion (accept, edit then accept, reject); the
  count on the Koordinator button (`App.tsx`). Tests in `koordinator.test.ts`. Comes first: W3, W4
  and W6 build on it.
- [ ] **W2:** "Merk dir". A `remember` action in `commands.ts` records an active rule at once,
  undone like any other command; the voice Koordinator gets the active rules with every command.
  Command tests. Independent of W1.
- [ ] **W3:** More sources. New `OwnerInput` kinds for the conversation with the Koordinator
  (`Commander.hear`: commands without a card, reply, look_up), the text of new cards and ideas
  (voice and canvas), and overruling an answer given in the owner's name, with that answer as
  context. After W1, so the new sources yield proposals, not silent rules.
- [ ] **W4:** Learner with context. `distill` gets the card's body, the agent's last message, the
  owner's recent utterances, active rules, open and rejected proposals; `LEARN_SYSTEM` names the
  signals for a proposal and asks for few, good ones. After W1.
- [ ] **W5:** Rules take effect at once for idea agents. `explorers.ts` passes changed rules through
  `contextUpdate` like workers do. Independent.
- [ ] **W6:** Rückschau. A persisted counter of owner inputs (texts and clicks without text); after
  about 20, a Koordinator session reads the history since the last one and proposes rules with the
  occasion "Rückschau". After W1.

## Risks

- More learning sessions cost more.
- Too many proposals get in the way; the right measure only shows in use.

## Open questions

None.
