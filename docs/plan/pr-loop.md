# M5 PR loop

> Plan doc for the PR loop. Deleted when it ships; durable content moves into
> [`docs/design.md`](../design.md).

## Goal

For repositories whose work lands through pull requests (Acme), approval opens the PR and Obeya
carries it to the merge: review comments, CI and conflicts go to the card's worker; only what
needs judgement comes back to the owner.

## Design

- **Opening.** Approval of a card whose adapter lands by `pr` puts it `in PR` and tells its worker
  to push the branch and open the pull request the way the repository does it (its own skills and
  conventions: a self-contained description, no plan-doc labels), then to report it with the tool
  `pr_opened(url)`.
- **Watching.** Obeya polls every open PR through `gh` (state, mergeability, checks, review
  comments). New review comments and failed checks go to the worker as a message, a conflict asks
  it to bring the branch up to date with the base. The worker handles all of it the way the
  repository does (Acme: its `address-reviews` skill, which merges `main` instead of rebasing,
  replies on and resolves threads, and asks Greptile for a re-review after each push, since
  Greptile reviews a PR only once by itself). From the PR phase on the worker may push its branch,
  never merges the PR, and ends its turn when done instead of handing over again.
- **Judgement.** A comment that questions a decision, or a conflict with product meaning, is the
  worker's to recognise: it uses `ask`, the card waits for the owner, and returns to `in PR` with
  the answer.
- **Merge.** A merged PR makes the card `live`; its session ends and the clone is free. A PR
  closed without merge becomes a question to the owner.
- **Seams.** `gh` sits behind a small forge interface; the loop is tested against a fake. The live
  run on Acme needs the owner's go: it creates real pull requests.

## Workstreams

- [x] **W1:** PR phase: approval hands the worker the PR, `pr_opened`, `in PR` with its link.
- [x] **W2:** Watching: comments, checks, conflicts to the worker; merge and close.
- [x] **W3:** Card UI: PR link, checks, what the worker does about them.
- [ ] **W4:** Live on Acme, with the owner's go. The go: the owner has put Acme on its own canvas
  (`~/.obeya/canvases.json`, clones `app2`–`app5`). Checked against real Acme pull requests
  (2026-10-01): `gh` reads their state, checks and comments; Greptile's inline comments come from
  `greptile-apps[bot]`, now named `greptile-apps` like its summary; Cloudflare's deploy comment is
  noise. What is left is the run itself: the first approved Acme card's PR, through Obeya to the
  merge.

## Open questions

- Demos in PRs: the plan says object storage behind the team's login. Which storage?
