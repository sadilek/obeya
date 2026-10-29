// Obeya as an app: a window on the canvas of the compiled server (`obeya-server`, a sidecar beside
// this program, built by scripts/build-app.ts), which the shell starts and stops.
//
// - One Obeya per home: when one runs on the home already ($OBEYA_HOME/server.json, written by the
//   server), the window opens on it instead of starting a second. Whoever started it (the app, or
//   `bun start` in a terminal), it stops when the app quits, and the app ends when it does.
// - The server picks no port of its own: 4417 ($OBEYA_PORT) when free, else one the system hands out.
// - Quitting stops the server through `POST /api/stop`, the way Ctrl-C does: workers in the middle
//   of a turn pause first (at most 15 minutes), and the window shows that until the server is gone.
//   Quitting again goes ahead at once. No signal: Windows has no SIGTERM, and a killed server would
//   cut its workers off mid-turn. The app ends when the server does.
// - Single instance: starting the app again brings its window to the front.
// - Every request to the server names the owner's key from the home (`owner.key`,
//   src/server/owner.ts); the window signs in through a link the shell asks the server for
//   (`POST /api/login-link`).
// - Links to anything but the canvas, and new windows, open in the default browser; so does
//   "Im Browser öffnen" (the page offers it when it finds `window.obeyaApp`, the macOS menu too),
//   through a link that signs that one browser in.
// - The page gets the microphone without asking (it records only while Space or the mic button is
//   held); the system asks once for the app. WebKitGTK has media streams off until turned on here.
// - Downloads go into the Downloads folder and are shown there.
// - A newer release is downloaded in the background, shown in the bar and installed when the owner
//   says so, once the workers paused (update.rs).
// - OBEYA_APP_CHECK=<url of a module>: the page imports it once the canvas has loaded
//   (scripts/check-app.ts checks the microphone and video in the webview that way).
// - OBEYA_CHECKOUT=<checkout>: started from a checkout (`bun run app`, scripts/app.ts), the shell
//   starts `bun <checkout>/src/server/main.ts` (OBEYA_BUN names the bun) instead of the sidecar,
//   which then updates itself from its checkout as `bun start` does. Installed from a checkout
//   (`bun run app install`), the shell has both compiled in (OBEYA_BUILT_CHECKOUT, OBEYA_BUILT_BUN),
//   and builds itself anew when app/ changes there (update.rs).
// - Starting again (an update, a new build) brings the window back where it was, on the page it showed
//   (`relaunch`).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod update;

use std::{
  collections::HashMap,
  fs,
  io::{Read, Write},
  net::{SocketAddr, TcpListener, TcpStream},
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::{
    atomic::{AtomicBool, AtomicU16, Ordering},
    Arc, Mutex, OnceLock,
  },
  thread,
  time::{Duration, Instant},
};

use tauri::{
  menu::{Menu, MenuItem, MenuItemKind},
  webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, PermissionKind, PermissionResponse},
  AppHandle, DragDropEvent, Manager, PhysicalPosition, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
  WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const SERVER: &str = if cfg!(windows) { "obeya-server.exe" } else { "obeya-server" };
const DEFAULT_PORT: u16 = 4417;
/// How long the server may take to answer after it was started.
const START_PATIENCE: Duration = Duration::from_secs(120);
const KEY_HEADER: &str = "X-Obeya-Key";

/// Obeya's home, once known.
static HOME: OnceLock<PathBuf> = OnceLock::new();

/// The owner's key in the home, which the server makes when it first starts.
fn key() -> Option<String> {
  let key = fs::read_to_string(HOME.get()?.join("owner.key")).ok()?;
  Some(key.trim().to_string()).filter(|k| !k.is_empty())
}

