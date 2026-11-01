# Recording demos: what a machine needs

A change an Obeya worker hands over comes with a
narrated video, recorded by the demo skill (`plugin/skills/demo/`, `obeya:demo` in a worker). The
skill records on macOS, Linux and Windows. This guide lists what it needs on the machine and how
to install each piece.

## Check first

- In Obeya: "Konfiguration", section "Demos", then "Was Demos auf diesem Rechner brauchen" beside the demo settings.
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
| uv | runs the Python parts (narration) in environments of their own; it fetches Python itself; not needed for silent demos | `brew install uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | `winget install --id=astral-sh.uv -e` |
| A voice | speaking the narration; not needed for silent demos | see below | see below | see below |
| poppler (`pdftoppm`) | only for demos that show a PDF (`d.pdfFrom`) | `brew install poppler` | `sudo apt install poppler-utils` | `winget install oschwartz10612.Poppler` |

The browser is looked for in this order: `DEMO_CHROME` (the path of any Chromium-based browser),
Chrome, Edge, Playwright's own Chromium.

## Voices

The voice is chosen in Obeya's settings ("Demos"); "Anhören" plays a sentence in it first.

- **None (subtitles only)**: silent videos whose subtitles tell the narration, on from the start;
  each scene lasts as long as its text takes to read. Nothing to install. `DEMO_VOICE=none` renders
  one demo that way.
- **Piper**, the default: runs on any CPU at about twice real time. Obeya installs it on request
  (about 265 MB, into `voices/` in Obeya's home); without Obeya, `node
  plugin/skills/demo/lib/voices.ts install`.
- **Qwen3-TTS**: more natural, and it can clone a voice from a clip. It is a large download: on a
  Mac with Apple Silicon through MLX (about 5 GB), elsewhere through PyTorch, in practice only
  with a GPU (about 8 GB); while it speaks it holds several GB of memory. Obeya installs it on request too.
- **macOS `say`**: on a Mac only, nothing to install, clearly more synthetic.
- **A hosted service**: Gemini, OpenAI, ElevenLabs or Azure, with the API key in its environment
  variable (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `AZURE_SPEECH_KEY`) or in a
  key file named in the settings. ElevenLabs uses `eleven_v4`, which reads audio tags such as `[short pause]`;
  `DEMO_ELEVENLABS_MODEL` names another (`eleven_v3` reads them too, `eleven_multilingual_v2` does not).
- **Your own**: a command (the text on stdin, the WAV written to `$DEMO_WAV`) or an HTTP endpoint
  (POST `{"text", "language"}` as JSON, audio back). Tick "Das ist meine eigene Stimme" when it
  speaks in your voice; the narration is then in the first person.

Piper and `say` read every word by the rules of the narration language, so in German narration
English terms are respelt for them: from `plugin/skills/demo/lib/lexicon.de.json` (term → spoken
form, e.g. `"Branch": "Bräntsch"`), and from a mark in a demo's script, `{Canvas|Kännwes}`. The
captions show the written form; the other voices get it too. To add a term, write its spoken form
into the lexicon and listen to a clip of it in Piper first.

## Subtitles

"Untertitelsprachen" in the same settings lists the languages of the subtitles (`de, fr, pt-BR`, any
BCP 47 code). Exactly these become tracks the viewer switches in the player, the narration's
language only when it is in the list. Left empty, a demo has no subtitles; only a silent one (voice
"None") then shows its narration as subtitles. The voice speaks either way, so a voiced demo with
listed languages has both. The agent that renders a demo translates its narration into them, so they
need nothing installed.

## Without Obeya

The skill also runs in a plain Claude Code session: link it as a user skill
(`~/.claude/skills/demo` pointing to `plugin/skills/demo` in an Obeya checkout, after `bun install`
there). Its settings are `demo.json` in `~/.obeya` (or `OBEYA_HOME`), the directory demos go into
among them (`directory`, else `~/demos`); `node plugin/skills/demo/lib/settings.ts` prints what
applies.

## Not tried yet

Recording was checked on macOS (Apple Silicon), Ubuntu x64, Linux on ARM (in Docker) and Windows
Server 2025 (2026-10-05). Not tried: Edge as the fallback browser, a voice command through
`cmd.exe`, Qwen3-TTS through PyTorch (no machine with a GPU), and Obeya itself on Windows.
