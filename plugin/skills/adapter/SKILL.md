---
name: adapter
description: Write a repository's Obeya adapter (`.obeya/adapter/index.ts`) — how its app starts, which checks run, how work lands, how a demo is recorded — from what the repository shows, prove the demo recipe by recording a demo with it, and ask the owner what the repository does not tell. Use when a task asks to set up Obeya for a repository, to write or fix its adapter, or names this skill.
---

# Writing a repository's adapter

Obeya learns how a project works from its adapter, `.obeya/adapter/index.ts` in the repository.
The reference for every field, how Obeya picks the adapter and when a change takes effect is
`${CLAUDE_SKILL_DIR}/../../../docs/adapter.md`. Read it first; this skill is the way to fill it in.

The result is an adapter whose every field holds for this repository: a worker who knows nothing
of the project gets its brief from it, installs, checks, starts the app and records a demo without
asking anyone.

## 1. Read the repository

Find out, from the files rather than by guessing:

- **Setup and checks**: the package manager and its lock file (`package.json` scripts, `Makefile`,
  `justfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile` …). The CI configuration
  (`.github/workflows/`, `.gitlab-ci.yml`, …) says which checks a change must pass and in which
  order; take those that run on one machine in minutes, without services the workspace lacks.
- **The app and its stack**: README, CONTRIBUTING, CLAUDE.md or AGENTS.md, `docker-compose.yml` /
  `compose.yaml`, `.env.example`, `Procfile`, dev scripts. What starts in which order, which ports
  it takes (fixed ones mean one stack per clone: `workspaces: 'clones'`), migrations, seed data,
  where the frontend's URL comes from.
- **Logging in and test data**: seed scripts, fixtures, test users in the docs or the seed.
- **Landing**: the `origin` remote (GitHub: `land: 'pr'`; no remote: `land: 'main'`), whether the
  default branch is protected, which bots comment on pull requests (`prNoise`).
- **Plan docs**: a directory of plans or design docs, if the project keeps one.

## 2. Ask what the repository does not tell

Some things only the owner knows: the login for a demo when no seed makes one, which test data
shows the app well, whether every handover needs a demo, whether approved work may go straight
onto the default branch, a share command for colleagues. Collect them and ask in one question
(the `ask` tool under Obeya), with the options you found, while you go on with the rest. A secret
(a real password, an API key) goes into `howToRun` only as where to find it (a file outside git,
an environment variable), never itself.

## 3. Write `.obeya/adapter/index.ts`

Start from the example in the reference and keep only the fields that differ from the generic
adapter's values. The module imports nothing of Obeya's; its default export is the adapter, or
`(kit) => adapter` when it needs Obeya's helpers. Files it needs beside it (a share script) go
into `.obeya/adapter/` too.

`demo.howToRun` is the part that decides whether workers can show their work. Write it for a
newcomer, as a few sentences: what to start, in which order and how (in the background, which
ports), migrations and seed data, the login and the URL to open, how to reach a state worth
showing, and what to stop afterwards (by PID, not by name: other workers run their own stacks on
the same machine).

Then check it:

```bash
bun ${CLAUDE_SKILL_DIR}/lib/check.ts
```

run in the repository. It loads the adapter from the checkout the way Obeya will, prints what
Obeya makes of it and every problem (an unknown field, a wrong type, a share program that is not
there), and exits with 1 while there is one. Go on once it says "No problems."

## 4. Prove it

- Run `setup` and every command of `checks` in this workspace, as a worker will.
- Follow `stack` and `howToRun` word for word, as if you had never seen the project: start the
  app, open it, log in. Where the recipe falls short (a step missing, a port taken, data that is
  not there), fix the recipe, not just the running app, and run it again from the start.
- Record a short demo with the demo skill (`obeya:demo`), the app run by the recipe and nothing
  else: the app starting up, the login, a page with data. That demo is the proof and your
  handover's demo.

## 5. Hand over

Commit `.obeya/adapter/` alone. In the summary say what the adapter sets and why where it was a
judgement call (the checks you left out, clones or worktrees), what the owner answered, and that
it counts once it is on the default branch and Obeya was started again.
