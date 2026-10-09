// Push-to-talk anywhere on the machine: the owner holds the key (keys.rs) while another app is in
// front, speaks, and lets go; the shell records (mic.rs) and posts the recording to the canvas's
// `/voice` as the page does, with where the owner was last in a page (`GET /api/focus`).
//
// - A tap does nothing: only holding the key past 0.3 s records, and another key going down while
//   it is held makes it a shortcut, which is not recorded either. The microphone opens when the
//   key goes down, so the first words are not lost.
// - A floating panel at the bottom of the screen the pointer is on (`/panel` of the server, which
//   has the UI's strings) shows that Obeya listens and to whom, then what it heard, the
//   confirmation and "Rückgängig" while the command waits, and plays the spoken confirmation. The
//   panel fits the window to its lines and hides it when none are left (the `panel` command).
// - Every two seconds the shell tells the server what it hears (the settings and the setup
//   assistant show it) and gets the key that applies, which the settings may have changed.
// - OBEYA_PTT_CHECK=<wav> (scripts/check-ptt.ts): the key is read from stdin, a line `down`, `up`
//   or `other` each, and the recording is that file (mic.rs); nothing listens to the keyboard.
//   OBEYA_PTT_CHECK=keyboard: the keyboard and the microphone as they are. Either way the shell
//   prints what the check reads: `call <what the panel is told>`, `panel <height>`, `sent <HTTP
//   status>` and `heard <answer>`.

use std::{
  sync::{
    atomic::Ordering,
    mpsc::{channel, Receiver, RecvTimeoutError},
    Arc,
  },
  thread,
  time::{Duration, Instant},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{
  keys::{self, Key, Keys},
  mic::{Mic, Recording},
  Obeya,
};

/// Held this long, the key records; a shorter press is a tap.
const HOLD: Duration = Duration::from_millis(300);
/// A recording this short is no command (as in the page).
const SHORTEST: f32 = 0.35;
/// The level stays below this (-60 dBFS) this long: the microphone delivers nothing.
const QUIET: f32 = 0.001;
const FLAT: Duration = Duration::from_millis(1500);
const PANEL_WIDTH: f64 = 560.0;

pub fn start(app: &AppHandle, obeya: Arc<Obeya>) {
  let (tx, rx) = channel();
  let check = std::env::var("OBEYA_PTT_CHECK").is_ok_and(|c| c != "keyboard");
  if check {
    let tx = tx.clone();
    thread::spawn(move || {
      for line in std::io::stdin().lines().map_while(Result::ok) {
        let _ = tx.send(match line.trim() {
          "down" => Key::Down,
          "up" => Key::Up,
          _ => Key::Other,
        });
      }
    });
  }
  let keys = Keys::new(app.clone(), tx, check);
  let (a, o) = (app.clone(), obeya.clone());
  thread::spawn(move || report(a, o, keys));
  let a = app.clone();
  thread::spawn(move || run(a, obeya, rx));
}

fn base(port: u16) -> String {
  format!("http://127.0.0.1:{port}")
}

fn get(port: u16, path: &str) -> Option<Value> {
  let res = ureq::get(&format!("{}{path}", base(port))).timeout(Duration::from_secs(2)).call().ok()?;
  serde_json::from_str(&res.into_string().ok()?).ok()
}

pub(crate) fn post(port: u16, path: &str, body: &Value) -> Option<Value> {
  let res = ureq::post(&format!("{}{path}", base(port)))
    .timeout(Duration::from_secs(2))
    .set("content-type", "application/json")
    .send_string(&body.to_string())
    .ok()?;
  Some(serde_json::from_str(&res.into_string().ok()?).unwrap_or(Value::Null))
}

/// Tells the server what the shell hears, and listens for the key that applies.
fn report(app: AppHandle, obeya: Arc<Obeya>, keys: Arc<Keys>) {
  let mut first = true;
  loop {
    let port = obeya.port.load(Ordering::SeqCst);
    if port != 0 {
      if first {
        // an Obeya without the key setting (an older version) gets no key and no panel
        if let Some(key) = get(port, "/api/push-to-talk").and_then(|v| v["key"].as_str().map(String::from)) {
          keys.listen(&key);
          make_panel(&app, port);
          first = false;
        }
      }
      if !first {
        let h = keys.hearing();
        let body = json!({ "state": h.state, "platform": std::env::consts::OS, "session": keys::session(), "detail": h.detail });
        if let Some(key) = post(port, "/api/push-to-talk/shell", &body).and_then(|v| v["key"].as_str().map(String::from)) {
          keys.listen(&key);
        }
      }
    }
    thread::sleep(Duration::from_secs(2));
  }
}

struct Press {
  at: Instant,
  port: u16,
  /// Where the owner was last (`GET /api/focus`).
  focus: Value,
  listening: bool,
}

/// What the keys do: record while held, then send.
fn run(app: AppHandle, obeya: Arc<Obeya>, keys: Receiver<Key>) {
  let mic = Mic::new();
  let mut pressed: Option<Press> = None;
  let mut sent = 0u64;
  loop {
    let wait = match &pressed {
      Some(p) if !p.listening => HOLD.saturating_sub(p.at.elapsed()),
      Some(_) => Duration::from_millis(60),
      None => Duration::from_secs(3600),
    };
    match keys.recv_timeout(wait) {
      Ok(Key::Down) if pressed.is_none() => {
        let port = obeya.port.load(Ordering::SeqCst);
        if port == 0 {
          continue;
        }
        mic.start();
        let focus = get(port, "/api/focus").unwrap_or(Value::Null);
        if let Some(canvas) = focus["canvas"].as_str() {
          // transcription, speech and the Koordinator get ready while the owner speaks
          let path = format!("/api/c/{}/voice/warm", encode(canvas));
          thread::spawn(move || post(port, &path, &Value::Null));
        }
        pressed = Some(Press { at: Instant::now(), port, focus, listening: false });
      }
      Ok(Key::Other) => {
        if let Some(p) = pressed.take() {
          mic.stop();
          if p.listening {
            panel(&app, "cancel()");
          }
        }
      }
      Ok(Key::Up) => {
        let Some(p) = pressed.take() else { continue };
        let recording = mic.stop();
        if !p.listening {
          continue;
        }
        match recording {
          Some(r) if r.seconds() >= SHORTEST && p.focus["canvas"].is_string() => {
            sent += 1;
            panel(&app, &format!("reading({sent}, {})", p.focus["title"]));
            let (a, id) = (app.clone(), sent);
            thread::spawn(move || send(&a, p.port, &p.focus, &r, id));
          }
          Some(_) => panel(&app, "cancel()"),
          None => {
            sent += 1;
            panel(&app, &format!("failed({sent})"));
          }
        }
      }
      Ok(Key::Down) => {}
      Err(RecvTimeoutError::Timeout) => {
        let Some(p) = &mut pressed else { continue };
        if !p.listening {
          p.listening = true;
          panel(&app, &format!("listen({})", p.focus["target"]));
        } else {
          let flat = p.at.elapsed() > FLAT && mic.peak() < QUIET;
          panel(&app, &format!("level({}, {flat})", (mic.level() * 6.0).min(1.0)));
        }
      }
      Err(RecvTimeoutError::Disconnected) => return,
    }
  }
}

/// Posts recording `id` and shows what Obeya made of it.
fn send(app: &AppHandle, port: u16, focus: &Value, recording: &Recording, id: u64) {
  let canvas = focus["canvas"].as_str().unwrap_or_default();
  let mut url = format!("{}/api/c/{}/voice", base(port), encode(canvas));
  if let Some(card) = focus["card"].as_str() {
    url += &format!("?card={}", encode(card));
  } else if let Some(project) = focus["project"].as_str() {
    url += &format!("?project={}", encode(project));
  }
  // a command answers once transcribed and read, which on a busy CPU takes a while
  let res = ureq::post(&url).timeout(Duration::from_secs(150)).set("content-type", "audio/wav").send_bytes(&recording.wav());
  let status = match &res {
    Ok(r) => r.status(),
    Err(ureq::Error::Status(code, _)) => *code,
    Err(_) => 0,
  };
  let heard = res.ok().and_then(|r| r.into_string().ok()).and_then(|s| serde_json::from_str::<Value>(&s).ok());
  if std::env::var_os("OBEYA_PTT_CHECK").is_some() {
    println!("sent {status}");
    println!("heard {}", heard.clone().unwrap_or(Value::Null));
  }
  match heard {
    Some(h) => panel(app, &format!("heard({id}, {}, {h})", Value::from(canvas))),
    None => panel(app, &format!("failed({id})")),
  }
}

fn encode(s: &str) -> String {
  s.bytes()
    .map(|b| match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
      _ => format!("%{b:02X}"),
    })
    .collect()
}

