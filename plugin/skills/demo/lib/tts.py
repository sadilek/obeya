"""Narration clips for a demo, in the voice of the demo settings.

The voice comes as a spec from `voices.ts`, one of two kinds:

- `command`: run once per clip, the text on stdin. Either `argv`, run directly with `{out}`
  replaced by the WAV to write (Piper, macOS `say`), or `shell`, the owner's own command, which
  writes the WAV to `$DEMO_WAV` (or prints the path of the one it wrote as its last line).
  `$DEMO_LANGUAGE` says the narration language. A voice that loads a large model and can stay
  loaded (the Qwen3-TTS helper `qwen3.py`) has `serve` as well: that command starts once, on the
  first clip to synthesise, and answers clip by clip over its stdin and stdout,
  one JSON line each way (the protocol is in `qwen3.py`). If it dies, the render stops with its
  stderr; one that says nothing for minutes (`ANSWER_LIMITS`) is stuck, and is ended the same way. Such a voice with `host` as well is held by Obeya across renders when `OBEYA_URL` says
  where Obeya runs: each clip goes to `POST $OBEYA_URL/api/narration/clip` and waits its turn
  behind other renders' clips (`src/server/narration.ts`). An Obeya that cannot be reached, or
  does not hold voices, leaves the voice to this process, as without Obeya.
- `http`: a request from a template, for Gemini, OpenAI, ElevenLabs, Azure, or the owner's own
  endpoint (`http`: POST `{"text", "language"}` as JSON, audio back). The key comes from the
  service's environment variable, else from the key file in the spec.

Whatever comes back is made a mono 16-bit WAV with ffmpeg:

    uv run --no-project python tts.py [--lock <file>] <spec.json> <language> <jobs.json> <out_dir>

`jobs.json` is `[{"id": ..., "text": ...}]`. Each text becomes `<out_dir>/<hash>.wav`, cached by
voice + the text as spoken, so re-rendering a demo after a visual fix costs no synthesis.

A voice whose spec has `respell` (Piper, `say`) reads every word by the rules of the narration
language, so English terms in German narration get respelt first: from the language's lexicon
beside this file (`lexicon.<language>.json`, term to spoken form), and from marks in the script,
`{Canvas|Kännwes}`, which win over the lexicon. Other voices get the written form ("Canvas"),
respelt only where the voice has a lexicon of its own for the narration language (`lexicon` in the
spec: `lexicon.qwen3.en.json` for the words Qwen3 cannot read in English narration). The cache key
is the spoken text, so a change to a lexicon re-synthesises only the clips it touches.

Qwen3 hears each sentence back and makes one it stumbled over again (`qwen3.py`); it is asked with
the script as written beside the text as respelt, and says what it heard, sentence by sentence,
which is kept beside the clip (`<hash>.heard.json`) for the next render that finds it cached.
Results land in `<out_dir>/tts.json`: `{"clips": [{"id", "file", "seconds"}]}`, a clip of a
voice that hears with `"heard": [{"script", "heard", "stumbled"?, "misheard"?}]` or `"unheard":
"why"` as well.

`--lock <file>` takes that file's lock before this process loads a large model and holds it to
the end, for voices that load one: one such render at a time on the machine, the others wait. A
voice Obeya holds takes no lock: parallel renders synthesise turn by turn through Obeya, with one
voice model in memory.

    python tts.py [--lock <file>] --sample <spec.json> <language> <text> <out.wav>

synthesises one clip, for hearing a voice in the settings.
"""

from __future__ import annotations

import hashlib
import base64
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import wave
from collections import deque
from pathlib import Path
from xml.sax.saxutils import escape

LANGUAGE_NAMES = {"de": "German", "en": "English"}
LOCALES = {"de": "de-DE", "en": "en-US"}

