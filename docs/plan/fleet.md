# Workers on more than one machine

> Plan doc for an Obeya that runs its workers on other machines too: the owner's machine first,
> other machines over SSH when it is full. Deleted when it ships; durable content moves into
> [`docs/design.md`](../design.md).

## Goal

The owner directs a few dozen workers without overloading the machine Obeya runs on. A card's
worker runs where there is room: on the owner's machine as long as it has a free slot, else on
another machine reachable over SSH (a second laptop at home first; later, if that is not enough,
cloud instances that start per card). A card that waits for the owner keeps its workspace but
stops its app stack, so waiting costs disk, not memory.

## Where it stands

- Every worker runs on the machine Obeya runs on: one Agent SDK session per card
  (`sdkRuntime` in `src/server/runtime.ts`), in a workspace from the repository's pool (clones or
  worktrees, design: Workspaces). A pool of clones is sized by the number of clones, and every
  leased clone counts the same whether its worker is busy or waits.
- A repository with its own app stack per clone (the owner's work repository) starts it through
  the adapter's `stack.start`. Since W1 Obeya stops it while the card waits, where the adapter
  names `stack.stop` (design: Parking); the work repository's adapter names it, with `stack.keep`
  for a workspace whose database is to persist.
- Measured on the owner's Mac (M4 Pro, 48 GB) on 8 Oct 2026, the work repository's canvas, 1–8 Oct: workers were
  busy in a turn for 74 worker-hours but held a workspace for 963 (busy 8 % of the time). At most
  8 were busy at once, and busy work beyond 3 at once came to 17.6 worker-hours in 5 working
  days. The 5–9 held clones each kept their stack running (AppHost, API, simulators, Vite,
  containers), which filled the 48 GB and a 20 GB swap. The Claude Code processes themselves took
  2.3 GB in total.
- The Agent SDK lets the host application start the Claude Code process itself
  (`spawnClaudeCodeProcess`, documented for VMs, containers and remote machines). The SDK's
  control messages, which carry Obeya's in-process MCP tools and its hooks, travel over that
  process's stdin and stdout.

## Design

### Workspace and slot

A workspace is a clone or worktree on disk and stays with its card until the work lands, as
today. A slot is room for one busy worker with its stack. A machine (host) has a number of slots
and any number of workspaces: the owner's Mac might keep eight clones but run at most three busy
workers. A card takes a slot while its worker is in a turn and gives it back when the turn ends;
a host may go over its slots briefly when several waiting cards get messages at once (the owner
answers three cards in a row), since refusing the owner's answer would be worse.

### Parking

When a card waits for the owner (handed over, asked, its PR waiting) and its worker has no turn
and no background command running, Obeya runs the adapter's `stack.stop` in its workspace after
a short grace (a quick reply should not pay for a restart). The next message tells the worker
that its stack was stopped; the worker starts it again when it needs it, through the repository's
own way (its status script reports none, then its start script). A workspace whose stack
holds data the owner would not want to lose (a persistent database, a restored prod dump) is not parked unless the owner says so: the adapter's `stack.keep` exits 0
for it, and the owner who wants it stopped anyway tells the worker.

### Hosts

The configuration lists hosts per repository, in order: `local` and SSH hosts (name, SSH
target, workspace root, slots). A new card takes the first host with a free slot and stays there
until it lands, because its workspace and its Claude Code session live there.

On an SSH host:

- The worker's Claude Code process starts through `spawnClaudeCodeProcess` as `ssh <target> --
  <claude> <args>` in the remote workspace. Obeya passes what the process needs in its
  environment at each start: the Claude login as `CLAUDE_CODE_OAUTH_TOKEN` (from `claude
  setup-token`, valid a year) and `GH_TOKEN`. Nothing secret is stored on the host by Obeya;
  tools the repository's agents need beyond that (Codex, Grok, the AWS CLI) are set up on the
  host by hand.
- Obeya's own git steps in a workspace (creating and resetting the clone, leasing, landing,
  pushing) run on the host over SSH.
- Files cross over at fixed points: a demo directory named in a handover is copied to the
  owner's machine, images the owner attaches are copied to the host before they are sent.
- A dropped connection ends the turn like an Obeya restart does; the worker resumes by session
  id once the host is reachable again.
- The Workspaces pill shows the host of each workspace.

### Cloud hosts (optional)

Only if parking and the SSH hosts are not enough: a host type whose slots are cloud instances,
one per card (an EC2 `m8g.xlarge`, say, in the using repository's cloud account). Obeya launches one from a
prepared image when a card needs a slot and the other hosts are full, stops it some minutes after
the card's last turn (only the disk is kept), starts it again on the owner's next message and
terminates it once the work has landed. A cap on concurrent instances in the configuration. The
image, network and IAM are the using repository's infrastructure (a Pulumi stack in it, say). Estimate from the numbers above: about $25 a month with the Mac alone at today's load,
nearly nothing with a second machine, $190–290 a month on-demand at 36 agents.

## Workstreams

- [x] **W1:** Parking. An optional `stack.stop` in the adapter type, run when a card waits (see
  Parking); the worker hears that its stack was stopped. The work repository's adapter names its stop
  script. Done when a card of the work repository that hands over has no running stack a few minutes later
  and gets it back without manual steps when the owner answers.
- [ ] **W2:** Workers on SSH hosts. Hosts in the configuration and the sheet, spawning over SSH,
  git and file crossings over SSH, resuming after a dropped connection (see Hosts). Check first
  that Obeya's tools and hooks work through `spawnClaudeCodeProcess` over SSH. Done when a card of
  the work repository runs on the owner's second MacBook (macOS x86_64) end to end: work, checks, demo,
  handover, landing.
- [ ] **W3:** Slots and placement. Hosts capped by busy workers instead of clones, a new card on
  the first host with a free slot, the host per workspace in the Workspaces pill. Done when the
  fourth busy card goes to the second MacBook by itself while the Mac's three slots are busy.
- [ ] **W4:** Cloud hosts, optional. Instances that start per card (see Cloud hosts), with the
  work repository's infrastructure stack and worker image. Only if W1–W3 leave the owner short of slots.

## Open questions

- The network between the machines: plain SSH on the home network is enough for the second
  MacBook; Tailscale would also reach cloud instances and the MacBook away from home.
- How many slots the second MacBook gets (the owner remembers 96 GB; checked when it is first
  connected).
