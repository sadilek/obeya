"""Narration clips for a demo, in one of three voices.

- `clone`: the owner's cloned voice, on-device through the voice project (a uv project whose
  `avatar.config` names model and reference clip and whose `avatar.tts` synthesises).
- `gemini`: a stock voice from Google's Gemini TTS. The API key comes from `GEMINI_API_KEY`, or
  from the file `GEMINI_API_KEY_FILE` names.
- a path to a `.wav`: that clip cloned like the owner's voice, with its exact transcript in the
  `.txt` beside it. The clip must start and end inside a pause.

A clone runs inside the voice project's environment, which also carries Whisper; a stock voice
needs only numpy and Whisper:

    uv run --project <voice project> python tts.py <voice> <language> <jobs.json> <out_dir>

`jobs.json` is `[{"id": ..., "text": ...}]`. Each text becomes `<out_dir>/<hash>.wav`, cached by
voice + text, so re-rendering a demo after a visual fix costs no synthesis. Every clip is
transcribed back with Whisper: a voice occasionally swallows or invents a word, and the narration
is the one part of a demo nobody re-reads. Results land in `<out_dir>/tts.json`.
"""

from __future__ import annotations

import base64
import difflib
import os
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

import numpy as np

#: Pause between sentences. Each sentence is synthesised on its own: the model drifts on long
#: inputs, and a short gap reads as a natural breath.
SENTENCE_GAP_SECONDS = 0.28
#: A take whose transcript matches at least this well is kept without trying another. Whisper
#: itself splits compounds ("Wasserkraft" → "Wasser Kraft"), so a perfect clip rarely scores 1.0.
GOOD_MATCH = 0.95
MAX_TAKES = 3

#: Free-tier quotas are per model (10 requests a day), so another TTS model can stand in.
GEMINI_MODEL = os.environ.get("DEMO_GEMINI_MODEL", "gemini-3.8-flash-tts")
#: A calm, informative male voice from Gemini's prebuilt set.
GEMINI_VOICE = "Charon"
#: Director's notes the model reads but does not speak; only the transcript is spoken. A plain
#: prefix ("Sprich ruhig: …") gets read aloud.
GEMINI_STYLE = (
    "### DIRECTOR'S NOTES\n"
    "Style: calm, matter-of-fact, confident; a product lead walking a colleague through a finished "
    "feature. Native {language}, natural pace, slightly brisk.\n\n"
    "#### TRANSCRIPT\n"
)
GEMINI_RATE = 24000
LANGUAGE_NAMES = {"de": "German", "en": "English"}
DEFAULT_STT_MODEL = "mlx-community/whisper-large-v3-turbo"


def sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p for p in parts if p]


def write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(rate)
        fh.writeframes(pcm.tobytes())


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


class ClonedVoice:
    """The owner's voice. Sentence by sentence: the clone drifts on long inputs."""

    #: Takes are free on-device.
    max_takes = MAX_TAKES

    def __init__(self, config: dict, reference: Path | None = None) -> None:
        if reference is not None:
            # Any clean reference clip, e.g. a voice designed elsewhere; its transcript sits beside it.
            transcript = reference.with_suffix(".txt")
            if not transcript.exists():
                sys.exit(f"no transcript for {reference}: expected {transcript}")
            config = {**config, "tts": {**config["tts"], "reference_wav": str(reference),
                                        "reference_text": transcript.read_text(encoding="utf-8").strip()}}
        from avatar.tts import make_tts

        self._tts = make_tts(config, "local_clone")
        self.tag = f"{config['tts'].get('model')}|{config['tts'].get('reference_wav')}"

    def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        chunks: list[np.ndarray] = []
        rate = 24000
        for sentence in sentences(text):
            samples, rate = self._tts.synthesize(sentence)
            chunks += [samples, np.zeros(int(SENTENCE_GAP_SECONDS * rate), dtype=np.float32)]
        return np.concatenate(chunks[:-1]), rate


class GeminiVoice:
    """A stock Gemini TTS voice. The whole clip in one request, for one continuous prosody."""

    #: Every take costs a request of a small daily quota; one retake at most.
    max_takes = 2

    def __init__(self, language: str) -> None:
        self._style = GEMINI_STYLE.format(language=LANGUAGE_NAMES[language])
        self.tag = f"gemini|{GEMINI_MODEL}|{GEMINI_VOICE}|{self._style}"
        key = os.environ.get("GEMINI_API_KEY", "").strip()
        key_file = os.environ.get("GEMINI_API_KEY_FILE")
        if not key and key_file:
            if not Path(key_file).exists():
                sys.exit(f"no Gemini API key at {key_file}")
            key = Path(key_file).read_text(encoding="utf-8").strip()
        if not key:
            sys.exit("no Gemini API key: set GEMINI_API_KEY, or the key file in the demo settings")
        self._key = key

    def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        body = {
            "contents": [{"parts": [{"text": f"{self._style}{text}"}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": GEMINI_VOICE}}
                },
            },
        }
        request = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
            data=json.dumps(body).encode(),
            headers={"x-goog-api-key": self._key, "Content-Type": "application/json"},
        )
        for attempt in range(6):
            try:
                with urllib.request.urlopen(request, timeout=180) as response:
                    reply = json.load(response)
                break
            except urllib.error.HTTPError as error:
                detail = error.read().decode()
                # A spent daily quota answers 429 too, but waiting does not help there.
                if error.code == 429 and "PerDay" in detail:
                    raise QuotaExhausted(f"daily Gemini TTS quota of {GEMINI_MODEL} is used up")
                # The per-minute limit says in the 429 how long to wait.
                if error.code != 429 or attempt == 5:
                    sys.exit(f"Gemini TTS failed ({error.code}): {detail[:600]}")
                delay = re.search(r'"retryDelay":\s*"(\d+)', detail)
                wait = int(delay.group(1)) + 1 if delay else 30
                print(f"Gemini rate limit, waiting {wait} s", file=sys.stderr)
                time.sleep(wait)
        audio = reply["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
        pcm = np.frombuffer(base64.b64decode(audio), dtype=np.int16)
        return pcm.astype(np.float32) / 32768, GEMINI_RATE


def main() -> None:
    voice_name, language = sys.argv[1], sys.argv[2]
    jobs = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    out = Path(sys.argv[4])
    out.mkdir(parents=True, exist_ok=True)
    if language not in LANGUAGE_NAMES:
        sys.exit(f"unknown narration language {language!r}; known: {', '.join(LANGUAGE_NAMES)}")

    if voice_name == "gemini":
        voice = GeminiVoice(language)
        stt_model = DEFAULT_STT_MODEL
    else:
        from avatar.config import load_config

        config = load_config()
        voice = ClonedVoice(config, Path(voice_name) if voice_name.endswith(".wav") else None)
        stt_model = config.get("stt", {}).get("model", DEFAULT_STT_MODEL)
    voice_tag = voice.tag

    def hear(wav: Path) -> str:
        import mlx_whisper

        heard = mlx_whisper.transcribe(str(wav), path_or_hf_repo=stt_model, language=language)
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
                try:
                    samples, rate = voice.synthesize(job["text"])
                except QuotaExhausted as exhausted:
                    if best is None:
                        sys.exit(f"{exhausted}; set DEMO_GEMINI_MODEL to another TTS model or wait a day")
                    print(f"{job['id']}: {exhausted}, keeping take {take - 1}", file=sys.stderr)
                    break
                candidate = out / f"{key}.take{take}.wav"
                write_wav(candidate, samples, rate)
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