/// A link that signs a browser or webview in and opens `next`; `once`: for one browser, as one that
/// goes through the system's `open` is seen by other accounts in the process list. The plain address
/// from an Obeya that has no such link.
pub(crate) fn login_link(port: u16, next: &str, once: bool) -> String {
  post(port, "/api/login-link", &serde_json::json!({ "next": next, "once": once }))
    .and_then(|v| v["url"].as_str().map(String::from))
    .unwrap_or_else(|| format!("http://127.0.0.1:{port}{next}"))
}

/// What the shell knows of the Obeya its window shows.
#[derive(Default)]
pub(crate) struct Obeya {
  /// Where it answers; 0 until known.
  pub(crate) port: AtomicU16,
  /// Started in this run: the shell sees it end, and how (an update is installed then).
  pub(crate) child: AtomicBool,
  /// The owner quit; the server is told once it answers.
  pub(crate) stopping: AtomicBool,
  /// The shell starts again (`relaunch`): leaving, it does not stop the server.
  relaunching: AtomicBool,
  /// Where the window opens: the page it showed before the shell started again, else the canvas.
  first: Mutex<Option<String>>,
}

impl Obeya {
  fn url(&self) -> Option<String> {
    match self.port.load(Ordering::SeqCst) {
      0 => None,
      port => Some(format!("http://127.0.0.1:{port}/")),
    }
  }

  /// Whether `url` is the canvas or the page the shell shows until it answers.
  fn ours(&self, url: &Url) -> bool {
    let port = self.port.load(Ordering::SeqCst);
    url.scheme() == "tauri"
      || url.host_str() == Some("tauri.localhost")
      || (matches!(url.host_str(), Some("127.0.0.1" | "localhost")) && port != 0 && url.port() == Some(port))
  }
}

/// The checkout whose server the shell starts, when it runs from one rather than with its sidecar.
pub(crate) fn checkout() -> Option<PathBuf> {
  std::env::var_os("OBEYA_CHECKOUT")
    .map(PathBuf::from)
    .or_else(|| option_env!("OBEYA_BUILT_CHECKOUT").filter(|c| !c.is_empty()).map(PathBuf::from))
}

/// The bun that runs the checkout's server: the one named, else the one it was built with while
/// that is there, else whichever the PATH has.
pub(crate) fn bun() -> std::ffi::OsString {
  std::env::var_os("OBEYA_BUN")
    .or_else(|| option_env!("OBEYA_BUILT_BUN").filter(|b| Path::new(b).exists()).map(Into::into))
    .unwrap_or_else(|| "bun".into())
}

/// The owner's language, for what the shell itself says.
fn german() -> bool {
  sys_locale::get_locale().is_some_and(|l| l.starts_with("de"))
}

fn say(de: &str, en: &str) -> String {
  if german() { de } else { en }.to_string()
}

/// A request to the server; its status code, or none when it does not answer.
fn http(port: u16, method: &str, path: &str) -> Option<u16> {
  let addr = SocketAddr::from(([127, 0, 0, 1], port));
  let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
  s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
  let key = key().map(|k| format!("{KEY_HEADER}: {k}\r\n")).unwrap_or_default();
  write!(
    s,
    "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{key}Content-Length: 0\r\nConnection: close\r\n\r\n"
  )
  .ok()?;
  let mut head = [0u8; 12];
  s.read_exact(&mut head).ok()?;
  std::str::from_utf8(&head[9..12]).ok()?.parse().ok()
}

/// A JSON request to the server that names the owner's key; its answer, or none when it fails.
pub(crate) fn post(port: u16, path: &str, body: &serde_json::Value) -> Option<serde_json::Value> {
  let req = ureq::post(&format!("http://127.0.0.1:{port}{path}")).timeout(Duration::from_secs(2));
  let req = match key() {
    Some(key) => req.set(KEY_HEADER, &key),
    None => req,
  };
  let res = req.set("content-type", "application/json").send_string(&body.to_string()).ok()?;
  Some(serde_json::from_str(&res.into_string().ok()?).unwrap_or(serde_json::Value::Null))
}