#: How the hosted voices should sound: a product lead walking a colleague through a finished feature.
STYLE = (
    "Calm, matter-of-fact, confident; a product lead walking a colleague through a finished "
    "feature. Native {language}, natural pace, slightly brisk."
)
#: Free-tier quotas are per model (10 requests a day), so another TTS model can stand in.
GEMINI_MODEL = os.environ.get("DEMO_GEMINI_MODEL", "gemini-3.8-flash-tts")
#: Director's notes the model reads but does not speak; only the transcript is spoken. A plain
#: prefix ("Sprich ruhig: …") gets read aloud.
GEMINI_NOTES = "### DIRECTOR'S NOTES\nStyle: {style}\n\n#### TRANSCRIPT\n"
OPENAI_MODEL = os.environ.get("DEMO_OPENAI_MODEL", "gpt-4o-mini-tts")
ELEVENLABS_MODEL = os.environ.get("DEMO_ELEVENLABS_MODEL", "eleven_v4")
#: Each service's voice when the settings name none: calm male voices, like Gemini's Charon.
DEFAULT_VOICES = {
    "gemini": {"de": "Charon", "en": "Charon"},
    "openai": {"de": "onyx", "en": "onyx"},
    "elevenlabs": {"de": "JBFqnCBsd6RMkjVDRZzb", "en": "JBFqnCBsd6RMkjVDRZzb"},
    "azure": {"de": "de-DE-ConradNeural", "en": "en-US-AndrewNeural"},
}


def write_pcm(path: Path, pcm: bytes, rate: int) -> None:
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(rate)
        fh.writeframes(pcm)


def to_wav(source: Path, target: Path) -> None:
    """Any audio ffmpeg reads, as the mono 16-bit WAV the rest of the pipeline expects."""
    done = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-ac", "1", "-c:a", "pcm_s16le", str(target)],
        capture_output=True, text=True,
    )
    if done.returncode != 0:
        sys.exit(f"cannot read the voice's audio {source}: {done.stderr.strip()[-600:]}")


#: An audio tag in the script ("[short pause]"): read by ElevenLabs v3 and v4, not said.
AUDIO_TAG = re.compile(r"\[[^\]]*\]")
#: Models that read audio tags; other voices get the script without them.
TAG_MODELS = ("eleven_v3", "eleven_v4")


#: A pause tag and the silence a voice that does not read tags puts in its place, in seconds.
PAUSE_TAG = re.compile(r"\[(short pause|long pause|pause)\]")
PAUSES = {"short pause": 0.5, "pause": 0.8, "long pause": 1.5}


#: A term the script spells out for the voice: `{Canvas|Kännwes}`, written "Canvas", spoken "Kännwes".
MARK = re.compile(r"\{([^{}|]*)\|([^{}]*)\}")


def written(text: str) -> str:
    """The script as it reads, its marks as their written form."""
    return MARK.sub(lambda m: m[1], text)


def key(term: str) -> str:
    """A term as the lexicon looks it up: lower case, its words apart by one space."""
    return " ".join(re.split(r"[\s-]+", term.lower().strip()))


def lexicon(name: str) -> dict[str, str]:
    """The lexicon of a narration language (`de`) or of a voice in it (`qwen3.de`), keyed by the term in
    lower case; empty without one."""
    file = Path(__file__).with_name(f"lexicon.{name}.json")
    if not file.exists():
        return {}
    return {key(term): spoken for term, spoken in json.loads(file.read_text(encoding="utf-8")).items()}


def respelt(text: str, words: dict[str, str]) -> str:
    """The script as a voice that reads by the narration language's rules should get it: each mark
    as its spoken form, and each term of the lexicon, as a whole word in any case, as its spoken
    form; the longest term first, so "Pull Request" goes before "Request"."""
    if not words:
        return MARK.sub(lambda m: m[2], text)
    terms = sorted(words, key=len, reverse=True)
    # the words of a term may be apart by any space or a hyphen ("Pull-Request")
    pattern = re.compile(r"(?<!\w)(?:" + "|".join(r"[\s-]+".join(map(re.escape, t.split())) for t in terms) + r")(?!\w)", re.IGNORECASE)
    # a match the regex's case folding finds but `key`'s does not ("İssue") stays as written
    say = lambda part: pattern.sub(lambda m: words.get(key(m[0]), m[0]), part)
    out, at = [], 0
    for mark in MARK.finditer(text):
        out += [say(text[at:mark.start()]), mark[2]]
        at = mark.end()
    return "".join(out + [say(text[at:])])


