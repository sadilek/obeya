# More than one harness: Claude Code and Codex

> Plan doc for agents that run on other harnesses than Claude Code, starting with Codex (GitHub
> issue #52). Deleted when its last workstream ships; durable content moves into
> [`docs/design/agents-and-workspaces.md`](../design/agents-and-workspaces.md).

## Goal

The owner runs Obeya's agents on the subscriptions they have: Claude Code, Codex, or both side by
side, and later more harnesses and local models. Which agent runs on what is chosen where it
matters: per group of agents, per canvas or project, per card.

## Where it stands

Since W1–W4, each group of agents runs on Claude Code or Codex as the owner chose in „Agenten und
Modelle“; the welcome screen accepts either harness; the bar shows the usage limits of every plan
agents run on (design: Agents and workspaces → Codex, Harnesses, models and effort; The canvas;
Setup assistant). Since W8 a card's conversation names the harness and model its session runs on
(design: Conversation on the card → The conversation). Since W11, Codex works where Claude Code
does in daily use: on SSH hosts, with its hooks refusing long foreground waits and following a
folder's changes before they run, in the Arbeitsrückschau, and with a login button on a card whose
session lost its login.

## Workstreams

- [x] **W1:** A Codex runtime. Agents of any group run on Codex through `codex app-server`, with
  Obeya's tools, resume after a restart, steering for messages during a turn, the usage limit's
  wait, and questions for the owner where Codex asks for approval.
- [x] **W2:** The welcome screen finds Codex beside Claude Code; either one with a login lets the
  owner start.
- [x] **W3:** „Agenten und Modelle“ chooses the harness, then the model, then the effort, per group.
- [x] **W4:** The usage bar shows the limits of each plan agents run on.
- [ ] **W5:** Choosing the agent on the card: „Starten“ starts the card on the default of its
  group; a menu beside it chooses another harness and model for this card, kept with the card for
  its later turns.
- [ ] **W6:** Defaults per canvas and per project, over the machine-wide ones of „Agenten und
  Modelle“.
- [ ] **W7:** Recommended models: a card gets a size estimate and a suggested model, shown beside
  the default rather than overriding it.
- [x] **W8:** The model on the card: a card's conversation names the harness and model its agent
  runs on.
- [ ] **W9:** More harnesses: opencode and pi, each behind the same session interface.
- [ ] **W10:** Local models, where no harness brings them.
- [x] **W11:** Closing the Codex gaps that matter in use: Codex on SSH hosts, the Arbeitsrückschau's
  excerpt from Codex's threads, a folder's undo before a Codex change runs, a long foreground wait
  refused, the login button on a card whose Codex session lost its login.
