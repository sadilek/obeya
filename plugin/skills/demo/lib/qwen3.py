"""One narration clip with Qwen3-TTS: the text on stdin, a WAV out.

Runs in the environment Obeya installs for the voice (`voices.ts`): MLX through mlx-audio on
Apple Silicon, PyTorch through qwen-tts elsewhere.

    python qwen3.py --model <repo> --language de (--speaker ryan | --reference clip.wav) --out x.wav

A stock speaker comes from a CustomVoice model; `--reference` clones a clip with a Base model,
conditioned on its exact transcript in the `.txt` beside it. The clip must start and end inside a
pause: the model continues the reference, and a cut in the middle of a word made every clip start
with a noise. Sentence by sentence, since the model drifts on long inputs; a short gap between
them reads as a natural breath.
"""

from __future__ import annotations

import argparse
import re
import sys
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", required=True, choices=sorted(LANGUAGES))
    parser.add_argument("--speaker")
    parser.add_argument("--reference")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    text = sys.stdin.read()
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
        rate = model.sample_rate

        def speak(sentence: str):
            kwargs = {"lang_code": LANGUAGES[args.language]}
            if args.reference:
                kwargs |= {"ref_audio": args.reference, "ref_text": ref_text}
            else:
                kwargs["voice"] = args.speaker
            return np.concatenate([np.array(s.audio) for s in model.generate(text=sentence, **kwargs)])
    else:
        import torch
        from qwen_tts import Qwen3TTSModel

        device = "cuda:0" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
        model = Qwen3TTSModel.from_pretrained(args.model, device_map=device, dtype=torch.bfloat16)
        language = LANGUAGES[args.language].capitalize()
        rate = 24000

        def speak(sentence: str):
            nonlocal rate
            if args.reference:
                wavs, rate = model.generate_voice_clone(text=sentence, language=language, ref_audio=args.reference, ref_text=ref_text)
            else:
                wavs, rate = model.generate_custom_voice(text=sentence, language=language, speaker=args.speaker)
            return np.asarray(wavs[0], dtype=np.float32)

    chunks = []
    for sentence in sentences(text):
        samples = speak(sentence)
        chunks += [samples, np.zeros(int(SENTENCE_GAP_SECONDS * rate), dtype=np.float32)]
    if not chunks:
        sys.exit("nothing to say")
    write_wav(args.out, np.concatenate(chunks[:-1]), rate)


if __name__ == "__main__":
    main()