def spoken(spec: dict, language: str, text: str) -> str:
    """What the voice of `spec` is given to say for `text`."""
    if spec.get("respell"):
        return respelt(text, lexicon(language))
    return respelt(written(text), lexicon(f"{spec['lexicon']}.{language}")) if spec.get("lexicon") else written(text)


def untagged(text: str) -> str:
    """The script without its audio tags, for a voice that would say them."""
    return re.sub(r"\s{2,}", " ", AUDIO_TAG.sub(" ", text)).strip()


class QuotaExhausted(Exception):
    """The voice cannot synthesise anything more today."""


class CommandVoice:
    """A program run once per clip: Piper, `say`, or the owner's own command."""

    def __init__(self, spec: dict, language: str) -> None:
        self._argv = spec.get("argv")
        self._shell = spec.get("shell")
        if not self._argv and not self._shell:
            sys.exit("no voice command: set the command in the demo settings")
        self._language = language
        self.tag = spec["tag"]

    def synthesize(self, text: str, target: Path, script: str | None = None) -> dict | None:
        raw = target.with_name(f"{target.stem}.raw.wav")
        raw.unlink(missing_ok=True)
        # The text goes in as UTF-8. A Python voice (Piper) would read stdin in the Windows code
        # page otherwise and speak "öffnet" as "Ã¶ffnet".
        env = {**os.environ, "DEMO_WAV": str(raw), "DEMO_LANGUAGE": self._language, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        command = [a.replace("{out}", str(raw)) for a in self._argv] if self._argv else self._shell
        done = subprocess.run(command, input=text, shell=not self._argv, env=env, capture_output=True,
                              text=True, encoding="utf-8")
        if done.returncode != 0:
            sys.exit(f"the voice command failed ({done.returncode}): {(done.stderr or done.stdout).strip()[-1500:]}")
        produced = raw
        if not raw.exists():
            lines = done.stdout.strip().splitlines()
            produced = Path(lines[-1].strip()) if lines else raw
            if not produced.exists():
                sys.exit(f"the voice command wrote no WAV: neither $DEMO_WAV ({raw}) nor a path on its last line")
        to_wav(produced, target)
        raw.unlink(missing_ok=True)
        return None


def hearing(reply: dict) -> dict | None:
    """What a voice that hears its clips back said of one, or None from one that does not."""
    return {k: reply[k] for k in ("heard", "unheard") if k in reply} or None


#: How long a voice that stays loaded may say nothing, in seconds: while it loads its model (a cold
#: load took 17 s), and per sentence of a clip (a few seconds on a GPU, a minute or two on a slow
#: CPU). Beyond that it is stuck, as `src/server/narration.ts` has it for the voice Obeya holds.
ANSWER_LIMITS = {"load": 600.0, "sentence": 300.0}


class ServedVoice:
    """A voice that stays loaded for the whole render: started on the first clip, asked per clip."""

    def __init__(self, spec: dict, language: str) -> None:
        self._argv = spec["serve"]
        self._language = language
        self.tag = spec["tag"]
        self._process: subprocess.Popen | None = None
        self._stderr: deque[str] = deque(maxlen=40)
        self._drain: threading.Thread | None = None
        # its stdout, line by line, read by a thread of its own so a wait for it can end
        self._lines: queue.Queue[str] = queue.Queue()

    def _start(self) -> None:
        hold_lock()
        started = time.monotonic()
        env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        try:
            self._process = subprocess.Popen(self._argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                             env=env, text=True, encoding="utf-8", errors="replace")
        except OSError as failed:
            sys.exit(f"the voice did not start: {failed}")
        # stderr is read all along, so a chatty voice never blocks on a full pipe; its tail says
        # why when the voice dies.
        self._drain = threading.Thread(target=lambda: self._stderr.extend(self._process.stderr), daemon=True)
        self._drain.start()
        threading.Thread(target=self._read, daemon=True).start()
        self._reply("load")
        print(f"narration: voice loaded in {time.monotonic() - started:.1f} s", file=sys.stderr, flush=True)

    def _died(self) -> None:
        code = self._process.wait()
        self._drain.join(timeout=5)
        sys.exit(f"the voice stopped ({code}): {''.join(self._stderr).strip()[-1500:]}")

    def _read(self) -> None:
        for line in self._process.stdout:
            self._lines.put(line)
        self._lines.put("")

    def _reply(self, doing: str) -> dict:
        """The voice's next protocol line; a sentence done (`{"sentence": n}`) starts its time anew."""
        while True:
            try:
                line = self._lines.get(timeout=ANSWER_LIMITS[doing])
            except queue.Empty:
                self._process.kill()
                self._process.wait()
                self._drain.join(timeout=5)
                why = "".join(self._stderr).strip()[-1500:]
                sys.exit(f"the voice said nothing for {ANSWER_LIMITS[doing]:g} s while {'loading' if doing == 'load' else 'making a clip'} and was ended" + (f": {why}" if why else ""))
            if not line:
                self._died()
            try:
                reply = json.loads(line)
            except ValueError:
                reply = None
            if isinstance(reply, dict):
                if "sentence" in reply:
                    continue
                return reply
            # Not the protocol: something printed where it should not have. Shown, not fatal.
            print(f"voice: {line.rstrip()}", file=sys.stderr)

    def synthesize(self, text: str, target: Path, script: str | None = None) -> dict | None:
        if self._process is None:
            self._start()
        raw = target.with_name(f"{target.stem}.raw.wav")
        raw.unlink(missing_ok=True)
        request = {"text": text, "out": str(raw), "language": self._language} | ({"script": script} if script else {})
        try:
            self._process.stdin.write(json.dumps(request) + "\n")
            self._process.stdin.flush()
        except (BrokenPipeError, OSError):
            self._died()
        reply = self._reply("sentence")
        if "error" in reply or not raw.exists():
            sys.exit(f"the voice failed: {reply.get('error') or f'it wrote no WAV at {raw}'}")
        print(f"narration: synthesised in {reply.get('seconds', '?')} s", file=sys.stderr, flush=True)
        to_wav(raw, target)
        raw.unlink(missing_ok=True)
        return hearing(reply)

    def close(self) -> None:
        """Its stdin ends, and with it the voice."""
        if self._process is None:
            return
        self._process.stdin.close()
        try:
            self._process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self._process.kill()


class HeldVoice:
    """A voice Obeya holds loaded across renders (`$OBEYA_URL`), else served by this process."""

    def __init__(self, spec: dict, language: str, url: str) -> None:
        self._host = spec["host"]
        self._language = language
        self._url = f"{url.rstrip('/')}/api/narration/clip"
        self._local = ServedVoice(spec, language)
        self._here = False
        self.tag = spec["tag"]
        # Obeya is on this machine: no proxy in between.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _ask(self, text: str, script: str | None) -> dict | None:
        """Obeya's reply, or None when Obeya cannot be reached or does not hold voices."""
        # the WAV comes back in the reply: Obeya may run on another machine than this render
        body = json.dumps({"voice": self._host, "text": text, "inline": True, "language": self._language} | ({"script": script} if script else {})).encode()
        request = urllib.request.Request(self._url, data=body, headers={"Content-Type": "application/json"})
        try:
            with self._opener.open(request, timeout=3600) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code == 404:
                why = "it does not hold voices"
            else:
                sys.exit(f"Obeya refused the clip ({error.code}): {error.read().decode(errors='replace')[:600]}")
        except (OSError, ValueError) as error:  # not running, or restarting midway
            why = f"it is not reachable ({error})"
        print(f"narration: Obeya does not hold the voice, {why}; loading it here", file=sys.stderr, flush=True)
        return None

    def synthesize(self, text: str, target: Path, script: str | None = None) -> dict | None:
        if not self._here:
            raw = target.with_name(f"{target.stem}.raw.wav")
            raw.unlink(missing_ok=True)
            reply = self._ask(text, script)
            if reply is not None:
                if "error" in reply or not reply.get("wav"):
                    sys.exit(f"the voice failed: {reply.get('error') or 'it sent no WAV'}")
                raw.write_bytes(base64.b64decode(reply["wav"]))
                print(f"narration: synthesised by Obeya in {reply.get('seconds', '?')} s", file=sys.stderr, flush=True)
                to_wav(raw, target)
                raw.unlink(missing_ok=True)
                return hearing(reply)
            self._here = True
        return self._local.synthesize(text, target, script)

    def close(self) -> None:
        self._local.close()


class HttpVoice:
    """A hosted voice. The whole clip in one request, for one continuous prosody."""

    def __init__(self, spec: dict, language: str) -> None:
        self._service = service = spec["service"]
        self._language = language
        self._url = spec.get("url") or ""
        self._voice = spec.get("voiceName") or DEFAULT_VOICES.get(service, {}).get(language, "")
        self._style = STYLE.format(language=LANGUAGE_NAMES[language])
        key_env = spec["keyEnv"]
        key = os.environ.get(key_env, "").strip()
        key_file = spec.get("keyFile")
        if not key and key_file:
            if not Path(key_file).exists():
                sys.exit(f"no API key at {key_file}")
            key = Path(key_file).read_text(encoding="utf-8").strip()
        if not key and service != "http":
            sys.exit(f"no {service} API key: set {key_env}, or the key file in the demo settings")
        if service in ("http", "azure") and not self._url:
            sys.exit(f"no {'endpoint' if service == 'http' else 'region'} for the {service} voice in the demo settings")
        self._key = key
        model = {"gemini": GEMINI_MODEL, "openai": OPENAI_MODEL, "elevenlabs": ELEVENLABS_MODEL}.get(service, "")
        self.reads_tags = service == "elevenlabs" and model in TAG_MODELS
        self.tag = f"{service}|{self._url}|{model}|{self._voice}|{self._style if service in ('gemini', 'openai') else ''}"

    def _post(self, url: str, body: bytes, headers: dict) -> bytes:
        request = urllib.request.Request(url, data=body, headers={"User-Agent": "obeya-demo", **headers})
        for attempt in range(6):
            try:
                with urllib.request.urlopen(request, timeout=180) as response:
                    return response.read()
            except urllib.error.HTTPError as error:
                detail = error.read().decode(errors="replace")
                # A spent daily quota answers 429 too, but waiting does not help there.
                if error.code == 429 and "PerDay" in detail:
                    raise QuotaExhausted(f"the daily {self._service} TTS quota is used up")
                if error.code not in (429, 503) or attempt == 5:
                    sys.exit(f"{self._service} TTS failed ({error.code}): {detail[:600]}")
                # A rate limit says how long to wait, in a header or (Gemini) in the body.
                delay = error.headers.get("Retry-After") or (re.search(r'"retryDelay":\s*"(\d+)', detail) or [None, None])[1]
                wait = int(float(delay)) + 1 if delay else 30
                print(f"{self._service} rate limit, waiting {wait} s", file=sys.stderr)
                time.sleep(wait)
            except urllib.error.URLError as error:
                sys.exit(f"{self._service} TTS unreachable at {url}: {error.reason}")
        raise AssertionError("unreachable")

    def synthesize(self, text: str, target: Path, script: str | None = None) -> dict | None:
        raw = target.with_name(f"{target.stem}.raw")
        if self._service == "gemini":
            body = {
                "contents": [{"parts": [{"text": GEMINI_NOTES.format(style=self._style) + text}]}],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": self._voice}}},
                },
            }
            reply = json.loads(self._post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
                json.dumps(body).encode(), {"x-goog-api-key": self._key, "Content-Type": "application/json"}))
            import base64

            audio = reply["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
            write_pcm(target, base64.b64decode(audio), 24000)
            return
        if self._service == "elevenlabs":
            pcm = self._post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{self._voice}?output_format=pcm_24000",
                json.dumps({"text": text, "model_id": ELEVENLABS_MODEL}).encode(),
                {"xi-api-key": self._key, "Content-Type": "application/json"})
            write_pcm(target, pcm, 24000)
            return
        if self._service == "openai":
            base = (self._url or "https://api.openai.com/v1").rstrip("/")
            audio = self._post(
                f"{base}/audio/speech",
                json.dumps({"model": OPENAI_MODEL, "voice": self._voice, "input": text,
                            "instructions": self._style, "response_format": "wav"}).encode(),
                {"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"})
        elif self._service == "azure":
            url = self._url if "://" in self._url else f"https://{self._url}.tts.speech.microsoft.com/cognitiveservices/v1"
            locale = LOCALES[self._language]
            ssml = f"<speak version='1.0' xml:lang='{locale}'><voice name='{escape(self._voice)}'>{escape(text)}</voice></speak>"
            audio = self._post(url, ssml.encode(), {
                "Ocp-Apim-Subscription-Key": self._key,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
            })
        else:
            headers = {"Content-Type": "application/json", "Accept": "audio/wav"}
            if self._key:
                headers["Authorization"] = f"Bearer {self._key}"
            audio = self._post(self._url, json.dumps({"text": text, "language": self._language}).encode(), headers)
        raw.write_bytes(audio)
        to_wav(raw, target)
        raw.unlink(missing_ok=True)


