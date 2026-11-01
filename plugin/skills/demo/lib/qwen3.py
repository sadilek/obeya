"""Narration clips with Qwen3-TTS: one clip, or as many as asked while the model stays loaded.

Runs in the environment Obeya installs for the voice (`voices.ts`): MLX through mlx-audio on
Apple Silicon, PyTorch through qwen-tts elsewhere.

    python qwen3.py --model <repo> --language de (--speaker ryan | --reference clip.wav) --out x.wav
    python qwen3.py --model <repo> --language de (--speaker ryan | --reference clip.wav) --serve

With `--out`, the text comes on stdin and one WAV goes out. With `--serve`, the model, the
reference and its transcript load once and the process answers requests until its stdin ends,
one JSON object per line each way (what `tts.py` speaks with a voice whose spec has `serve`):

    → {"ready": true}                                      once the model is loaded
    ← {"text": "...", "script": "...", "out": "/x/clip.wav", "language": "de", "id": 7}
    → {"sentence": 1, "of": 3, "id": 7}                    once per sentence done
    → {"ok": true, "seconds": 4.2, "heard": [...], "id": 7}  or  {"error": "...", "id": 7}

`script`, `language` and `id` are optional. `script` is the text as written, where `text` has words
respelt for the voice (`lexicon.qwen3.<language>.json`); it is what the clip is heard against.
`heard` holds a line per sentence, `{"script", "heard"}` with `"stumbled": true` and `"misheard":
[[word, heard as], ...]` where they apply; a voice that cannot hear says `"unheard": "why"` instead.

The sentence lines tell whoever asked that the voice is still at work: a voice that says nothing
for minutes is stuck, and gets ended.

stdout carries nothing but these lines: the libraries print there too, so their output is moved
to stderr before they load.

A stock speaker comes from a CustomVoice model; `--reference` clones a clip with a Base model,
conditioned on its exact transcript in the `.txt` beside it. The clip must start and end inside a
pause: the model continues the reference, and a cut in the middle of a word made every clip start
with a noise. Sentence by sentence, since the model drifts on long inputs; a short gap between
them reads as a natural breath.

A word the model cannot read ("Reauthenticate") can make it lose its place in the sentence: it
says the word again and again and never ends, until its frame limit, minutes later. So a sentence
gets frames for a slow reading of it, no more; one that uses them all ran on, and is made again.

It can also stumble and still end in time ("reauthenti uh reauthentic"). So each sentence is heard
back with Parakeet, the speech recognition of Obeya's voice input, and compared with its script
letter by letter: one with a stretch of `STUMBLE_LETTERS` or more that differs is made again too,
and the take that differs least is kept, also when every attempt stumbled (a name the
recognition always mishears must not stop a render); only a sentence that ran on every time fails
its clip. The recognition writes what it hears, a wrong sound
included ("reauthentipate"), but it also mishears a letter or two of a clean sentence ("show" for
"showed"), which is why a short difference does not count. A word heard differently in the kept
take is reported, so a word the voice cannot read can go into its lexicon.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
import time
import wave
from pathlib import Path

SENTENCE_GAP_SECONDS = 0.28
LANGUAGES = {"de": "german", "en": "english"}
#: Qwen3-TTS-12Hz speaks in frames of 80 ms.
FRAMES_PER_SECOND = 12.5
#: A slow reading: clean takes ran at about 17 characters a second, so this is twice as long.
SLOW_CHARACTERS_PER_SECOND = 8
#: How often a sentence is made in all, while it runs on or stumbles.
ATTEMPTS = 5
#: A stretch of this many letters said otherwise or said more than the script is a stumble: of 198
#: takes of one sentence, clean ones differed by up to 4 (a mishearing), stumbles by 5 to 79.
STUMBLE_LETTERS = 5
#: Parakeet now and then drops a word or two of a clean sentence ("shows", "ich sage"; up to 9
#: letters): letters that are only missing count from this many on, where the voice skipped a
#: stretch or lost its place in the sentence.
SKIPPED_LETTERS = 12
#: Parakeet, as Obeya's voice input hears with it.
EAR_MODEL = "nemo-parakeet-tdt-0.6b-v3"
#: The audio tags of a script ("[short pause]"): not said.
AUDIO_TAG = re.compile(r"\[[^\]]*\]")

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
        return _EN_ONES[hundreds] + "hundred" + (english_number(rest) if rest else "")
    if n < 1_000_000:
        thousands, rest = divmod(n, 1000)
        return english_number(thousands) + "thousand" + (english_number(rest) if rest else "")
    return str(n)


_DE_ORDINAL_STEMS = {1: "erst", 3: "dritt", 7: "siebt", 8: "acht"}
_EN_ORDINALS = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth", "nine": "ninth", "twelve": "twelfth"}


def number_forms(n: int, language: str) -> list[str]:
    """The ways a voice may say `n`, the usual first: "elfhundert" as well as "eintausendeinhundert",
    "hundert" as well as "einhundert", and as an ordinal ("zwölften", "twenty-first"), which the
    recognition writes as "12." and "21st"."""
    if language == "de":
        usual = german_number(n)
        forms = [usual, re.sub(r"^ein(?=hundert|tausend)", "", usual), *([usual[:-1] + end for end in ("", "e", "en", "em", "er", "es")] if usual.endswith("eins") else [])]
        if 1100 <= n < 10000 and n % 1000 >= 100:
            forms.append(german_number(n // 100) + "hundert" + (german_number(n % 100) if n % 100 else ""))
        stems = [_DE_ORDINAL_STEMS.get(n, german_number(n) + ("t" if n < 20 else "st"))]
        return forms + [stem + end for stem in stems for end in ("e", "en", "er", "em", "es")]
    usual = english_number(n)
    forms = [usual, re.sub(r"^one(?=hundred|thousand)", "a", usual)]
    if 1100 <= n < 10000 and n % 1000 >= 100:
        forms.append(english_number(n // 100) + "hundred" + (english_number(n % 100) if n % 100 else ""))
    last = next((w for w in sorted(_EN_ORDINALS, key=len, reverse=True) if usual.endswith(w)), None)
    ordinal = usual[: -len(last)] + _EN_ORDINALS[last] if last else (usual[:-1] + "ieth" if usual.endswith("y") else usual + "th")
    return forms + [ordinal]


def spoken_letters(text: str, language: str, like: str = "") -> str:
    """The letters a listener hears, for comparing a script with its transcript.

    The recognition writes numbers as digits ("15.200", "12.", "21st") where the script may spell
    them out, and joins or splits compounds ("Kastenlast"); neither is a fault of the voice. So
    digits become words, the way of saying them found in `like` (the letters of the other text) if
    one is, and spaces and punctuation go. "and" inside English numbers is said by some and not by
    others, so it goes as well. Audio tags are not said.
    """
    def said(m: re.Match) -> str:
        forms = number_forms(int(m[1]), language)
        return next((f for f in sorted(forms, key=len, reverse=True) if f in like), forms[0])

    text = AUDIO_TAG.sub(" ", text)
    if language == "de":
        text = re.sub(r"(?<=\d)\.(?=\d{3}\b)", "", text)
        text = re.sub(r"(\d+)", said, text)
        return re.sub(r"[^a-zäöüß]", "", text.lower())
    text = re.sub(r"(?<=\d),(?=\d{3}\b)", "", text)
    text = re.sub(r"(\d+)(?:(?:st|nd|rd|th)\b)?", said, text)
    text = re.sub(r"\band\b", "", text.lower())
    return re.sub(r"[^a-z]", "", text)


def compared(script: str, heard: str, language: str) -> tuple[str, str]:
    """The letters of script and transcript, each number said the way the other has it."""
    a, b = spoken_letters(script, language), spoken_letters(heard, language)
    return spoken_letters(script, language, b), spoken_letters(heard, language, a)


def differing(script: str, heard: str, language: str) -> int:
    """The longest stretch of letters in which what was heard differs from the script: said
    otherwise or said more, or missing from what was heard, the latter only from
    `SKIPPED_LETTERS` on or from half the sentence."""
    a, b = compared(script, heard, language)
    opcodes = difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
    # in a short sentence, half of it missing counts too ("Click save." heard as nothing)
    skipped = min(SKIPPED_LETTERS, len(a) // 2 + 1)
    stretches = [max(i2 - i1, j2 - j1) if op != "delete" else i2 - i1 if i2 - i1 >= skipped else 0 for op, i1, i2, j1, j2 in opcodes if op != "equal"]
    return max(stretches, default=0)


def misheard(script: str, heard: str, language: str) -> list[list[str]]:
    """The words of the script heard as other words, `[written, heard as]`; a compound heard apart
    or together ("Kasten Last" as "Kastenlast") is the same word."""
    whole = compared(script, heard, language)

    def words(text: str, like: str) -> list[tuple[str, str]]:
        found = [(w.strip(".,;:!?\"'()„“”‚‘’"), spoken_letters(w, language, like)) for w in AUDIO_TAG.sub(" ", text).split()]
        return [(w, letters) for w, letters in found if letters]

    def same_start(a: list, b: list) -> tuple[int, int] | None:
        """How many words at the start of `a` and of `b` spell the same letters, if any do."""
        for i in range(1, len(a) + 1):
            for j in range(1, len(b) + 1):
                if "".join(l for _, l in a[:i]) == "".join(l for _, l in b[:j]):
                    return i, j
        return None

    said, got = words(script, whole[1]), words(heard, whole[0])
    matcher = difflib.SequenceMatcher(None, [l for _, l in said], [l for _, l in got], autojunk=False)
    out = []
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op != "replace":
            continue
        a, b = said[i1:i2], got[j1:j2]
        # compounds heard apart or together at either end are no difference
        while a and b and (n := same_start(a, b)):
            a, b = a[n[0]:], b[n[1]:]
        while a and b and (n := same_start(a[::-1], b[::-1])):
            a, b = a[: len(a) - n[0]], b[: len(b) - n[1]]
        # an ending of a letter or two lost or gained ("show" for "showed") is the recognition's, and
        # so is a short word heard as another ("wem" for "wie"): neither is a word to respell
        x, y = "".join(l for _, l in a), "".join(l for _, l in b)
        if a and b and len(x) >= 5 and not ((x.startswith(y) or y.startswith(x)) and abs(len(x) - len(y)) <= 2):
            out.append([" ".join(w for w, _ in a), " ".join(w for w, _ in b)])
    return out


def frames_for(sentence: str) -> int:
    """The frames a sentence may take: a slow reading of it, and a few seconds more for a short one."""
    return int((len(sentence) / SLOW_CHARACTERS_PER_SECOND + 3) * FRAMES_PER_SECOND)


def sentences(text: str) -> list[str]:
    return [p for p in re.split(r"(?<=[.!?])\s+", text.strip()) if p]


def write_wav(path: str, samples, rate: int) -> None:
    import numpy as np

    pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(path, "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(rate)
        fh.writeframes(pcm.tobytes())


def load(args):
    """The model, ready to speak: `speak(sentence, language, frames)` gives the samples of at most
    `frames` frames, `rate()` their rate."""
    ref_text = None
    if args.reference:
        transcript = Path(args.reference).with_suffix(".txt")
        if not transcript.exists():
            sys.exit(f"no transcript for {args.reference}: expected {transcript}")
        ref_text = transcript.read_text(encoding="utf-8").strip()

    import numpy as np

    try:
        from mlx_audio.tts.utils import load_model
    except ImportError:
        load_model = None

    if load_model:
        model = load_model(args.model)

        def speak(sentence: str, language: str, frames: int):
            kwargs = {"lang_code": LANGUAGES[language], "max_tokens": frames}
            if args.reference:
                kwargs |= {"ref_audio": args.reference, "ref_text": ref_text}
            else:
                kwargs["voice"] = args.speaker
            return np.concatenate([np.array(s.audio) for s in model.generate(text=sentence, **kwargs)])

        return speak, lambda: model.sample_rate

    import torch
    from qwen_tts import Qwen3TTSModel

    device = "cuda:0" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    model = Qwen3TTSModel.from_pretrained(args.model, device_map=device, dtype=torch.bfloat16)
    rate = 24000

    def speak(sentence: str, language: str, frames: int):
        nonlocal rate
        if args.reference:
            wavs, rate = model.generate_voice_clone(text=sentence, language=LANGUAGES[language].capitalize(), ref_audio=args.reference, ref_text=ref_text, max_new_tokens=frames)
        else:
            wavs, rate = model.generate_custom_voice(text=sentence, language=LANGUAGES[language].capitalize(), speaker=args.speaker, max_new_tokens=frames)
        return np.asarray(wavs[0], dtype=np.float32)

    return speak, lambda: rate


class Ear:
    """Parakeet, hearing each sentence back. One that fails to load hears nothing, and says why."""

    #: The rates onnx-asr takes as they are; another is made 16 kHz first.
    RATES = (8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000)

    def __init__(self) -> None:
        self._model = None
        self.unheard: str | None = None

    def load(self) -> None:
        try:
            import onnx_asr
            import onnxruntime

            # as Obeya's voice input: more than 4 threads only cost
            options = onnxruntime.SessionOptions()
            options.intra_op_num_threads = min(4, os.cpu_count() or 4)
            self._model = onnx_asr.load_model(EAR_MODEL, quantization="int8", sess_options=options, providers=["CPUExecutionProvider"])
        except Exception as failed:  # not installed, the model not downloadable, out of memory
            self.unheard = f"Parakeet did not load: {type(failed).__name__}: {failed}"[:400]
            print(f"qwen3: not hearing the narration back, {self.unheard}", file=sys.stderr, flush=True)

    def hear(self, samples, rate: int) -> str | None:
        if self._model is None:
            return None
        import numpy as np

        samples = np.asarray(samples, dtype=np.float32)
        if rate not in self.RATES:
            samples = np.interp(np.arange(0, len(samples), rate / 16000), np.arange(len(samples)), samples).astype(np.float32)
            rate = 16000
        try:
            return str(self._model.recognize(samples, sample_rate=rate)).strip()
        except Exception as failed:
            print(f"qwen3: could not hear a sentence back, {type(failed).__name__}: {failed}", file=sys.stderr, flush=True)
            return None


def said(speak, rate, ear, sentence: str, script: str, language: str):
    """The samples of `sentence` and what was heard of them, `{"script", "heard"}` with
    `"stumbled"` and `"misheard"` where they apply; made again while the voice runs on to its last
    frame or stumbles, and the take that differs least from `script` is kept."""
    frames = frames_for(sentence)
    best = None
    for attempt in range(1, ATTEMPTS + 1):
        samples = speak(sentence, language, frames)
        if len(samples) >= (frames - 1) * rate() / FRAMES_PER_SECOND:
            print(f"qwen3: ran on to {frames / FRAMES_PER_SECOND:.0f} s in attempt {attempt}: {sentence}", file=sys.stderr, flush=True)
            continue
        heard = ear.hear(samples, rate())
        if heard is None:
            # the recognition failed on this take: the best one heard so far, else this one unheard
            if best:
                break
            return samples, {"script": script, "heard": None}
        off = differing(script, heard, language)
        if best is None or off < best[0]:
            best = (off, samples, heard)
        if off < STUMBLE_LETTERS:
            break
        print(f"qwen3: stumbled in attempt {attempt}, {off} letters differ: {script} → heard: {heard}", file=sys.stderr, flush=True)
    if best is None:
        raise ValueError(f"the voice ran on {ATTEMPTS} times in a row, without ending the sentence; it may stumble over a word in it, which a respelling in lexicon.qwen3.<language>.json helps with: {sentence}")
    off, samples, heard = best
    report = {"script": script, "heard": heard}
    if off >= STUMBLE_LETTERS:
        report["stumbled"] = True
    elif words := misheard(script, heard, language):
        report["misheard"] = words
    return samples, report


def clip(speak, rate, ear, text: str, language: str, out: str, script: str | None = None, done=lambda n, of: None) -> list[dict]:
    """Writes the clip of `text` to `out`; what was heard of it, a line per sentence."""
    import numpy as np

    chunks, heard = [], []
    parts = sentences(text)
    # the script as written, sentence by sentence; a respelling that moved a sentence's end leaves the text as said
    scripts = sentences(script) if script else []
    if len(scripts) != len(parts):
        scripts = parts
    for n, (sentence, written) in enumerate(zip(parts, scripts), 1):
        samples, report = said(speak, rate, ear, sentence, written, language)
        chunks += [samples, np.zeros(int(SENTENCE_GAP_SECONDS * rate()), dtype=np.float32)]
        heard.append(report)
        done(n, len(parts))
    if not chunks:
        raise ValueError("nothing to say")
    write_wav(out, np.concatenate(chunks[:-1]), rate())
    return heard


def hearing(ear, heard: list[dict]) -> dict:
    """What a reply says of the hearing: each sentence (`"heard": null` for one that could not be
    heard), or why none was."""
    return {"unheard": ear.unheard} if ear.unheard else {"heard": heard}


def serve(args) -> None:
    # The protocol keeps the real stdout; everything else written there, Python or C, goes to stderr.
    protocol = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def answer(reply: dict) -> None:
        protocol.write(json.dumps(reply) + "\n")
        protocol.flush()

    speak, rate = load(args)
    ear = Ear()
    ear.load()
    answer({"ready": True})
    while line := sys.stdin.readline():
        if not line.strip():
            continue
        reply: dict = {}
        try:
            request = json.loads(line)
            reply = {"id": request["id"]} if "id" in request else {}
            language = request.get("language") or args.language
            if language not in LANGUAGES:
                raise ValueError(f"unknown language {language!r}; known: {', '.join(LANGUAGES)}")
            started = time.monotonic()
            heard = clip(speak, rate, ear, request["text"], language, request["out"], request.get("script"), lambda n, of: answer({"sentence": n, "of": of, **reply}))
            reply |= {"ok": True, "seconds": round(time.monotonic() - started, 2), **hearing(ear, heard)}
        except Exception as failed:  # a bad request or a failed generation; the model stays loaded
            reply |= {"error": f"{type(failed).__name__}: {failed}"[:600]}
        try:
            answer(reply)
        except BrokenPipeError:
            # whoever asked went away before the clip was done (Obeya stopped or restarted): nobody
            # is left to tell, and closing the protocol at exit would fail on the closed pipe once more
            os._exit(0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", required=True, choices=sorted(LANGUAGES))
    parser.add_argument("--speaker")
    parser.add_argument("--reference")
    parser.add_argument("--out")
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()
    if args.serve:
        sys.stdin.reconfigure(encoding="utf-8")
        serve(args)
        return
    if not args.out:
        parser.error("--out or --serve is required")
    text = sys.stdin.read()
    speak, rate = load(args)
    ear = Ear()
    ear.load()
    try:
        heard = clip(speak, rate, ear, text, args.language, args.out)
    except ValueError as failed:
        sys.exit(str(failed))
    print(json.dumps(hearing(ear, heard), ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":
    main()