/// The panel's window, hidden until it has lines; its page comes from the server.
fn make_panel(app: &AppHandle, port: u16) {
  if app.get_webview_window("panel").is_some() {
    return;
  }
  let Ok(url) = Url::parse(&format!("{}/panel", base(port))) else { return };
  let built = WebviewWindowBuilder::new(app, "panel", WebviewUrl::External(url))
    .title("Obeya")
    .inner_size(PANEL_WIDTH, 80.0)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    // it never takes the keyboard from the app in front
    .focused(false)
    .focusable(false)
    .visible(false)
    .build();
  if let Err(e) = built {
    eprintln!("push-to-talk: no panel: {e}");
  }
}

fn panel(app: &AppHandle, call: &str) {
  if std::env::var_os("OBEYA_PTT_CHECK").is_some() {
    // the check (and a demo) can show the same lines elsewhere
    println!("call {call}");
  }
  if let Some(w) = app.get_webview_window("panel") {
    let _ = w.eval(format!("window.obeyaPanel?.{call}"));
  }
}

/// The panel's page: the window as tall as its lines, at the bottom of the screen the pointer is
/// on, or hidden with no lines left.
#[tauri::command]
pub fn panel_fit(window: WebviewWindow, height: f64) {
  if std::env::var_os("OBEYA_PTT_CHECK").is_some() {
    // what the check reads: the panel showed lines this tall (0: hidden)
    println!("panel {height}");
  }
  if height <= 0.0 {
    let _ = window.hide();
    return;
  }
  let monitor = window
    .cursor_position()
    .ok()
    .and_then(|p| window.monitor_from_point(p.x, p.y).ok().flatten())
    .or_else(|| window.primary_monitor().ok().flatten());
  let Some(m) = monitor else { return };
  let scale = m.scale_factor();
  let area = m.work_area();
  let (w, h) = ((PANEL_WIDTH * scale) as i32, (height * scale) as i32);
  let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
  let x = area.position.x + (area.size.width as i32 - w) / 2;
  let y = area.position.y + area.size.height as i32 - h - (16.0 * scale) as i32;
  let _ = window.set_position(PhysicalPosition::new(x, y));
  let _ = window.show();
}
