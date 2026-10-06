"""Whisper transcription for Obeya, one process that keeps the model loaded: mlx-whisper on Apple
Silicon, faster-whisper elsewhere (`--backend faster`: CUDA when there is a GPU, else int8 on the
CPU; a GPU without the CUDA libraries falls back to the CPU).

Reads JSON lines on stdin: {"id": ..., "path": "<audio file>", "prompt": "<vocabulary>"}.
Writes JSON lines on stdout: {"id": ..., "text": "...", "doubtful": bool} or {"id": ..., "error": "..."}.
Audio is decoded by ffmpeg (for both backends: faster-whisper's own decoder, PyAV, broke with
newer PyAV releases), so any format the browser records (webm/opus, wav) works. The model is
loaded at start, before "ready". Each recording's length and level go to stderr (the server's log), so
a transcript that went wrong can be told from a recording without audible speech. A recording whose
peak stays below QUIET_DBFS, or that holds no audio at all, gives an empty text without Whisper.

On a recording without speech, Whisper's no-speech probability stays at 0 with the card titles as
prompt, so it tells nothing; with speech in it, even quiet, noisy or short, Whisper transcribes
correctly and sure of its words. Whisper decodes once, at temperature 0. By default it decodes again at five higher temperatures when
a decode looks failed (a loop, or too unsure of its words); on a recording without speech each of
them looped as well, which took 3 to 6 seconds. "doubtful" is that same test, so the server can try
once more without the card titles instead.
"""

import argparse
import json
import math
import os
import subprocess
import sys

import numpy as np

SAMPLE_RATE = 16000
MODELS = {"mlx": "mlx-community/whisper-large-v3-turbo", "faster": "large-v3-turbo"}
# below this peak a working microphone delivers nothing, not even room noise (about -40 to -55 dBFS on
# the AT2020USB+), while speech peaks far above it: the recording is not transcribed, it has nothing to hear.
# Not higher: the recordings Whisper failed on in five days of log (presses of a second or two with room
# noise or a breath) peaked at -5 to -45 dBFS, among speech (-8 dBFS at the lowest); the two passes in the
# server already make them "nothing heard" or "not understood".
QUIET_DBFS = -60
# Whisper's own thresholds for a failed decode (its defaults for compression_ratio_threshold and logprob_threshold)
LOOPING, UNSURE = 2.4, -1.0


class Mlx:
    def __init__(self, model: str):
        import mlx_whisper

        self._whisper, self._model = mlx_whisper, model

    def transcribe(self, audio: np.ndarray, prompt: str | None) -> list[dict]:
        result = self._whisper.transcribe(
            audio,
            path_or_hf_repo=self._model,
            language="de",
            initial_prompt=prompt,
            condition_on_previous_text=False,
            temperature=0.0,
        )
        segments = result.get("segments", [])
        return segments or [{"text": result.get("text", "")}]


class Faster:
    def __init__(self, model: str):
        import ctranslate2

        self._name = model
        self._load("cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu")

    def _load(self, device: str) -> None:
        from faster_whisper import WhisperModel

        self._model = WhisperModel(self._name, device=device, compute_type="float16" if device == "cuda" else "int8")
        self.device = device
        print(f"whisper: faster-whisper {self._name} on the {device.upper()}", file=sys.stderr, flush=True)

    def transcribe(self, audio: np.ndarray, prompt: str | None) -> list[dict]:
        try:
            segments, _ = self._model.transcribe(
                audio,
                language="de",
                initial_prompt=prompt,
                condition_on_previous_text=False,
                temperature=0.0,
                beam_size=1,
            )
            return [{"text": s.text, "avg_logprob": s.avg_logprob, "compression_ratio": s.compression_ratio} for s in segments]
        except Exception:
            # a GPU without the CUDA libraries faster-whisper needs: the CPU hears as well, slower
            if self.device != "cuda":
                raise
            self._load("cpu")
            return self.transcribe(audio, prompt)


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument("--backend", choices=list(MODELS), default="mlx")
    backend = args.parse_args().backend
    model = os.environ.get("OBEYA_WHISPER_MODEL", MODELS[backend])
    whisper = Mlx(model) if backend == "mlx" else Faster(model)
    # load the model and warm it up on a second of silence, so the first recording is as quick as the rest
    whisper.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), None)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        job = json.loads(line)
        try:
            audio = load_audio(job["path"])
            peak = np.abs(audio).max(initial=0)
            quiet = peak < 10 ** (QUIET_DBFS / 20)
            print(f"whisper: {len(audio) / SAMPLE_RATE:.1f} s, peak {dbfs(peak)}, "
                  f"rms {dbfs(np.sqrt(np.mean(audio ** 2)) if len(audio) else 0)}"
                  f"{'; too quiet to transcribe' if quiet else ''}", file=sys.stderr, flush=True)
            if quiet:
                print(json.dumps({"id": job["id"], "text": "", "doubtful": False}), flush=True)
                continue
            segments = whisper.transcribe(audio, job.get("prompt") or None)
            text = " ".join(s["text"].strip() for s in segments)
            print(json.dumps({"id": job["id"], "text": text.strip(), "doubtful": any(map(doubtful, segments))}), flush=True)
        except Exception as e:  # one bad recording must not take the sidecar down
            print(json.dumps({"id": job["id"], "error": str(e)}), flush=True)


def load_audio(path: str) -> np.ndarray:
    """The recording as 16 kHz mono floats; empty for one without a single audio frame (a microphone that never started)."""
    pcm = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
        capture_output=True,
    )
    if pcm.returncode != 0 and not pcm.stdout:
        why = pcm.stderr.decode(errors="replace").strip()
        if "End of file" in why or "does not contain any stream" in why:
            return np.zeros(0, dtype=np.float32)
        raise RuntimeError(f"ffmpeg could not read the recording: {why}")
    return np.frombuffer(pcm.stdout, dtype=np.float32)


def doubtful(segment: dict) -> bool:
    """A decode Whisper would have tried again at a higher temperature (NaN: it wrote no words, only a mark)."""
    logprob = segment.get("avg_logprob", 0.0)
    return segment.get("compression_ratio", 0.0) > LOOPING or not math.isfinite(logprob) or logprob < UNSURE


def dbfs(x: float) -> str:
    return f"{20 * np.log10(x):.0f} dBFS" if x > 0 else "silent"


if __name__ == "__main__":
    main()
