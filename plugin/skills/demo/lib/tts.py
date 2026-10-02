"""Narration clips for a demo, in the voice of the demo settings.

The voice comes as a spec from `voices.ts`, one of two kinds:

- `command`: run once per clip, the text on stdin. Either `argv`, run directly with `{out}`
  replaced by the WAV to write (Piper, the Qwen3-TTS helper `qwen3.py`, macOS `say`), or
  `shell`, the owner's own command, which writes the WAV to `$DEMO_WAV` (or prints the path of
  the one it wrote as its last line). `$DEMO_LANGUAGE` says the narration language.
- `http`: a request from a template, for Gemini, OpenAI, ElevenLabs, Azure, or the owner's own
  endpoint (`http`: POST `{"text", "language"}` as JSON, audio back). The key comes from the
  service's environment variable, else from the key file in the spec.

Whatever comes back is made a mono 16-bit WAV with ffmpeg. Listening back takes Whisper, which
the render brings into a throwaway environment:

    uv run --no-project --with mlx-whisper python tts.py <spec.json> <language> <jobs.json> <out_dir>

`jobs.json` is `[{"id": ..., "text": ...}]`. Each text becomes `<out_dir>/<hash>.wav`, cached by
voice + text, so re-rendering a demo after a visual fix costs no synthesis. Every clip is
transcribed back with Whisper: a voice occasionally swallows or invents a word, and the narration
is the one part of a demo nobody re-reads. Results land in `<out_dir>/tts.json`.

    python tts.py --sample <spec.json> <language> <text> <out.wav>

synthesises one clip without listening back, for hearing a voice in the settings.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path
from xml.sax.saxutils import escape

#: A take whose transcript matches at least this well is kept without trying another. Whisper
#: itself splits compounds ("Wasserkraft" → "Wasser Kraft"), so a perfect clip rarely scores 1.0.
GOOD_MATCH = 0.95
MAX_TAKES = 3

LANGUAGE_NAMES = {"de": "German", "en": "English"}
LOCALES = {"de": "de-DE", "en": "en-US"}
STT_MODEL = os.environ.get("DEMO_STT_MODEL", "mlx-community/whisper-large-v3-turbo")

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
ELEVENLABS_MODEL = os.environ.get("DEMO_ELEVENLABS_MODEL", "eleven_multilingual_v2")
#: Each service's voice when the settings name none: calm male voices, like Gemini's Charon.
DEFAULT_VOICES = {
    "gemini": {"de": "Charon", "en": "Charon"},
    "openai": {"de": "onyx", "en": "onyx"},
    "elevenlabs": {"de": "JBFqnCBsd6RMkjVDRZzb", "en": "JBFqnCBsd6RMkjVDRZzb"},
    "azure": {"de": "de-DE-ConradNeural", "en": "en-US-AndrewNeural"},
}
KEY_ENV = {
    "gemini": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "elevenlabs": "ELEVENLABS_API_KEY",
    "azure": "AZURE_SPEECH_KEY",
    "http": "DEMO_TTS_API_KEY",
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


_ONES = [
    "null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn",
    "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn",
    "neunzehn",
]
_TENS = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"]


def german_number(n: int) -> str:
    """0 ≤ n < 1,000,000 as one German word; larger numbers stay digits."""
    if n < 20:
        return _ONES[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        return (("ein" if ones == 1 else _ONES[ones]) + "und" if ones else "") + _TENS[tens]
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        return ("ein" if hundreds == 1 else _ONES[hundreds]) + "hundert" + (german_number(rest) if rest else "")
    if n < 1_000_000:
        thousands, rest = divmod(n, 1000)
        return ("ein" if thousands == 1 else german_number(thousands)) + "tausend" + (german_number(rest) if rest else "")
    return str(n)


_EN_ONES = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
    "nineteen",
]
_EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def english_number(n: int) -> str:
    """0 ≤ n < 1,000,000 in English words, the way a narration spells it; larger numbers stay digits."""
    if n < 20:
        return _EN_ONES[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        return _EN_TENS[tens] + (_EN_ONES[ones] if ones else "")
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        return _EN_ONES[hundreds] + "hundred" + (("and" + english_number(rest)) if rest else "")
    if n < 1_000_000:
        thousands, rest = divmod(n, 1000)
        return english_number(thousands) + "thousand" + (english_number(rest) if rest else "")
    return str(n)


def spoken_letters(text: str, language: str = "de") -> str:
    """The letters a listener hears, for comparing a script with its transcript.

    Whisper writes numbers as digits ("15.200") where the script spells them out, and splits
    compounds ("oder Berg"); neither is a defect of the clip. So digits become words, and spaces
    and punctuation are dropped before comparing. "and" inside English numbers is said by some
    and not by others, so it is dropped as well.
    """
    if language == "de":
        text = re.sub(r"(?<=\d)\.(?=\d{3}\b)", "", text)
        text = re.sub(r"\d+", lambda m: german_number(int(m.group())), text)
        return re.sub(r"[^a-zäöüß]", "", text.lower())
    text = re.sub(r"(?<=\d),(?=\d{3}\b)", "", text)
    text = re.sub(r"\d+", lambda m: english_number(int(m.group())), text)
    text = re.sub(r"\band\b", "", text.lower())
    return re.sub(r"[^a-z]", "", text)


class QuotaExhausted(Exception):
    """The voice cannot synthesise anything more today."""


class CommandVoice:
    """A program run once per clip: Piper, Qwen3-TTS, `say`, or the owner's own command."""

    #: Takes cost only time on this machine.
    max_takes = MAX_TAKES

    def __init__(self, spec: dict, language: str) -> None:
        self._argv = spec.get("argv")
        self._shell = spec.get("shell")
        if not self._argv and not self._shell:
            sys.exit("no voice command: set the command in the demo settings")
        self._language = language
        self.tag = spec["tag"]

    def synthesize(self, text: str, target: Path) -> None:
        raw = target.with_name(f"{target.stem}.raw.wav")
        raw.unlink(missing_ok=True)
        env = {**os.environ, "DEMO_WAV": str(raw), "DEMO_LANGUAGE": self._language}
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


