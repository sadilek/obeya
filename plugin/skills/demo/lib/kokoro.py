"""Narration clips with Kokoro-82M, for English narration: one clip per run, the text on stdin.

Runs in the environment Obeya installs for the voice (`voices.ts`): ONNX Runtime on the CPU, the
same on every platform, without PyTorch. The model and its voices come from the Hugging Face cache,
where the installation put them.

    python kokoro.py --model <repo> --file onnx/model.onnx --voice af_heart --out x.wav

The text becomes phonemes with misaki, Kokoro's own English frontend (with espeak-ng for words its
dictionary lacks). The model reads at most `MAX_PHONEMES` at a time, so a longer text goes in
sentence by sentence, as many sentences as fit, and the parts are joined as they come: each ends
with the model's own pause.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import wave
from pathlib import Path

SAMPLE_RATE = 24000
#: The model's context: 512 tokens, two of them the pads around the phonemes.
MAX_PHONEMES = 510
STYLE_DIM = 256
#: A sentence ends at a full stop, question or exclamation mark, colon or semicolon before a space.
SENTENCE_END = re.compile(r"(?<=[.!?;:])\s+")
#: espeak-ng opens its data by paths of under 160 characters (its `phontab` among them) and takes a
#: longer one for missing: it then looks where it was built and ends the process. Found with a home
#: in a deep temporary directory: a data path of 150 characters worked, one of 156 did not.
ESPEAK_PATH_LIMIT = 150


def espeak_data(data: str) -> str:
    """espeak-ng's data where it can read it: where the package put it, or, under a path too long
    for it, a copy in the system's temporary directory, kept complete.

    Each clip makes the copy good again: macOS deletes files in its temporary directory that were
    not read for three days and leaves their directories, so a copy loses files over time. A file
    that is missing or differs from the package's is copied beside the copy and moved into place,
    so espeak-ng never reads a file half written, and clips that start at once each put the same
    file there."""
    if len(data) <= ESPEAK_PATH_LIMIT:
        return data
    temp = tempfile.gettempdir()
    copy = os.path.join(temp, "obeya-espeak-ng-data")
    for root, _dirs, files in os.walk(data):
        target = os.path.normpath(os.path.join(copy, os.path.relpath(root, data)))
        os.makedirs(target, exist_ok=True)
        for name in files:
            source, placed = os.path.join(root, name), os.path.join(target, name)
            if same_file(source, placed):
                continue
            fd, part = tempfile.mkstemp(prefix="obeya-espeak-", dir=temp)
            os.close(fd)
            try:
                shutil.copy2(source, part)
                os.replace(part, placed)
            except OSError:
                # Windows refuses to replace a file another clip has open: fine once that clip put it there
                if not same_file(source, placed):
                    raise
            finally:
                if os.path.exists(part):
                    os.remove(part)
    return copy


def same_file(source: str, placed: str) -> bool:
    """Whether the copy holds the package's file as it is: same size and time."""
    try:
        a, b = os.stat(source), os.stat(placed)
    except FileNotFoundError:
        return False
    return a.st_size == b.st_size and int(a.st_mtime) == int(b.st_mtime)


def chunks(phonemes: list[str]) -> list[str]:
    """The sentences' phonemes, joined into as few parts within `MAX_PHONEMES` as they fit in;
    a sentence longer than that is cut at its last space before the limit."""
    parts: list[str] = []
    for ps in phonemes:
        while len(ps) > MAX_PHONEMES:
            cut = ps.rfind(" ", 0, MAX_PHONEMES)
            cut = cut if cut > 0 else MAX_PHONEMES
            parts.append(ps[:cut])
            ps = ps[cut:].strip()
        if parts and len(parts[-1]) + 1 + len(ps) <= MAX_PHONEMES:
            parts[-1] = f"{parts[-1]} {ps}"
        elif ps:
            parts.append(ps)
    return parts


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="the Hugging Face repository of the ONNX model")
    ap.add_argument("--file", required=True, help="the model's file in that repository")
    ap.add_argument("--voice", required=True)
    ap.add_argument("--british", action="store_true", help="British English pronunciation (the b… voices)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    text = sys.stdin.read().strip()

    import numpy as np
    import onnxruntime as ort
    import espeakng_loader
    from huggingface_hub import hf_hub_download
    from huggingface_hub.errors import LocalEntryNotFoundError
    from misaki import en, espeak
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    # misaki points espeak-ng at the package's data on import; under a long path, at a copy
    EspeakWrapper.set_data_path(espeak_data(espeakng_loader.get_data_path()))

    def cached(name: str) -> Path:
        try:
            return Path(hf_hub_download(args.model, name, local_files_only=True))
        except LocalEntryNotFoundError:
            sys.exit(f"Kokoro: {name} of {args.model} is not installed (a voice name Kokoro does not have?)")

    vocab: dict[str, int] = json.loads(cached("tokenizer.json").read_text(encoding="utf-8"))["model"]["vocab"]
    pack = np.fromfile(cached(f"voices/{args.voice}.bin"), dtype=np.float32).reshape(-1, 1, STYLE_DIM)
    g2p = en.G2P(trf=False, british=args.british, fallback=espeak.EspeakFallback(british=args.british))
    options = ort.SessionOptions()
    options.log_severity_level = 3
    session = ort.InferenceSession(str(cached(args.file)), options, providers=["CPUExecutionProvider"])

    sentences = [s for s in SENTENCE_END.split(text) if s.strip()]
    audio = []
    for ps in chunks([g2p(s)[0] for s in sentences]):
        ids = [vocab[p] for p in ps if p in vocab]
        if not ids:
            continue
        wav = session.run(None, {
            "input_ids": np.array([[0, *ids, 0]], dtype=np.int64),
            # the voice holds a style per length of input
            "style": pack[min(len(ids), len(pack)) - 1],
            "speed": np.array([1.0], dtype=np.float32),
        })[0]
        audio.append(np.asarray(wav, dtype=np.float32).reshape(-1))
    if not audio:
        sys.exit("Kokoro: nothing to say in this text")
    pcm = (np.clip(np.concatenate(audio), -1, 1) * 32767).astype("<i2")
    with wave.open(args.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    main()