fn answers(port: u16) -> bool {
  http(port, "GET", "/api/canvases") == Some(200)
}

pub(crate) fn home() -> PathBuf {
  std::env::var_os("OBEYA_HOME")
    .map(PathBuf::from)
    .unwrap_or_else(|| std::env::home_dir().unwrap_or_default().join(".obeya"))
}

/// The port of the Obeya that runs on `home` (src/server/instance.ts).
fn running(home: &Path) -> Option<u16> {
  let text = fs::read_to_string(home.join("server.json")).ok()?;
  let entry: serde_json::Value = serde_json::from_str(&text).ok()?;
  let port = u16::try_from(entry["port"].as_u64()?).ok()?;
  answers(port).then_some(port)
}

fn pick_port() -> u16 {
  let want = std::env::var("OBEYA_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
  if TcpListener::bind(("127.0.0.1", want)).is_ok() {
    return want;
  }
  TcpListener::bind(("127.0.0.1", 0))
    .and_then(|l| l.local_addr())
    .map(|a| a.port())
    .unwrap_or(want)
}

/// Files dragged over the window: the webview hands them to the app rather than the page (so the app
/// learns their paths, which a page never does), and the app passes on to the page where the drag is
/// and, at the drop, the paths (src/ui/appDrop.ts).
fn dragged(w: &WebviewWindow, drag: &DragDropEvent) {
  // where, in the page's CSS pixels: Windows gives the window's own pixels, macOS and Linux points already
  let at = |p: &PhysicalPosition<f64>| {
    let scale = if cfg!(windows) { w.scale_factor().unwrap_or(1.0) } else { 1.0 };
    (p.x / scale, p.y / scale)
  };
  let js = match drag {
    DragDropEvent::Enter { position, .. } | DragDropEvent::Over { position } => {
      let (x, y) = at(position);
      format!("window.obeyaDrag?.('over', {x}, {y})")
    }
    DragDropEvent::Drop { paths, position } => {
      let (x, y) = at(position);
      let paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
      format!("window.obeyaDrag?.('drop', {x}, {y}, {})", serde_json::to_string(&paths).unwrap_or_else(|_| "[]".into()))
    }
    DragDropEvent::Leave => "window.obeyaDrag?.('leave', 0, 0)".into(),
    _ => return,
  };
  let _ = w.eval(js);
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
  app.get_webview_window("main")
}

fn show(app: &AppHandle) {
  if let Some(w) = main_window(app) {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
  }
}

/// A page of Obeya's in the system's browser, signed in there through a link of its own; another link as `open_in_browser`.
fn open_outside(obeya: &Obeya, url: &Url) {
  let port = obeya.port.load(Ordering::SeqCst);
  if !obeya.ours(url) || url.scheme() != "http" || port == 0 {
    return open_in_browser(url.as_str());
  }
  let next = next_of(url);
  // off the main thread: it asks the server first
  thread::spawn(move || open_in_browser(&login_link(port, &next, true)));
}

/// Where `url` leads within Obeya, for a link that signs in and leads there.
fn next_of(url: &Url) -> String {
  match (url.query(), url.fragment()) {
    (Some(q), Some(f)) => format!("{}?{q}#{f}", url.path()),
    (Some(q), None) => format!("{}?{q}", url.path()),
    (None, Some(f)) => format!("{}#{f}", url.path()),
    (None, None) => url.path().to_string(),
  }
}

/// A link out of Obeya, in the system's browser. Other schemes stay closed: the system would hand
/// `file:`, `smb:` or an app's own scheme to whatever program claims it, and a worker's page may link anywhere.
fn open_in_browser(url: &str) {
  let scheme = url.split(':').next().unwrap_or("").to_ascii_lowercase();
  if matches!(scheme.as_str(), "http" | "https" | "mailto") {
    let _ = tauri_plugin_opener::open_url(url, None::<&str>);
  }
}

/// The server's log: what it printed this run, beside the one before.
fn log_file(home: &Path) -> Option<(fs::File, PathBuf)> {
  fs::create_dir_all(home).ok()?;
  let path = home.join("app.log");
  let _ = fs::rename(&path, home.join("app.previous.log"));
  Some((fs::File::create(&path).ok()?, path))
}

fn tail(path: &Path) -> String {
  let text = fs::read_to_string(path).unwrap_or_default();
  let lines: Vec<&str> = text.lines().collect();
  lines[lines.len().saturating_sub(20)..].join("\n")
}

/// Shows why Obeya could not go on, and ends the app.
fn fail(app: &AppHandle, why: String) {
  app.dialog().message(why).title("Obeya").kind(MessageDialogKind::Error).blocking_show();
  app.exit(1);
}

fn start_server(app: &AppHandle, home: &Path, port: u16, log: &(fs::File, PathBuf)) -> std::io::Result<Child> {
  // beside this program (a sidecar), or on Linux among the resources (app/tauri.linux.conf.json)
  let beside = std::env::current_exe()?.with_file_name(SERVER);
  let server = match app.path().resource_dir() {
    Ok(dir) if !beside.exists() => dir.join(SERVER),
    _ => beside,
  };
  let mut cmd = match checkout() {
    Some(checkout) => {
      let mut cmd = Command::new(bun());
      // in the checkout, as `bun start` runs there (started from the desktop, the shell's own directory is `/`)
      cmd.arg(checkout.join("src").join("server").join("main.ts")).current_dir(&checkout);
      cmd
    }
    None => Command::new(server),
  };
  cmd
    .args(["--port", &port.to_string()])
    .env("OBEYA_HOME", home)
    .stdin(Stdio::null())
    .stdout(log.0.try_clone()?)
    .stderr(log.0.try_clone()?);
  if let (Ok(dir), None) = (app.path().resource_dir(), checkout()) {
    cmd.env("OBEYA_RESOURCES", dir.join("resources"));
  }
  no_window(&mut cmd);
  cmd.spawn()
}

/// For a console program the shell runs (the server, git, bun): on Windows, without this, a
/// console window would open beside the app.
pub(crate) fn no_window(cmd: &mut Command) {
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  #[cfg(not(windows))]
  let _ = cmd;
}

/// Brings up the Obeya of this home (the running one, else a new server) and shows its canvas;
/// ends the app when that server has ended.
fn serve(app: AppHandle, obeya: Arc<Obeya>, updates: Arc<update::Updates>) {
  let home = home();
  let attach = |port: u16| {
    obeya.port.store(port, Ordering::SeqCst);
    navigate(&app, &obeya);
  };
  if let Some(port) = running(&home) {
    attach(port);
    return watch(&app, &obeya, &home);
  }
  let Some(log) = log_file(&home) else {
    return fail(
      &app,
      say(
        &format!("Obeya kann nicht in {} schreiben.", home.display()),
        &format!("Obeya cannot write to {}.", home.display()),
      ),
    );
  };
  let port = pick_port();
  let mut child = match start_server(&app, &home, port, &log) {
    Ok(c) => c,
    Err(e) => {
      return fail(
        &app,
        say(&format!("Obeya ließ sich nicht starten: {e}"), &format!("Obeya could not be started: {e}")),
      )
    }
  };
  let started = Instant::now();
  while !answers(port) {
    if let Ok(Some(status)) = child.try_wait() {
      // another start on this home got there first: the server said so and ended
      if let Some(port) = running(&home) {
        attach(port);
        return watch(&app, &obeya, &home);
      }
      return fail(&app, ended(status, &log.1));
    }
    if started.elapsed() > START_PATIENCE {
      return fail(
        &app,
        say(
          &format!("Obeya antwortet nicht.\n\n{}", tail(&log.1)),
          &format!("Obeya does not answer.\n\n{}", tail(&log.1)),
        ),
      );
    }
    thread::sleep(Duration::from_millis(150));
  }
  attach(port);
  obeya.child.store(true, Ordering::SeqCst);
  match child.wait() {
    Ok(status) if status.code() == Some(update::EXIT) => update::install(&app, &obeya, &updates),
    Ok(status) if status.success() || obeya.stopping.load(Ordering::SeqCst) => app.exit(0),
    Ok(status) => fail(&app, ended(status, &log.1)),
    Err(e) => fail(&app, e.to_string()),
  }
}

fn ended(status: std::process::ExitStatus, log: &Path) -> String {
  say(
    &format!("Obeya hat sich beendet ({status}).\n\n{}", tail(log)),
    &format!("Obeya ended ({status}).\n\n{}", tail(log)),
  )
}

/// An Obeya the shell did not start in this run (an earlier run of the app did, or a terminal): the
/// app ends with it.
fn watch(app: &AppHandle, obeya: &Obeya, home: &Path) {
  let port = obeya.port.load(Ordering::SeqCst);
  let mut silent = 0;
  loop {
    thread::sleep(Duration::from_secs(1));
    silent = if answers(port) { 0 } else { silent + 1 };
    // a restart keeps the home's entry, marked while new dependencies go in (up to 90 s, as a start
    // waits for it); a stop ends it for good and gives the entry up
    let entry = fs::read_to_string(home.join("server.json")).ok();
    let stopped = obeya.stopping.load(Ordering::SeqCst) || entry.is_none();
    let patience = if entry.is_some_and(|e| e.contains("\"restarting\"")) { 90 } else { 30 };
    if silent > 0 && stopped || silent > patience {
      return app.exit(0);
    }
  }
}

/// Shows the canvas once it answers, signed in, and tells it to stop when the owner quit meanwhile.
fn navigate(app: &AppHandle, obeya: &Obeya) {
  let (Some(_), Some(w)) = (obeya.url(), main_window(app)) else { return };
  let next = obeya.first.lock().unwrap().take().unwrap_or_else(|| "/".into());
  if let Ok(url) = Url::parse(&login_link(obeya.port.load(Ordering::SeqCst), &next, false)) {
    let _ = w.navigate(url);
  }
  if obeya.stopping.load(Ordering::SeqCst) {
    http(obeya.port.load(Ordering::SeqCst), "POST", "/api/stop");
  }
}

/// The owner quits: Obeya is told to stop, and the app waits for it (true).
fn quit(app: &AppHandle, obeya: &Obeya) -> bool {
  let first = !obeya.stopping.swap(true, Ordering::SeqCst);
  match obeya.port.load(Ordering::SeqCst) {
    // still starting: told once it answers
    0 => true,
    port => {
      if first {
        // the canvas shows what the stop waits for
        show(app);
      }
      http(port, "POST", "/api/stop").is_some()
    }
  }
}

/// The window as the shell left it to start again (`relaunch`), for the new one to open it the same:
/// where it stood and how large, the page it showed. A file in the home, taken once and only fresh.
#[derive(Clone, Default)]
struct Placed {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
  maximized: bool,
  fullscreen: bool,
  /// Shown: closed on a Mac, the window is hidden while the app stays in the Dock.
  visible: bool,
  next: String,
}

const PLACED: &str = "app-window.json";
/// How old the file may be: starting again takes seconds, a start much later opens the window afresh.
const PLACED_FRESH: Duration = Duration::from_secs(60);

pub(crate) fn now_ms() -> u64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl Placed {
  fn of(w: &WebviewWindow, obeya: &Obeya) -> Option<Placed> {
    let scale = w.scale_factor().ok()?;
    let at = w.outer_position().ok()?.to_logical::<f64>(scale);
    let size = w.inner_size().ok()?.to_logical::<f64>(scale);
    let next = w.url().ok().filter(|u| obeya.ours(u) && u.scheme() == "http").map_or_else(|| "/".into(), |u| next_of(&u));
    Some(Placed {
      x: at.x,
      y: at.y,
      width: size.width,
      height: size.height,
      maximized: w.is_maximized().unwrap_or(false),
      fullscreen: w.is_fullscreen().unwrap_or(false),
      visible: w.is_visible().unwrap_or(true),
      next,
    })
  }

  fn keep(&self, home: &Path) {
    let json = serde_json::json!({
      "at": now_ms(), "x": self.x, "y": self.y, "width": self.width, "height": self.height,
      "maximized": self.maximized, "fullscreen": self.fullscreen, "visible": self.visible, "next": self.next,
    });
    let _ = fs::write(home.join(PLACED), json.to_string());
  }

  fn take(home: &Path) -> Option<Placed> {
    let path = home.join(PLACED);
    let text = fs::read_to_string(&path).ok()?;
    let _ = fs::remove_file(&path);
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    if now_ms().saturating_sub(v["at"].as_u64()?) > PLACED_FRESH.as_millis() as u64 {
      return None;
    }
    let n = |k: &str| v[k].as_f64();
    let b = |k: &str| v[k].as_bool().unwrap_or(false);
    Some(Placed {
      x: n("x")?,
      y: n("y")?,
      width: n("width")?,
      height: n("height")?,
      maximized: b("maximized"),
      fullscreen: b("fullscreen"),
      visible: v["visible"].as_bool().unwrap_or(true),
      next: v["next"].as_str().unwrap_or("/").to_string(),
    })
  }
}

/// Whether the shell may start again now without the owner noticing more than the page reloading:
/// its window is out of sight (closed on a Mac), or in front with the owner in it, where the new one
/// takes its place. Not while it is minimized or behind another app's windows, where the new window
/// would come up on top of what the owner works in.
pub(crate) fn may_relaunch(app: &AppHandle) -> bool {
  let Some(w) = main_window(app) else { return true };
  // a minimized window counts as not visible on a Mac
  !w.is_minimized().unwrap_or(false) && (!w.is_visible().unwrap_or(true) || w.is_focused().unwrap_or(false))
}

/// Starts the shell again, whichever build is in its place now, with its window as it was (`Placed`);
/// the server runs on unless it ended already. On a Mac through the system, as the Dock starts it, once
/// this one has ended: run from this process instead, the new shell would count as this one's for the
/// system's permissions (the microphone), which ends with it.
pub(crate) fn relaunch(app: &AppHandle, obeya: &Obeya) {
  obeya.relaunching.store(true, Ordering::SeqCst);
  let placed = main_window(app).and_then(|w| Placed::of(&w, obeya));
  if let Some(p) = &placed {
    p.keep(&home());
  }
  #[cfg(target_os = "macos")]
  {
    // …/Obeya.app/Contents/MacOS/obeya
    let bundle = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.parent()?.parent()?.to_path_buf()));
    if let Some(bundle) = bundle.filter(|b| b.extension().is_some_and(|x| x == "app")) {
      let hidden = placed.as_ref().is_some_and(|p| !p.visible);
      let started = Command::new("/bin/sh")
        .args(["-c", r#"while kill -0 "$1" 2>/dev/null; do sleep 0.1; done; exec /usr/bin/open $3 "$2""#, "sh"])
        .arg(std::process::id().to_string())
        .arg(&bundle)
        // out of sight it stays so, without coming to the front
        .arg(if hidden { "-g" } else { "" })
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
      if started.is_ok() {
        return app.exit(0);
      }
    }
  }
  app.restart();
}

/// A file name in `dir` that is not taken yet: `name`, else `name (2)` and so on.
fn free_name(dir: &Path, name: &str) -> PathBuf {
  let path = dir.join(name);
  if !path.exists() {
    return path;
  }
  let (stem, ext) = name.rsplit_once('.').map_or((name, String::new()), |(s, e)| (s, format!(".{e}")));
  (2..).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).unwrap()
}