class HttpVoice:
    """A hosted voice. The whole clip in one request, for one continuous prosody."""

    #: Every take costs a request, often of a small quota; one retake at most.
    max_takes = 2

    def __init__(self, spec: dict, language: str) -> None:
        self._service = service = spec["service"]
        self._language = language
        self._url = spec.get("url") or ""
        self._voice = spec.get("voiceName") or DEFAULT_VOICES.get(service, {}).get(language, "")
        self._style = STYLE.format(language=LANGUAGE_NAMES[language])
        key = os.environ.get(KEY_ENV[service], "").strip()
        key_file = spec.get("keyFile")
        if not key and key_file:
            if not Path(key_file).exists():
                sys.exit(f"no API key at {key_file}")
            key = Path(key_file).read_text(encoding="utf-8").strip()
        if not key and service != "http":
            sys.exit(f"no {service} API key: set {KEY_ENV[service]}, or the key file in the demo settings")
        if service in ("http", "azure") and not self._url:
            sys.exit(f"no {'endpoint' if service == 'http' else 'region'} for the {service} voice in the demo settings")
        self._key = key
        model = {"gemini": GEMINI_MODEL, "openai": OPENAI_MODEL, "elevenlabs": ELEVENLABS_MODEL}.get(service, "")
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

    def synthesize(self, text: str, target: Path) -> None:
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
    return CommandVoice(spec, language) if spec["kind"] == "command" else HttpVoice(spec, language)


def main() -> None:
    if sys.argv[1] == "--sample":
        spec_file, language, text, target = sys.argv[2:6]
        make_voice(json.loads(Path(spec_file).read_text(encoding="utf-8")), language).synthesize(text, Path(target))
        return
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    language = sys.argv[2]
    jobs = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    out = Path(sys.argv[4])
    out.mkdir(parents=True, exist_ok=True)
    if language not in LANGUAGE_NAMES:
        sys.exit(f"unknown narration language {language!r}; known: {', '.join(LANGUAGE_NAMES)}")
    voice = make_voice(spec, language)
    voice_tag = voice.tag

    def hear(wav: Path) -> str:
        import mlx_whisper

        heard = mlx_whisper.transcribe(str(wav), path_or_hf_repo=STT_MODEL, language=language)
        return str(heard.get("text", "")).strip()

    def score(text: str, heard: str) -> float:
        a, b = spoken_letters(text, language), spoken_letters(heard, language)
        return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()

    results = []
    for job in jobs:
        key = hashlib.sha1(f"{voice_tag}\n{job['text']}".encode()).hexdigest()[:16]
        wav = out / f"{key}.wav"
        heard_file = wav.with_suffix(".heard.txt")
        if not wav.exists():
            # Sampling differs per run, so a take that swallowed or invented a word is simply
            # synthesised again; the best of a few takes is kept.
            best: tuple[float, str, Path] | None = None
            for take in range(1, voice.max_takes + 1):
                candidate = out / f"{key}.take{take}.wav"
                try:
                    voice.synthesize(job["text"], candidate)
                except QuotaExhausted as exhausted:
                    if best is None:
                        sys.exit(f"{exhausted}; choose another voice (or DEMO_GEMINI_MODEL) or wait a day")
                    print(f"{job['id']}: {exhausted}, keeping take {take - 1}", file=sys.stderr)
                    break
                heard = hear(candidate)
                match = score(job["text"], heard)
                print(f"{job['id']} take {take}: match {match:.2f}", file=sys.stderr)
                if best is None or match > best[0]:
                    best = (match, heard, candidate)
                if match >= GOOD_MATCH:
                    break
            _, heard, chosen = best
            chosen.rename(wav)
            heard_file.write_text(heard, encoding="utf-8")
            for leftover in out.glob(f"{key}.take*.wav"):
                leftover.unlink()

        if not heard_file.exists():
            heard_file.write_text(hear(wav), encoding="utf-8")
        heard_text = heard_file.read_text(encoding="utf-8")

        with wave.open(str(wav)) as fh:
            seconds = fh.getnframes() / fh.getframerate()
        match = score(job["text"], heard_text)
        results.append(
            {"id": job["id"], "file": str(wav), "seconds": seconds, "heard": heard_text, "match": match}
        )

    (out / "tts.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
