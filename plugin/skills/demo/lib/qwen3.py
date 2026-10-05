"""Narration clips with Qwen3-TTS: one clip, or as many as asked while the model stays loaded.

Runs in the environment Obeya installs for the voice (`voices.ts`): MLX through mlx-audio on
Apple Silicon, PyTorch through qwen-tts elsewhere.

    python qwen3.py --model <repo> --language de (--speaker ryan | --reference clip.wav) --out x.wav
    python qwen3.py --model <repo> --language de (--speaker ryan | --reference clip.wav) --serve

With `--out`, the text comes on stdin and one WAV goes out. With `--serve`, the model, the
reference and its transcript load once and the process answers requests until its stdin ends,
one JSON object per line each way (what `tts.py` speaks with a voice whose spec has `serve`):

    → {"ready": true}                                      once the model is loaded
    ← {"text": "...", "out": "/x/clip.wav", "language": "de", "id": 7}   language, id optional
    → {"ok": true, "seconds": 4.2, "id": 7}  or  {"error": "...", "id": 7}

stdout carries nothing but these lines: the libraries print there too, so their output is moved
to stderr before they load.

A stock speaker comes from a CustomVoice model; `--reference` clones a clip with a Base model,
conditioned on its exact transcript in the `.txt` beside it. The clip must start and end inside a
pause: the model continues the reference, and a cut in the middle of a word made every clip start
with a noise. Sentence by sentence, since the model drifts on long inputs; a short gap between
them reads as a natural breath.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import wave
from pathlib import Path

SENTENCE_GAP_SECONDS = 0.28
LANGUAGES = {"de": "german", "en": "english"}


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
    """The model, ready to speak: `speak(sentence, language)` gives the samples, `rate()` their rate."""
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

        def speak(sentence: str, language: str):
            kwargs = {"lang_code": LANGUAGES[language]}
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

    def speak(sentence: str, language: str):
        nonlocal rate
        if args.reference:
            wavs, rate = model.generate_voice_clone(text=sentence, language=LANGUAGES[language].capitalize(), ref_audio=args.reference, ref_text=ref_text)
        else:
            wavs, rate = model.generate_custom_voice(text=sentence, language=LANGUAGES[language].capitalize(), speaker=args.speaker)
        return np.asarray(wavs[0], dtype=np.float32)

    return speak, lambda: rate


def clip(speak, rate, text: str, language: str, out: str) -> None:
    import numpy as np

    chunks = []
    for sentence in sentences(text):
        samples = speak(sentence, language)
        chunks += [samples, np.zeros(int(SENTENCE_GAP_SECONDS * rate()), dtype=np.float32)]
    if not chunks:
        raise ValueError("nothing to say")
    write_wav(out, np.concatenate(chunks[:-1]), rate())


def serve(args) -> None:
    # The protocol keeps the real stdout; everything else written there, Python or C, goes to stderr.
    protocol = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def answer(reply: dict) -> None:
        protocol.write(json.dumps(reply) + "\n")
        protocol.flush()

    speak, rate = load(args)
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
            clip(speak, rate, request["text"], language, request["out"])
            reply |= {"ok": True, "seconds": round(time.monotonic() - started, 2)}
        except Exception as failed:  # a bad request or a failed generation; the model stays loaded
            reply |= {"error": f"{type(failed).__name__}: {failed}"[:600]}
        answer(reply)


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
    try:
        clip(speak, rate, text, args.language, args.out)
    except ValueError as failed:
        sys.exit(str(failed))


if __name__ == "__main__":
    main()
