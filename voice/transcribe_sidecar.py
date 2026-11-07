"""Speech recognition for Obeya, one process that keeps the model loaded. By default Parakeet TDT
0.6B v3 (`--backend parakeet`: NVIDIA's model as int8 ONNX, through onnx-asr and ONNX Runtime on the
CPU, on every platform); Whisper where `OBEYA_WHISPER_BACKEND` asks for it: mlx-whisper on Apple
Silicon (`--backend mlx`), faster-whisper elsewhere (`--backend faster`: CUDA when there is a GPU,
else int8 on the CPU; a GPU without the CUDA libraries falls back to the CPU).

Reads JSON lines on stdin: {"id": ..., "path": "<audio file>", "prompt": "<vocabulary>", "languages": ["de", "en"]}
(the languages the owner may speak; German when left out). Parakeet hears 25 European languages by
itself and takes no prompt: both are for Whisper. Whisper hears which of the languages is spoken in
the first 30 seconds and transcribes in that one: told a language the owner did not speak, it
translates into it, badly and unsure of its words (German speech, told English: „That is quite a bit
of a bit of a doubt“), and the longer the recording, the likelier one of its parts fails the test below.
faster-whisper decodes the first window from the encoder pass that heard the language (see Faster.languages).
Writes JSON lines on stdout: {"id": ..., "text": "...", "doubtful": bool} or {"id": ..., "error": "..."}.
Ends with its stdin, after the recording it is on; when Obeya is gone by then, quietly.
Audio is decoded by ffmpeg (for every backend: faster-whisper's own decoder, PyAV, broke with
newer PyAV releases), so any format the browser records (webm/opus, mp4, wav) works. The model is
loaded at start, before "ready". Each recording's length and level go to stderr (the server's log), so
a transcript that went wrong can be told from a recording without audible speech. A recording whose
peak stays below QUIET_DBFS, or that holds no audio at all, gives an empty text without recognition.

On a recording without speech, Whisper's no-speech probability stays at 0 with the card titles as
prompt, so it tells nothing; with speech in it, even quiet, noisy or short, Whisper transcribes
correctly and sure of its words. Whisper decodes once, at temperature 0. By default it decodes again at five higher temperatures when
a decode looks failed (a loop, or too unsure of its words); on a recording without speech each of
them looped as well, which took 3 to 6 seconds. "doubtful" is that same test, so the server can try
once more without the card titles instead. Parakeet neither loops nor makes up subtitle phrases on
silence, and gives no such score: its words are never doubtful.
"""

import argparse
import json
import math
import os
import signal
import subprocess
import sys

import numpy as np

SAMPLE_RATE = 16000
MODELS = {"parakeet": "nemo-parakeet-tdt-0.6b-v3", "mlx": "mlx-community/whisper-large-v3-turbo", "faster": "large-v3-turbo"}
# Parakeet's threads: on an M4 Pro's CPU an 8 s command took 0.15 s with 2, 0.09 s with 4 and 0.14 s
# with 8 (0.71 s with 12; measured 2026-10-14), so more than 4 only cost
THREADS = 4
# Parakeet attends to the whole recording at once, its memory growing with the length (1.8 GB of
# process for a minute): a longer dictation is heard in parts of at most this long, each cut in the
# quietest moment of its last CUT_WITHIN seconds, between words
LONGEST, CUT_WITHIN = 60.0, 20.0
# below this peak a working microphone delivers nothing, not even room noise (about -40 to -55 dBFS on
# the AT2020USB+), while speech peaks far above it: the recording is not transcribed, it has nothing to hear.
# Not higher: the recordings Whisper failed on in five days of log (presses of a second or two with room
# noise or a breath) peaked at -5 to -45 dBFS, among speech (-8 dBFS at the lowest); the two passes in the
# server already make them "nothing heard" or "not understood".
QUIET_DBFS = -60
# Whisper's own thresholds for a failed decode (its defaults for compression_ratio_threshold and logprob_threshold)
LOOPING, UNSURE = 2.4, -1.0


