// The shell's own recording, for the push-to-talk key in another app: a webview in the background,
// or a window that is closed, cannot be relied on to record. The default input device, opened while
// the key is held, its channels mixed to one; the recording becomes a 16-bit WAV, which the
// server's transcription reads like the page's recordings.
//
// OBEYA_PTT_CHECK=<wav>: instead of the microphone, each recording is that file (16-bit PCM), for
// scripts/check-ptt.ts.

use std::{
  sync::{
    atomic::{AtomicU32, Ordering},
    mpsc::{channel, Sender},
    Arc, Mutex,
  },
  thread,
};

use cpal::{
  traits::{DeviceTrait, HostTrait, StreamTrait},
  FromSample, SampleFormat, SizedSample, StreamConfig,
};

enum Command {
  Start,
  Stop(Sender<Option<Recording>>),
}

pub struct Recording {
  pub samples: Vec<f32>,
  pub rate: u32,
}

impl Recording {
  pub fn seconds(&self) -> f32 {
    self.samples.len() as f32 / self.rate as f32
  }

  /// Mono 16-bit PCM in a WAV file.
  pub fn wav(&self) -> Vec<u8> {
    let n = self.samples.len() as u32;
    let mut out = Vec::with_capacity(44 + 2 * n as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + 2 * n).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&self.rate.to_le_bytes());
    out.extend_from_slice(&(self.rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(2 * n).to_le_bytes());
    for s in &self.samples {
      out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
  }
}

/// The microphone, on a thread of its own (an audio stream stays on the thread that made it).
pub struct Mic {
  commands: Sender<Command>,
  /// The level of the last chunk (RMS, 0–1) and the loudest sample so far, as f32 bits.
  level: Arc<AtomicU32>,
  peak: Arc<AtomicU32>,
}

impl Mic {
  pub fn new() -> Self {
    let check = std::env::var("OBEYA_PTT_CHECK").ok().filter(|c| c != "keyboard").and_then(|f| std::fs::read(f).ok()).and_then(|b| read_wav(&b));
    let (commands, rx) = channel::<Command>();
    let level = Arc::new(AtomicU32::new(0));
    let peak = Arc::new(AtomicU32::new(0));
    let (lvl, pk) = (level.clone(), peak.clone());
    thread::spawn(move || {
      let mut open: Option<(cpal::Stream, Arc<Mutex<Vec<f32>>>, u32)> = None;
      for command in rx {
        match command {
          Command::Start if check.is_some() => {}
          Command::Stop(reply) if check.is_some() => {
            let (samples, rate) = check.clone().unwrap();
            let _ = reply.send(Some(Recording { samples, rate }));
          }
          Command::Start => {
            lvl.store(0, Ordering::SeqCst);
            pk.store(0, Ordering::SeqCst);
            open = match start(lvl.clone(), pk.clone()) {
              Ok(o) => Some(o),
              Err(e) => {
                eprintln!("push-to-talk: no microphone: {e}");
                None
              }
            };
          }
          Command::Stop(reply) => {
            let recording = open.take().map(|(stream, samples, rate)| {
              drop(stream);
              let samples = std::mem::take(&mut *samples.lock().unwrap());
              Recording { samples, rate }
            });
            let _ = reply.send(recording);
          }
        }
      }
    });
    Mic { commands, level, peak }
  }

  pub fn start(&self) {
    let _ = self.commands.send(Command::Start);
  }

  /// Ends the recording; `None` when the microphone could not be opened.
  pub fn stop(&self) -> Option<Recording> {
    let (tx, rx) = channel();
    let _ = self.commands.send(Command::Stop(tx));
    rx.recv().ok().flatten()
  }

  pub fn level(&self) -> f32 {
    f32::from_bits(self.level.load(Ordering::SeqCst))
  }

  pub fn peak(&self) -> f32 {
    f32::from_bits(self.peak.load(Ordering::SeqCst))
  }
}

type Open = (cpal::Stream, Arc<Mutex<Vec<f32>>>, u32);

fn start(level: Arc<AtomicU32>, peak: Arc<AtomicU32>) -> Result<Open, String> {
  let device = cpal::default_host().default_input_device().ok_or("no input device")?;
  let supported = device.default_input_config().map_err(|e| e.to_string())?;
  let config: StreamConfig = supported.config();
  let samples = Arc::new(Mutex::new(Vec::new()));
  let stream = match supported.sample_format() {
    SampleFormat::F32 => build::<f32>(&device, &config, samples.clone(), level, peak),
    SampleFormat::I16 => build::<i16>(&device, &config, samples.clone(), level, peak),
    SampleFormat::I32 => build::<i32>(&device, &config, samples.clone(), level, peak),
    SampleFormat::U16 => build::<u16>(&device, &config, samples.clone(), level, peak),
    SampleFormat::U8 => build::<u8>(&device, &config, samples.clone(), level, peak),
    other => return Err(format!("sample format {other} not supported")),
  }?;
  stream.play().map_err(|e| e.to_string())?;
  Ok((stream, samples, config.sample_rate.0))
}

fn build<T: SizedSample + Send + 'static>(
  device: &cpal::Device,
  config: &StreamConfig,
  samples: Arc<Mutex<Vec<f32>>>,
  level: Arc<AtomicU32>,
  peak: Arc<AtomicU32>,
) -> Result<cpal::Stream, String>
where
  f32: FromSample<T>,
{
  let channels = config.channels as usize;
  device
    .build_input_stream(
      config,
      move |data: &[T], _| {
        let mut out = samples.lock().unwrap();
        let (mut sum, mut loudest) = (0.0f32, f32::from_bits(peak.load(Ordering::Relaxed)));
        for frame in data.chunks(channels) {
          let x = frame.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / channels as f32;
          sum += x * x;
          loudest = loudest.max(x.abs());
          out.push(x);
        }
        let frames = (data.len() / channels).max(1) as f32;
        level.store((sum / frames).sqrt().to_bits(), Ordering::Relaxed);
        peak.store(loudest.to_bits(), Ordering::Relaxed);
      },
      |e| eprintln!("push-to-talk: microphone: {e}"),
      None,
    )
    .map_err(|e| e.to_string())
}

/// A 16-bit PCM WAV's samples, its channels mixed to one, and its rate.
fn read_wav(b: &[u8]) -> Option<(Vec<f32>, u32)> {
  let u16_at = |i: usize| Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?));
  let u32_at = |i: usize| Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?));
  let (mut at, mut format) = (12, None);
  while at + 8 <= b.len() {
    let size = u32_at(at + 4)? as usize;
    match &b[at..at + 4] {
      b"fmt " => format = Some((u16_at(at + 10)? as usize, u32_at(at + 12)?, u16_at(at + 22)?)),
      b"data" => {
        let (channels, rate, bits) = format?;
        if bits != 16 {
          return None;
        }
        let data = b.get(at + 8..(at + 8 + size).min(b.len()))?;
        let samples = data
          .chunks_exact(2 * channels)
          .map(|f| f.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0).sum::<f32>() / channels as f32)
          .collect();
        return Some((samples, rate));
      }
      _ => {}
    }
    at += 8 + size + size % 2;
  }
  None
}
