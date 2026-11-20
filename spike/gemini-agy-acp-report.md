# Spike: an Obeya worker on Gemini through `agy acp`

Measured on 2026-11-20 with Antigravity CLI 1.5.13 (`agy`) on macOS, Google AI subscription login.
Throwaway code: `src/server/gemini.ts` (the runtime), `scripts/spike-agy-acp.ts` (the protocol probe).

## Result

A worker on Gemini 4 Neon (effort high) in a scratch Obeya took a small card (add a `--shout`
flag, document it) to a commit and a handover through Obeya's `ready_for_review`. It took
78 seconds from the task to the handover. Obeya refused the first handover because it had no demo;
the agent then wrote an HTML artifact and handed over again. The turn reported 232,309 tokens:
42,174 input, 184,361 cached, 5,774 output, 3,169 of those for thinking.

What the runtime does: one `agy acp` process per session, JSON-RPC over stdio. `initialize`, then
`session/new` (or `session/resume`), with Obeya's instructions in
`_meta.antigravity.systemPrompt.append` and Obeya's tools as an HTTP MCP server
(`{type: "http", url: "http://127.0.0.1:<port>/mcp/<session token>"}`). Then the model with
`session/set_config_option` (`model: gemini-4-neon`, `thought_level: high`), `session/set_mode auto`,
and one `session/prompt` per turn. The menus offer Neon, Argon, Hydrogen and Flash. Claude and
GPT-OSS through agy are left out.

## The five risks

### 1. Does Obeya see a command before it runs?

Yes, through a `PreToolUse` hook. The ACP permission request is no substitute.

- **Mode `default`:** agy sends `session/request_permission` before every command and every file
  write, with the full command line. But a refusal (`reject_once`) **ends the turn at once and
  silently**. The tool shows as failed with empty output, and the agent neither reads a reason nor
  tries anything else (measured: refused a ten-minute `sleep`, the turn ended after 4.4 seconds
  with no text). That doesn't work for refusing long waits.
- **Mode `auto`:** agy runs commands in its terminal sandbox without asking. It asks
  (`request_permission`) only before a command leaves the sandbox (`BypassSandbox: true`), before
  a file write outside the workspace, and before each call of an MCP tool, Obeya's own included.
  The ACP `tool_call` notification comes before the command runs, but it is information only.
- **`PreToolUse` hook** (`hooks.json`): it runs before every tool call, the command in
  `toolCall.args.CommandLine`, and answers `{"decision": "deny", "reason": "…"}`. The agent reads
  the reason and **its turn goes on** (measured: it quoted Obeya's reason). The hook gets agy's
  environment, so an `OBEYA_*` variable Obeya sets on `agy acp` reaches it (measured). Obeya can
  therefore install one hook that acts only in Obeya's sessions and calls back to Obeya on the
  loopback with the session token, as Codex's hooks do today. `PostToolUse` provides the after
  for the folder watch. Hooks load from `.agents/hooks.json` in the workspace (measured) or
  globally from `~/.gemini/config/`. There is no ACP parameter for them per session.
- **Sandbox side effect:** in `auto`, the sandbox could not read a file that `~/.gitconfig`
  includes from outside the workspace (`fatal: unable to access '…/.gitconfig-…': Operation not
  permitted`). The agent got around it on its own with `GIT_CONFIG_GLOBAL=/dev/null`, so its
  commits ignore the user's global git configuration (identity, signing, hooks). For production:
  open up the sandbox for the git configuration and the git common dir (settings allowlist), or
  run commands outside the sandbox and let Obeya's hook decide.

### 2. Usage limits

- `agy -p /quota --output-format json` answers in under a second without starting a turn. For
  each group ("Gemini Models", "Claude and GPT models", Argon on its own), it reports a weekly
  window and a five-hour window with `remaining_fraction` and `reset_time` (ISO). That is enough
  for the usage bar and for the reset time of a limit.
- An exhausted quota could not be reproduced (the weekly window was at 95 %). According to the
  changelog, weekly-quota, spend-cap and prepaid-balance errors end the turn at once, and since
  1.5.x ACP reports the specific error ("a model or quota error") in place of a generic one.
  Agy's own swarm code recognises such errors by
  `/RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i`. The spike runtime
  treats such an error as a limit. The reset time would come from `/quota` (the window at 0).
  **Unverified** until a limit is actually reached.

### 3. Tools after a resume

Yes. A new `agy acp` process with `session/resume` and a new MCP server (another port) had the
conversation (the agent knew the earlier question) and called the MCP tool again (measured).
`resume` takes 0.8 seconds and replays no history. The mode drops back to `default` after a
resume. Obeya sets it again at every start anyway.

### 4. Instructions and skills

- agy reads **`AGENTS.md`** and `GEMINI.md`, **not `CLAUDE.md`** (measured: with both files in the
  repository, it named only `AGENTS.md`). In the spike, the worker read CLAUDE.md only because
  Obeya's instructions tell it to. For production: add CLAUDE.md to the system prompt where there
  is no AGENTS.md (as `project_doc_fallback_filenames` does for Codex), or point to it there.
- Appending to the system prompt works (`_meta.antigravity.systemPrompt.append`, measured).
- Skills: agy loads `SKILL.md` skills from `.agents/skills/`, globally from `~/.gemini/config/`,
  and from plugins. `agy plugin install`/`import` take Claude Code plugins and their `skills` too.
  So Obeya's plugin could be installed once (as on Codex: `skills/extraRoots`). **Not tried** in the spike.

### 5. Tokens per turn

Yes. The answer to `session/prompt` carries `usage` (`inputTokens`, `outputTokens`,
`cachedReadTokens`, `cachedWriteTokens`, `thoughtTokens`, `totalTokens`), and `usage_update`
reports the context window used (of 1,048,576). There is no price: Obeya would price the tokens
itself, as `codexCost` does.

## Also seen

- A message while a turn is running: the changelog says another `session/prompt` steers the
  running turn. The spike queues it for the next turn. Not tried.
- agy names Obeya's tools `mcp_obeya_<tool>`. File tools: `read_file`, `write_file`,
  `edit_file`, `run_command`. The runtime shows them under Claude Code's names (Read, Write, Edit,
  Bash).
- Neon follows repository rules very literally: a test AGENTS.md rule ("always mention MANGO")
  ended up in every answer and even in its reasoning about a file name.
- 1.5.9 to 1.5.13 in a few weeks: many of the changelog entries concern `agy acp`. The protocol is
  still moving.