fn window(app: &AppHandle, obeya: Arc<Obeya>, placed: Option<&Placed>) -> tauri::Result<WebviewWindow> {
  let navigation = obeya.clone();
  let outside = obeya.clone();
  let loaded = obeya.clone();
  let downloads = app.path().download_dir().ok();
  let saved: Arc<Mutex<HashMap<String, PathBuf>>> = Default::default();
  let check = std::env::var("OBEYA_APP_CHECK").ok();
  let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
    .title("Obeya")
    .inner_size(1440.0, 900.0)
    .min_inner_size(720.0, 480.0)
    .initialization_script(format!(
      "window.obeyaApp = {{ version: {:?}, platform: {:?}, built: {}, handedOver: {} }};",
      app.package_info().version.to_string(),
      std::env::consts::OS,
      // installed from a checkout: the commit it was built from, which the settings show
      option_env!("OBEYA_BUILT_COMMIT").filter(|c| !c.is_empty()).map_or("null".to_string(), |c| format!("{c:?}")),
      // started again: the page before may have handed over what a reload keeps (update.rs)
      placed.is_some()
    ))
    .on_permission_request(|_, kind| match kind {
      PermissionKind::Microphone => PermissionResponse::Allow,
      _ => PermissionResponse::Default,
    })
    .on_navigation(move |url| {
      if navigation.ours(url) {
        return true;
      }
      open_in_browser(url.as_str());
      false
    })
    .on_new_window(move |url, _| {
      open_outside(&outside, &url);
      NewWindowResponse::Deny
    })
    .on_download(move |_, event| {
      match event {
        DownloadEvent::Requested { url, destination } => {
          if let Some(dir) = &downloads {
            let name = destination
              .file_name()
              .map(|n| n.to_string_lossy().into_owned())
              .unwrap_or_else(|| "download".into());
            *destination = free_name(dir, &name);
            saved.lock().unwrap().insert(url.to_string(), destination.clone());
          }
        }
        DownloadEvent::Finished { url, path, success } => {
          let path = path.or_else(|| saved.lock().unwrap().remove(url.as_str()));
          if let (true, Some(path)) = (success, path) {
            let _ = tauri_plugin_opener::reveal_item_in_dir(path);
          }
        }
        _ => {}
      }
      true
    })
    .on_page_load(move |webview, payload| {
      if let (PageLoadEvent::Finished, Some(check)) = (payload.event(), &check) {
        if loaded.ours(payload.url()) && payload.url().scheme() == "http" && payload.url().host_str() != Some("tauri.localhost") {
          let _ = webview.eval(format!("import({check:?})"));
        }
      }
    });
  let builder = match placed {
    Some(p) => builder
      .position(p.x, p.y)
      .inner_size(p.width, p.height)
      .maximized(p.maximized)
      .fullscreen(p.fullscreen)
      .visible(p.visible),
    None => builder,
  };
  // on a Mac the window has no title bar of its own: the canvas's bar is it, with the traffic lights in it
  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true)
    .traffic_light_position(tauri::LogicalPosition::new(18.0, 23.0));
  // WebView2 drops WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS when the app sets arguments of its own, as wry
  // does: they go together (scripts/check-app.ts gives it a fake microphone that way)
  #[cfg(windows)]
  let builder = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
    Ok(extra) => builder.additional_browser_args(&format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection {extra}")),
    Err(_) => builder,
  };
  let window = builder.build()?;
  #[cfg(target_os = "linux")]
  window.with_webview(|webview| {
    use webkit2gtk::{SettingsExt, WebViewExt};
    if let Some(settings) = webview.inner().settings() {
      // getUserMedia is off in WebKitGTK unless the app turns it on
      settings.set_enable_media_stream(true);
      settings.set_enable_mediasource(true);
    }
  })?;
  Ok(window)
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
  let menu = Menu::default(app)?;
  let browser = MenuItem::with_id(app, "browser", say("Im Browser öffnen", "Open in Browser"), true, Some("CmdOrCtrl+Shift+B"))?;
  let items = menu.items()?;
  // the default menu's File menu, after the app's own
  if let Some(MenuItemKind::Submenu(file)) = items.get(1) {
    file.insert(&browser, 0)?;
  }
  // the default Quit (the app menu's last item) ends the app at once, which a Mac does not let an app
  // put off: this one stops Obeya first, as closing the window does elsewhere
  if let Some(MenuItemKind::Submenu(own)) = items.first() {
    let n = own.items()?.len();
    own.remove_at(n - 1)?;
    own.append(&MenuItem::with_id(app, "quit", say("Obeya beenden", "Quit Obeya"), true, Some("CmdOrCtrl+Q"))?)?;
  }
  Ok(menu)
}

