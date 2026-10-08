# Recording demos: what a machine needs

Every change an Obeya worker hands over comes with a narrated video, recorded by the demo skill
(`plugin/skills/demo/`, `obeya:demo` in a worker). The skill records on macOS, Linux and Windows.
This guide lists what it needs on the machine and how to install each piece.

## Check first

- In Obeya: "Konfiguration", then "Was Demos auf diesem Rechner brauchen" below the demo settings.
  Each missing piece shows with the commands that install it on this platform.
- In a terminal, in the Obeya checkout: `node plugin/skills/demo/lib/setup.ts`. It prints the same
  list and exits with 1 while something is missing.
- A render runs the same check before it starts and stops with the list, so a missing tool shows
  up at once, not minutes into a render.

Obeya and its workers see a newly installed program only once Obeya was started from a terminal
opened after the installation (on Windows, `winget` changes the PATH only for new terminals).

## What is needed

| Piece | What for | macOS | Linux | Windows |
|---|---|---|---|---|
| Node.js 22.18 or newer | runs the demo script and the director (TypeScript without a build) | `brew install node` | [nodejs.org](https://nodejs.org/en/download); distribution packages are often older | `winget install OpenJS.NodeJS` |
| Playwright | drives the browser | `bun install` in the Obeya checkout | same | same |
| A Chromium browser | the recording | Chrome: `brew install --cask google-chrome` | Chrome on x64 ([google.com/chrome](https://www.google.com/chrome/)); on ARM, where there is no Chrome: `npx playwright-core install --with-deps chromium` in the Obeya checkout | Edge comes with Windows; Chrome (`winget install Google.Chrome`) is used when present |
| ffmpeg with libx264 | cutting the video, converting the narration | `brew install ffmpeg` | Debian, Ubuntu: `sudo apt install ffmpeg`; Fedora: the `ffmpeg` of [RPM Fusion](https://rpmfusion.org/Configuration) (Fedora's own `ffmpeg-free` has no libx264); Arch: `sudo pacman -S ffmpeg` | `winget install Gyan.FFmpeg` |
| uv | runs the Python parts (narration, Whisper) in environments of their own; it fetches Python itself | `brew install uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | `winget install --id=astral-sh.uv -e` |
| A voice | speaking the narration | see below | see below | see below |
| Whisper | listening back to every clip | fetched by the first render | same | same |

The browser is looked for in this order: `DEMO_CHROME` (the path of any Chromium-based browser),
Chrome, Edge, Playwright's own Chromium.

## Voices

The voice is chosen in Obeya's settings ("Demos"); "Anhören" plays a sentence in it first.

- **Piper**, the default: runs on any CPU at about twice real time. Obeya installs it on request
  (about 265 MB, into `voices/` in Obeya's home); without Obeya, `node
  plugin/skills/demo/lib/voices.ts install`.
- **Qwen3-TTS**: more natural, and it can clone a voice from a clip. It needs a lot of memory: on a
  Mac with Apple Silicon through MLX (about 5 GB), elsewhere through PyTorch, in practice only
  with a GPU (about 8 GB). Obeya installs it on request too.
- **macOS `say`**: on a Mac only, nothing to install, clearly more synthetic.
- **A hosted service**: Gemini, OpenAI, ElevenLabs or Azure, with the API key in its environment
  variable (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `AZURE_SPEECH_KEY`) or in a
  key file named in the settings. ElevenLabs uses `eleven_multilingual_v2`;
  `DEMO_ELEVENLABS_MODEL` names another (`eleven_v4` reads audio tags such as `[short pause]`).
- **Your own**: a command (the text on stdin, the WAV written to `$DEMO_WAV`) or an HTTP endpoint
  (POST `{"text", "language"}` as JSON, audio back). Tick "Das ist meine eigene Stimme" when it
  speaks in your voice; the narration is then in the first person.

## Whisper

Each narration clip is transcribed back and synthesised again when the voice dropped or invented
a word. The first render fetches Whisper through uv: mlx-whisper on Apple Silicon,
faster-whisper elsewhere (on the GPU with CUDA, else on the CPU), with its model, about 1.6 GB in
all. On a machine where that is too slow or too large, turn off "Erzählung mit Whisper
gegenhören"; the clips then go unchecked, and the demo's page says so.

## Without Obeya

The skill also runs in a plain Claude Code session: link it as a user skill
(`~/.claude/skills/demo` pointing to `plugin/skills/demo` in an Obeya checkout, after `bun install`
there). Its settings are `demo.json` in `~/.obeya` (or `OBEYA_HOME`); `node
plugin/skills/demo/lib/settings.ts` prints what applies.

## Not tried yet

Recording was checked on macOS (Apple Silicon), Ubuntu x64, Linux on ARM (in Docker) and Windows
Server 2025 (2026-10-05). Not tried: Edge as the fallback browser, a voice command through
`cmd.exe`, Qwen3-TTS through PyTorch (no machine with a GPU), and Obeya itself on Windows.