def make_voice(spec: dict, language: str):
    if spec["kind"] == "http":
        return HttpVoice(spec, language)
    if spec.get("serve") and spec.get("host") and os.environ.get("OBEYA_URL"):
        return HeldVoice(spec, language, os.environ["OBEYA_URL"])
    return ServedVoice(spec, language) if spec.get("serve") else CommandVoice(spec, language)


_lock_file: str | None = None
_held_lock = None


def hold_lock() -> None:
    """Takes the `--lock` file's lock for the rest of this process, once; the system drops it when
    the process ends. Without `--lock`, nothing."""
    global _held_lock
    if _lock_file is None or _held_lock is not None:
        return
    file = _lock_file
    Path(file).parent.mkdir(parents=True, exist_ok=True)
    handle = open(file, "a+b")
    if os.name == "nt":
        import msvcrt

        def attempt() -> None:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        def attempt() -> None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    try:
        attempt()
    except OSError:
        print("narration: another demo has a large model loaded, waiting for it (expected, not a hang)", file=sys.stderr, flush=True)
        since = time.monotonic()
        while True:
            time.sleep(1)
            try:
                attempt()
                break
            except OSError:
                continue
        print(f"narration: waited {round(time.monotonic() - since)} s for the other demo", file=sys.stderr, flush=True)
    _held_lock = handle


