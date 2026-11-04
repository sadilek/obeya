---
name: settings
description: Write a repository's Obeya settings (`.obeya/settings.json`) — how its app runs and stops, which checks run, how work lands, where demos are shared, where its plan docs are — from what the repository shows, prove the recipe for running the app by recording a demo with it, and ask the owner what the repository does not tell. Use when a task asks to set up Obeya for a repository, to write or fix its settings, or names this skill.
---

# Writing a repository's settings

Obeya learns how a project works from the repository's settings for everyone, in
`.obeya/settings.json`: setup, checks, landing, plan docs, how to run the app, the demo site. The
owner sees and changes them in "Configuration". The reference for every field and when a change
takes effect is `${CLAUDE_SKILL_DIR}/../../../docs/settings.md`. Read it first; this
skill is the way to fill it in.

The result is a settings file whose every field holds for this repository: a worker who knows
nothing of the project gets its brief from it, installs, checks, starts the app and records a demo
without asking anyone.

## 1. Read the repository

Find out, from the files rather than by guessing:

- **Setup and checks**: the package manager and its lock file (`package.json` scripts, `Makefile`,
  `justfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile` …). The CI configuration
  (`.github/workflows/`, `.gitlab-ci.yml`, …) says which checks a change must pass and in which
  order; take those that run on one machine in minutes, without services the workspace lacks.
- **The app**: README, CONTRIBUTING, CLAUDE.md or AGENTS.md, `docker-compose.yml` /
  `compose.yaml`, `.env.example`, `Procfile`, dev scripts. What kind of app it is (a web app, a CLI,
  a desktop or mobile app), what starts in which order, which ports it takes (fixed ones mean one
  app per clone: `"workspaces": "clones"`), what to do after which kind of change (restart a
  service, reload the page, rebuild; nothing where it reloads by itself), where it gives its
  address (a file it writes, the console), migrations, seed data, and how to stop the app of one
  workspace (`app.stop`; `app.keep` where some hold data that must stay).
- **An adapter module from before**: a `.obeya/adapter/index.ts` held what the settings hold now
  (how the app runs, the demo site). Obeya does not read it: take its values over, then delete
  `.obeya/adapter/`. What it held that is set on each machine in "Configuration" goes into your
  summary for the owner: the canvas's name.
- **Logging in and test data**: seed scripts, fixtures, test users in the docs or the seed.
- **Landing**: the `origin` remote (Obeya detects `land`: `pr` on GitHub, else `main`; write it
  only to differ), whether the default branch is protected, which bots comment on pull requests
  (`prNoise`).
- **Plan docs**: where the project keeps its plans, if it does: `docs/plan/`, other directories
  under `docs/`, `rfcs/`, `adr/`, `PLAN*.md`, a `TODO.md`. What makes a doc in `planDocs.dir` a
  project is under `planDocs` in the reference; a doc without the checklist shows on the canvas
  with "Prepare as a project", which has an agent add it in the doc's own style. Design notes and
  ADRs that plan nothing belong elsewhere, or in `planDocs.exclude`. Plans that git ignores are not
  on the default branch Obeya reads: their folder's absolute path goes into the owner's
  configuration on their machine ("Plan docs"), not into the file.
- **Language**: the language the repository's code, docs and commit messages are written in
  (`language`), and the one its demos are to be narrated in (`demo.language`).

## 2. Ask what the repository does not tell

Some things only the owner knows: the login for a demo when no seed makes one, which test data
shows the app well, whether approved work may go straight
onto the default branch, where demos are shared with colleagues (a static site: `demo.site`), and
where plan docs go: the directory of plans you found (its docs then converted with "Prepare as a
project" on the canvas), or a new `docs/plan/`. Collect them and ask in one question
(the `ask` tool under Obeya), with the options you found, while you go on with the rest. A secret
(a real password, an API key) goes into `app.run` only as where to find it (a file outside git,
an environment variable), never itself.

## 3. Write `.obeya/settings.json`

Start from the example in the reference and keep only the fields that differ from Obeya's
defaults: `setup`, `checks`, `land`, `direct`, `autoMerge`, `planDocs`, `softPaths`, `workspaces`,
`prNoise`, `language`, `app` with `run`, `stop` and `keep`, and `demo` with `language` and `site`.

`app.run` is the part that decides whether workers can run and show their work. Write it for a
newcomer, as a few sentences: what to start, in which order and how (in the background, which
ports), what to do after which kind of change, where the app gives its address, migrations and
seed data, the login, how to reach a state worth showing, and what to stop afterwards (by PID,
not by name: other workers run their own apps on the same machine).

Then check it:

```bash
bun ${CLAUDE_SKILL_DIR}/lib/check.ts
```

run in the repository. It reads the file from the checkout the way Obeya will, prints what Obeya
makes of it (also which docs in the plan directory are projects and which are not, and why) and
every problem (an unknown field, a wrong type, a site's deploy program that is not there, an
adapter module still there), and exits with 1 while there is one. Go on once it says "No
problems."

## 4. Prove it

- Run `setup` and every command of `checks` in this workspace, as a worker will.
- Follow `app.run` word for word, as if you had never seen the project: start the
  app, open it, log in. Where the recipe falls short (a step missing, a port taken, data that is
  not there), fix the recipe, not just the running app, and run it again from the start.
- Record a short demo with the demo skill (`obeya:demo`), the app run by the recipe and nothing
  else: the app starting up, the login, a page with data. That demo is the proof and your
  handover's demo.

## 5. Hand over

Commit `.obeya/` alone. In the summary say what the settings set and why where it was a judgement
call (the checks you left out, clones or worktrees), what the owner answered, and that they count
once they are on the default branch (at once; where they move the workers between clones and
worktrees, Obeya restarts the repository's agents by itself), its commands (`app.stop`,
`app.keep`, the demo site) once the owner trusts them in "Configuration".