fn main() {
  let obeya = Arc::new(Obeya::default());
  let for_setup = obeya.clone();
  // started again by the shell before it (`relaunch`)
  let placed = Placed::take(&home());
  *obeya.first.lock().unwrap() = placed.as_ref().map(|p| p.next.clone());
  let builder = tauri::Builder::default();
  // a window that was out of sight comes back so, and the app stays behind the one the owner is in
  #[cfg(target_os = "macos")]
  let builder = builder.activate_ignoring_other_apps(placed.as_ref().is_none_or(|p| p.visible));
  let app = builder
    .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
    // the opener's functions only, not its plugin: that puts a script into the page that takes each click
    // on a link with target=_blank and hands it to the plugin over IPC, which the page may not call
    // (capabilities/window.json), so the click would do nothing; the shell opens such links itself
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .setup(move |app| {
      let handle = app.handle().clone();
      let _ = HOME.set(home());
      if cfg!(target_os = "macos") {
        app.set_menu(menu(&handle)?)?;
      }
      let for_menu = for_setup.clone();
      app.on_menu_event(move |app, event| {
        if event.id() == "browser" {
          if let Some(url) = main_window(app).and_then(|w| w.url().ok()) {
            open_outside(&for_menu, &url);
          }
        } else if event.id() == "quit" && !quit(app, &for_menu) {
          app.exit(0);
        }
      });
      window(&handle, for_setup.clone(), placed.as_ref())?;
      let updates = update::start(&handle, for_setup.clone());
      let obeya = for_setup.clone();
      thread::spawn(move || serve(handle, obeya, updates));
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("the app could not be built");
  app.run(move |app, event| match event {
    RunEvent::ExitRequested { code: None, api, .. } => {
      if quit(app, &obeya) {
        api.prevent_exit();
      }
    }
    RunEvent::WindowEvent {
      label,
      event: WindowEvent::CloseRequested { api, .. },
      ..
    } if label == "main" => {
      api.prevent_close();
      if cfg!(target_os = "macos") {
        // as Mac apps do: the window goes, the app stays in the Dock
        if let Some(w) = main_window(app) {
          let _ = w.hide();
        }
      } else if !quit(app, &obeya) {
        app.exit(0);
      }
    }
    RunEvent::WindowEvent {
      label,
      event: WindowEvent::DragDrop(drag),
      ..
    } if label == "main" => {
      if let Some(w) = main_window(app) {
        dragged(&w, &drag);
      }
    }
    #[cfg(target_os = "macos")]
    RunEvent::Reopen { .. } => show(app),
    // ended without asking (the Dock's Quit, logging out): the server is told on the way out and
    // stops on its own once its workers paused
    RunEvent::Exit if !obeya.stopping.load(Ordering::SeqCst) && !obeya.relaunching.load(Ordering::SeqCst) => {
      http(obeya.port.load(Ordering::SeqCst), "POST", "/api/stop");
    }
    _ => {}
  });
}
