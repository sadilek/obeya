"""Whisper (MLX) transcription for Obeya, one process that keeps the model loaded.

Reads JSON lines on stdin: {"id": ..., "path": "<audio file>", "prompt": "<vocabulary>"}.
Writes JSON lines on stdout: {"id": ..., "text": "..."} or {"id": ..., "error": "..."}.
Audio is decoded by ffmpeg, so any format the browser records (webm/opus, wav) works. The model is
loaded at start, before "ready". Each recording's length and level go to stderr (the server's log), so
a transcript that went wrong can be told from a recording without audible speech.
"""

import json
import os
import sys

import mlx_whisper
import numpy as np
from mlx_whisper.audio import SAMPLE_RATE, load_audio

MODEL = os.environ.get("OBEYA_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")


def main() -> None:
    # load the model and warm it up on a second of silence, so the first recording is as quick as the rest
    mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=MODEL, language="de")
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        job = json.loads(line)
        try:
            audio = np.array(load_audio(job["path"]))
            print(f"whisper: {len(audio) / SAMPLE_RATE:.1f} s, peak {dbfs(np.abs(audio).max(initial=0))}, "
                  f"rms {dbfs(np.sqrt(np.mean(audio ** 2)) if len(audio) else 0)}", file=sys.stderr, flush=True)
            result = mlx_whisper.transcribe(
                audio,
                path_or_hf_repo=MODEL,
                language="de",
                initial_prompt=job.get("prompt") or None,
                condition_on_previous_text=False,
            )
            text = " ".join(s["text"].strip() for s in result.get("segments", [])) or result.get("text", "").strip()
            print(json.dumps({"id": job["id"], "text": text.strip()}), flush=True)
        except Exception as e:  # one bad recording must not take the sidecar down
            print(json.dumps({"id": job["id"], "error": str(e)}), flush=True)


def dbfs(x: float) -> str:
    return f"{20 * np.log10(x):.0f} dBFS" if x > 0 else "silent"


if __name__ == "__main__":
    main()