class Parakeet:
    def __init__(self, model: str):
        import onnx_asr
        import onnxruntime

        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = min(THREADS, os.cpu_count() or THREADS)
        options.inter_op_num_threads = 1
        self._model = onnx_asr.load_model(model, quantization="int8", sess_options=options, providers=["CPUExecutionProvider"])
        print(f"voice: Parakeet {model} on the CPU, {options.intra_op_num_threads} threads", file=sys.stderr, flush=True)

    def transcribe(self, audio: np.ndarray, prompt: str | None, language: str = "de") -> list[dict]:
        return [{"text": self._model.recognize(part, sample_rate=SAMPLE_RATE)} for part in parts(audio)]


def parts(audio: np.ndarray) -> list[np.ndarray]:
    """The recording in parts of at most LONGEST seconds, each cut where it is quietest near its end."""
    longest, within, frame = int(LONGEST * SAMPLE_RATE), int(CUT_WITHIN * SAMPLE_RATE), SAMPLE_RATE // 10
    out = []
    while len(audio) > longest:
        tail = audio[longest - within : longest]
        frames = tail[: len(tail) // frame * frame].reshape(-1, frame)
        cut = longest - within + int(np.argmin((frames**2).mean(axis=1))) * frame + frame // 2
        out.append(audio[:cut])
        audio = audio[cut:]
    return [*out, audio]


class Mlx:
    def __init__(self, model: str):
        import mlx_whisper

        self._whisper, self._model = mlx_whisper, model

    def languages(self, audio: np.ndarray) -> dict[str, float]:
        """How likely each language is spoken in the first 30 seconds, as Whisper's transcribe tells it without a language."""
        import mlx.core as mx
        from mlx_whisper.audio import N_FRAMES, N_SAMPLES, log_mel_spectrogram, pad_or_trim
        from mlx_whisper.transcribe import ModelHolder

        model = ModelHolder.get_model(self._model, mx.float16)
        mel = log_mel_spectrogram(audio[:N_SAMPLES], n_mels=model.dims.n_mels, padding=N_SAMPLES)
        _, probs = model.detect_language(pad_or_trim(mel, N_FRAMES, axis=-2).astype(mx.float16))
        return probs

    def transcribe(self, audio: np.ndarray, prompt: str | None, language: str = "de") -> list[dict]:
        result = self._whisper.transcribe(
            audio,
            path_or_hf_repo=self._model,
            language=language,
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
        self._encoded = None
        self._load("cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu")

    def _load(self, device: str) -> None:
        from faster_whisper import WhisperModel

        self._model = WhisperModel(self._name, device=device, compute_type="float16" if device == "cuda" else "int8")
        self.device = device
        print(f"whisper: faster-whisper {self._name} on the {device.upper()}", file=sys.stderr, flush=True)

    def languages(self, audio: np.ndarray) -> dict[str, float]:
        """How likely each language is spoken in the first 30 seconds. The encoder pass this takes is
        kept for transcribing the same recording, which decodes its first window from it: on a CPU
        that pass is as long as a short command's whole transcription."""
        from faster_whisper.audio import pad_or_trim

        model = self._model
        # the first window as transcribe cuts it from the features (without their last frame)
        features = model.feature_extractor(audio)
        window = pad_or_trim(features[:, : min(model.feature_extractor.nb_max_frames, features.shape[-1] - 1)])
        encoded = model.encode(window)
        self._encoded = (audio, encoded)
        return {token[2:-2]: p for token, p in model.model.detect_language(encoded)[0]}

    def transcribe(self, audio: np.ndarray, prompt: str | None, language: str = "de") -> list[dict]:
        encoded = self._encoded[1] if self._encoded and self._encoded[0] is audio else None
        self._encoded = None
        model = self._model
        if encoded is not None:
            # transcribe hands generate_segments no encoder output, so it would encode the first window again
            model.generate_segments = lambda features, tokenizer, options, log_progress, encoder_output=None: type(model).generate_segments(
                model, features, tokenizer, options, log_progress, encoded
            )
        try:
            segments, _ = model.transcribe(
                audio,
                language=language,
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
            return self.transcribe(audio, prompt, language)
        finally:
            model.__dict__.pop("generate_segments", None)


def answer(reply: dict) -> None:
    """A reply to Obeya on stdout. Obeya gone is a BrokenPipeError, on Windows too, where writing to the closed pipe fails with EINVAL."""
    try:
        print(json.dumps(reply), flush=True)
    except BrokenPipeError:
        raise
    except OSError as e:
        raise BrokenPipeError(e.errno, e.strerror) from e


def main() -> None:
    # Ctrl-C in Obeya's terminal is for Obeya, which ends the sidecar itself once it stops
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    args = argparse.ArgumentParser()
    args.add_argument("--backend", choices=list(MODELS), default="parakeet")
    backend = args.parse_args().backend
    model = os.environ.get("OBEYA_WHISPER_MODEL", MODELS[backend]) if backend != "parakeet" else MODELS[backend]
    ear = Parakeet(model) if backend == "parakeet" else Mlx(model) if backend == "mlx" else Faster(model)
    # load the model and warm it up on a second of silence, so the first recording is as quick as the rest
    ear.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), None)
    answer({"ready": True})
    for line in sys.stdin:
        if not line.strip():
            continue
        job = json.loads(line)
        try:
            audio = load_audio(job["path"])
            peak = np.abs(audio).max(initial=0)
            quiet = peak < 10 ** (QUIET_DBFS / 20)
            level = f"voice: {len(audio) / SAMPLE_RATE:.1f} s, peak {dbfs(peak)}, rms {dbfs(np.sqrt(np.mean(audio ** 2)) if len(audio) else 0)}"
            if quiet:
                print(f"{level}; too quiet to transcribe", file=sys.stderr, flush=True)
                answer({"id": job["id"], "text": "", "doubtful": False})
                continue
            if isinstance(ear, Parakeet):
                print(level, file=sys.stderr, flush=True)
                segments = ear.transcribe(audio, None)
            else:
                languages = job.get("languages") or ["de"]
                language, sure = spoken(ear, audio, languages)
                print(f"{level}, {language}{f' ({sure:.0%})' if len(languages) > 1 else ''}", file=sys.stderr, flush=True)
                segments = ear.transcribe(audio, job.get("prompt") or None, language)
            text = " ".join(s["text"].strip() for s in segments)
            answer({"id": job["id"], "text": text.strip(), "doubtful": any(map(doubtful, segments))})
        except BrokenPipeError:
            raise
        except Exception as e:  # one bad recording must not take the sidecar down
            answer({"id": job["id"], "error": str(e)})


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


def spoken(whisper: Mlx | Faster, audio: np.ndarray, languages: list[str]) -> tuple[str, float]:
    """The most likely of the languages, and how likely it is among them."""
    if len(languages) == 1:
        return languages[0], 1.0
    probs = whisper.languages(audio)
    language = max(languages, key=lambda l: probs.get(l, 0.0))
    total = sum(probs.get(l, 0.0) for l in languages)
    return language, probs.get(language, 0.0) / total if total > 0 else 0.0


def doubtful(segment: dict) -> bool:
    """A decode Whisper would have tried again at a higher temperature (NaN: it wrote no words, only a mark)."""
    logprob = segment.get("avg_logprob", 0.0)
    return segment.get("compression_ratio", 0.0) > LOOPING or not math.isfinite(logprob) or logprob < UNSURE


def dbfs(x: float) -> str:
    return f"{20 * np.log10(x):.0f} dBFS" if x > 0 else "silent"


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        # Obeya went away before it read the answer (stopped or restarted while the sidecar wrote): nobody
        # is left to tell, and Python's flush of stdout at exit would fail on the closed pipe once more
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
