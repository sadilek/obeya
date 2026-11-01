"""The hero video's narration again in Qwen3-TTS, cloned from the owner's ElevenLabs voice, to compare the two.

Takes a rendered hero video (`render.ts`) as it is: its clips in `.work/` say where each narration
starts, the same text is spoken with Qwen3-TTS through the demo pipeline's `qwen3.py`, each clip goes
where the ElevenLabs one starts, and the track is evened out as the pipeline does (`director.ts`).
The reference is ten seconds of the ElevenLabs voice with their transcript beside them, in `.voice/`
of the main checkout (gitignored): `qwen-reference-en.wav` and `.txt`. Runs in the environment
Obeya installs for Qwen3-TTS (the settings sheet does that):

    ~/.obeya/voices/qwen3/env/bin/python scripts/hero-video/qwen.py

Writes `narration-qwen.wav` and `hero-qwen.mp4` into `qwen-vergleich/` beside the video
(`HERO_OUT`, else `obeya-hero` in the demo directory), with `hero-elevenlabs.mp4` as the original to compare.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import types
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "plugin" / "skills" / "demo" / "lib"))
import qwen3  # noqa: E402

MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
RATE = 24000
LOUDNESS = "loudnorm=I=-16:TP=-1.5"  # as the demo's mix in `director.ts`


def demo_directory() -> Path:
    """Where demos go: `directory` of the demo settings (`demo.json` in Obeya's home), else `~/demos`."""
    try:
        home = Path(os.environ.get("OBEYA_HOME") or Path.home() / ".obeya")
        given = json.loads((home / "demo.json").read_text()).get("directory", "")
    except (OSError, ValueError):
        given = ""
    path = Path(given.strip()).expanduser() if isinstance(given, str) and given.strip() else Path()
    return path if path.is_absolute() else Path.home() / "demos"


def main_checkout() -> Path:
    common = subprocess.run(["git", "-C", str(HERE), "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True, check=True)
    return Path(common.stdout.strip()).parent


def read(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768


def write(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


def starts(track: np.ndarray, clips: list[np.ndarray]) -> list[int]:
    """Where each clip lies in the video's track: the peak of their cross-correlation."""
    n = 1 << int(np.ceil(np.log2(len(track) * 2)))
    spectrum = np.fft.rfft(track, n)
    return [int(np.argmax(np.fft.irfft(spectrum * np.conj(np.fft.rfft(c, n)), n)[: len(track)])) for c in clips]


def main() -> None:
    hero = Path(os.environ.get("HERO_OUT") or demo_directory() / "obeya-hero")
    reference = main_checkout() / ".voice" / "qwen-reference-en.wav"
    if not reference.exists():
        sys.exit(f"no reference at {reference}")
    out = hero / "qwen-vergleich"
    (out / "clips").mkdir(parents=True, exist_ok=True)

    video = hero / "demo.mp4"
    ffmpeg("-i", str(video), "-vn", "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(out / "track.wav"))
    track = read(out / "track.wav")
    texts = {j["id"]: j["text"] for j in json.loads((hero / ".work" / "jobs.json").read_text())}
    jobs = json.loads((hero / ".work" / "tts.json").read_text())["clips"]
    at = starts(track, [read(Path(j["file"])) for j in jobs])

    speak, rate = qwen3.load(types.SimpleNamespace(model=MODEL, reference=str(reference), speaker=None))
    ear = qwen3.Ear()
    ear.load()
    mix = np.zeros(len(track), np.float32)
    for job, start in zip(jobs, at):
        # the audio tags are for ElevenLabs; the pipeline gives other voices the script without them
        text = re.sub(r"\s{2,}", " ", re.sub(r"\[[^\]]*\]", " ", texts[job["id"]])).strip()
        clip = out / "clips" / f"{job['id']}.wav"
        qwen3.clip(speak, rate, ear, text, "en", str(clip))
        samples = read(clip)[: len(mix) - start]
        mix[start : start + len(samples)] += samples
        print(f"{job['id']} at {start / RATE:6.2f} s: ElevenLabs {job['seconds']:5.1f} s, Qwen {len(samples) / RATE:5.1f} s", flush=True)

    write(out / "raw.wav", mix)
    ffmpeg("-i", str(out / "raw.wav"), "-af", LOUDNESS, "-ar", "48000", "-c:a", "pcm_s16le", str(out / "narration-qwen.wav"))
    ffmpeg("-i", str(video), "-i", str(out / "narration-qwen.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", str(out / "hero-qwen.mp4"))
    shutil.copy(video, out / "hero-elevenlabs.mp4")
    for scratch in ("track.wav", "raw.wav"):
        (out / scratch).unlink()
    print(f"→ {out / 'hero-qwen.mp4'}")


if __name__ == "__main__":
    main()
