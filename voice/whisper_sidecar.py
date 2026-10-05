"""Whisper (MLX) transcription for Obeya, one process that keeps the model loaded.

Reads JSON lines on stdin: {"id": ..., "path": "<audio file>", "prompt": "<vocabulary>"}.
Writes JSON lines on stdout: {"id": ..., "text": "...", "doubtful": bool} or {"id": ..., "error": "..."}.
Audio is decoded by ffmpeg, so any format the browser records (webm/opus, wav) works. The model is
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

import json
import math
import os
import sys

import mlx_whisper
import numpy as np
from mlx_whisper.audio import SAMPLE_RATE, load_audio

MODEL = os.environ.get("OBEYA_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
# below this peak a working microphone delivers nothing, not even room noise (about -40 to -55 dBFS on
# the AT2020USB+), while speech peaks far above it: the recording is not transcribed, it has nothing to hear.
# Not higher: the recordings Whisper failed on in five days of log (presses of a second or two with room
# noise or a breath) peaked at -5 to -45 dBFS, among speech (-8 dBFS at the lowest); the two passes in the
# server already make them "nothing heard" or "not understood".
QUIET_DBFS = -60
# Whisper's own thresholds for a failed decode (its defaults for compression_ratio_threshold and logprob_threshold)
LOOPING, UNSURE = 2.4, -1.0


def main() -> None:
    # load the model and warm it up on a second of silence, so the first recording is as quick as the rest
    mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=MODEL, language="de", temperature=0.0)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        job = json.loads(line)
        try:
            try:
                audio = np.array(load_audio(job["path"]))
            except RuntimeError as e:
                # ffmpeg's word for a recording without a single audio frame (a microphone that never started)
                if "End of file" not in str(e):
                    raise
                audio = np.zeros(0, dtype=np.float32)
            peak = np.abs(audio).max(initial=0)
            quiet = peak < 10 ** (QUIET_DBFS / 20)
            print(f"whisper: {len(audio) / SAMPLE_RATE:.1f} s, peak {dbfs(peak)}, "
                  f"rms {dbfs(np.sqrt(np.mean(audio ** 2)) if len(audio) else 0)}"
                  f"{'; too quiet to transcribe' if quiet else ''}", file=sys.stderr, flush=True)
            if quiet:
                print(json.dumps({"id": job["id"], "text": "", "doubtful": False}), flush=True)
                continue
            result = mlx_whisper.transcribe(
                audio,
                path_or_hf_repo=MODEL,
                language="de",
                initial_prompt=job.get("prompt") or None,
                condition_on_previous_text=False,
                temperature=0.0,
            )
            segments = result.get("segments", [])
            text = " ".join(s["text"].strip() for s in segments) or result.get("text", "").strip()
            print(json.dumps({"id": job["id"], "text": text.strip(), "doubtful": any(map(doubtful, segments))}), flush=True)
        except Exception as e:  # one bad recording must not take the sidecar down
            print(json.dumps({"id": job["id"], "error": str(e)}), flush=True)


def doubtful(segment: dict) -> bool:
    """A decode Whisper would have tried again at a higher temperature (NaN: it wrote no words, only a mark)."""
    logprob = segment.get("avg_logprob", 0.0)
    return segment.get("compression_ratio", 0.0) > LOOPING or not math.isfinite(logprob) or logprob < UNSURE


def dbfs(x: float) -> str:
    return f"{20 * np.log10(x):.0f} dBFS" if x > 0 else "silent"


if __name__ == "__main__":
    main()