def take_option(args: list[str], name: str) -> str | None:
    if name not in args:
        return None
    i = args.index(name)
    value = args[i + 1]
    del args[i : i + 2]
    return value


def close(voice) -> None:
    """Ends a voice that stays loaded; the others have nothing running between clips."""
    if isinstance(voice, (ServedVoice, HeldVoice)):
        voice.close()


def joined(hearings: list[dict | None]) -> dict | None:
    """What was heard of a clip made in parts: every part's sentences, or why one was not heard."""
    if all(h is None for h in hearings):
        return None
    for h in hearings:
        if h is None or "unheard" in h:
            return {"unheard": (h or {}).get("unheard") or "a part was not heard back"}
    return {"heard": [s for h in hearings for s in h["heard"]]}


def with_pauses(voice, text: str, target: Path, script: str | None = None) -> dict | None:
    """`text` spoken by a voice that does not read tags: the parts between its pause tags one by
    one, joined by the silence each tag stands for, so the pauses the script asks for are there in
    every voice, not only in those that read them. `script`, the text as written, goes along part
    by part to a voice that hears its clips back; what it heard comes back."""
    def between_pauses(text: str) -> list[tuple[str, float]]:
        parts = PAUSE_TAG.split(text)
        spoken = [(untagged(parts[i]), PAUSES[parts[i + 1]] if i + 1 < len(parts) else 0.0) for i in range(0, len(parts), 2)]
        return [(t, pause) for t, pause in spoken if t]

    spoken = between_pauses(text)
    written = [t for t, _ in between_pauses(script)] if script else []
    if len(written) != len(spoken):
        written = [None] * len(spoken)
    if len(spoken) < 2:
        return voice.synthesize(untagged(text), target, untagged(script) if script else None)
    frames: list[bytes] = []
    shape = None
    hearings = []
    for n, ((part, pause), part_script) in enumerate(zip(spoken, written)):
        piece = target.with_name(f"{target.stem}.part{n}.wav")
        hearings.append(voice.synthesize(part, piece, part_script))
        with wave.open(str(piece)) as fh:
            params = (fh.getnchannels(), fh.getsampwidth(), fh.getframerate())
            if shape is None:
                shape = params
            elif params != shape:
                sys.exit(f"the voice's parts differ in format: {params} and {shape}")
            frames.append(fh.readframes(fh.getnframes()))
        piece.unlink()
        if n < len(spoken) - 1:
            frames.append(b"\0" * int(shape[2] * pause) * shape[0] * shape[1])
    with wave.open(str(target), "wb") as fh:
        fh.setnchannels(shape[0])
        fh.setsampwidth(shape[1])
        fh.setframerate(shape[2])
        fh.writeframes(b"".join(frames))
    return joined(hearings)


