"""Piper speech for Obeya's confirmations off the Mac, one process that keeps the voice loaded.

Usage: python piper_sidecar.py <voice.onnx> (the Python of Piper's environment under Obeya's home,
which the settings sheet installs; the voice's .onnx.json beside it).
Reads JSON lines on stdin: {"id": ..., "text": "...", "path": "<wav to write>"}.
Writes JSON lines on stdout: {"id": ...} once the WAV is written, or {"id": ..., "error": "..."}.
The voice is loaded and warmed up on a word before "ready", so the first confirmation is as quick
as the rest.
"""

import json
import os
import sys
import tempfile
import wave

from piper import PiperVoice


def speak(voice: PiperVoice, text: str, path: str) -> None:
    with wave.open(path, "wb") as out:
        voice.synthesize_wav(text, out)


def main() -> None:
    voice = PiperVoice.load(sys.argv[1])
    warm = os.path.join(tempfile.mkdtemp(prefix="obeya-piper-"), "warm.wav")
    speak(voice, "Ok.", warm)
    os.remove(warm)
    os.rmdir(os.path.dirname(warm))
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        job = json.loads(line)
        try:
            speak(voice, job["text"], job["path"])
            print(json.dumps({"id": job["id"]}), flush=True)
        except Exception as e:  # one sentence that fails must not take the voice down
            print(json.dumps({"id": job["id"], "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
