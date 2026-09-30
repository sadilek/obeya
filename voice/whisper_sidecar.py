"""Whisper (MLX) transcription for Obeya, one process that keeps the model loaded.

Reads JSON lines on stdin: {"id": ..., "path": "<audio file>", "prompt": "<vocabulary>"}.
Writes JSON lines on stdout: {"id": ..., "text": "..."} or {"id": ..., "error": "..."}.
Audio is decoded by ffmpeg, so any format the browser records (webm/opus, wav) works.
"""

import json
import os
import sys

import mlx_whisper

MODEL = os.environ.get("OBEYA_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")


def main() -> None:
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        job = json.loads(line)
        try:
            result = mlx_whisper.transcribe(
                job["path"],
                path_or_hf_repo=MODEL,
                language="de",
                initial_prompt=job.get("prompt") or None,
                condition_on_previous_text=False,
            )
            text = " ".join(s["text"].strip() for s in result.get("segments", [])) or result.get("text", "").strip()
            print(json.dumps({"id": job["id"], "text": text.strip()}), flush=True)
        except Exception as e:  # one bad recording must not take the sidecar down
            print(json.dumps({"id": job["id"], "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