def narrate(voice, jobs: list[dict], out: Path) -> None:
    reads_tags = getattr(voice, "reads_tags", False)

    def key_of(job: dict) -> str:
        # a clip from before pauses were silence in every voice is not taken for one with them
        pauses = "\npauses" if not reads_tags and PAUSE_TAG.search(job["text"]) else ""
        return hashlib.sha1(f"{voice.tag}\n{job['text']}{pauses}".encode()).hexdigest()[:16]

    results = []
    for job in jobs:
        wav = out / f"{key_of(job)}.wav"
        heard_file = wav.with_suffix(".heard.json")
        if not wav.exists():
            partial = wav.with_suffix(".partial.wav")
            script = job.get("script")
            try:
                if reads_tags:
                    heard = voice.synthesize(job["text"], partial, script)
                else:
                    heard = with_pauses(voice, job["text"], partial, script)
            except QuotaExhausted as exhausted:
                sys.exit(f"{exhausted}; choose another voice (or DEMO_GEMINI_MODEL) or wait a day")
            heard_file.unlink(missing_ok=True)
            if heard is not None:
                heard_file.write_text(json.dumps(heard, ensure_ascii=False), encoding="utf-8")
            partial.rename(wav)
        with wave.open(str(wav)) as fh:
            seconds = fh.getnframes() / fh.getframerate()
        heard = json.loads(heard_file.read_text(encoding="utf-8")) if heard_file.exists() else {}
        results.append({"id": job["id"], "file": str(wav), "seconds": seconds, **heard})

    (out / "tts.json").write_text(json.dumps({"clips": results}, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    # A voice's messages carry umlauts; a Windows pipe would otherwise encode stderr in its code page.
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    global _lock_file
    _lock_file = take_option(args, "--lock")
    if args[0] == "--sample":
        spec_file, language, text, target = args[1:5]
        spec = json.loads(Path(spec_file).read_text(encoding="utf-8"))
        voice = make_voice(spec, language)
        # a command voice may load a model with every clip; a served one takes the lock as it starts
        if isinstance(voice, CommandVoice):
            hold_lock()
        try:
            voice.synthesize(spoken(spec, language, text), Path(target))
        finally:
            close(voice)
        return
    spec = json.loads(Path(args[0]).read_text(encoding="utf-8"))
    language = args[1]
    jobs = json.loads(Path(args[2]).read_text(encoding="utf-8"))
    out = Path(args[3])
    out.mkdir(parents=True, exist_ok=True)
    if language not in LANGUAGE_NAMES:
        sys.exit(f"unknown narration language {language!r}; known: {', '.join(LANGUAGE_NAMES)}")
    def said(job: dict) -> dict:
        # the script as written goes along where the voice is given it respelt: a voice that hears
        # its clips back compares with what was meant
        text, script = spoken(spec, language, job["text"]), written(job["text"])
        return {**job, "text": text} | ({"script": script} if script != text else {})

    jobs = [said(job) for job in jobs]
    voice = make_voice(spec, language)
    if isinstance(voice, CommandVoice):
        hold_lock()
    try:
        narrate(voice, jobs, out)
    finally:
        close(voice)

if __name__ == "__main__":
    main()
