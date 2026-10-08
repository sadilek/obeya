// Obeya as an app: a window on the canvas of the compiled server (`obeya-server`, a sidecar beside
// this program, built by scripts/build-app.ts), which the shell starts and stops.
//
// - One Obeya per home: when one runs on the home already ($OBEYA_HOME/server.json, written by the
//   server), the window opens on it instead of starting a second. One the app started stops when
//   the app quits; one started from a terminal keeps running.
// - The server picks no port of its own: 4417 ($OBEYA_PORT) when free, else one the system hands out.
// - Quitting stops the server through `POST /api/stop`, the way Ctrl-C does: workers in the middle
//   of a turn pause first (at most 15 minutes), and the window shows that until the server is gone.
//   Quitting again goes ahead at once. No signal: Windows has no SIGTERM, and a killed server would
//   cut its workers off mid-turn. The app ends when the server does.
// - Single instance: starting the app again brings its window to the front.
// - Links to anything but the canvas, and new windows, open in the default browser; so does
//   "Im Browser öffnen" (the page offers it when it finds `window.obeyaApp`, the macOS menu too).
// - The page gets the microphone without asking (it records only while Space or the mic button is
//   held); the system asks once for the app. WebKitGTK has media streams off until turned on here.
// - Downloads go into the Downloads folder and are shown there.
// - OBEYA_APP_CHECK=<url of a module>: the page imports it once the canvas has loaded
//   (scripts/check-app.ts checks the microphone and video in the webview that way).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  collections::HashMap,
  fs,
  io::{Read, Write},
  net::{SocketAddr, TcpListener, TcpStream},
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::{
    atomic::{AtomicBool, AtomicU16, Ordering},
    Arc, Mutex,
  },
  thread,
  time::{Duration, Instant},
};

use tauri::{
  menu::{Menu, MenuItem, MenuItemKind},
  webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, PermissionKind, PermissionResponse},
  AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const SERVER: &str = if cfg!(windows) { "obeya-server.exe" } else { "obeya-server" };
const DEFAULT_PORT: u16 = 4417;
/// How long the server may take to answer after it was started.
const START_PATIENCE: Duration = Duration::from_secs(120);

/// What the shell knows of the Obeya its window shows.
#[derive(Default)]
struct Obeya {
  /// Where it answers; 0 until known.
  port: AtomicU16,
  /// Started by the app (now or by an earlier run of it): quitting stops it.
  owned: AtomicBool,
  /// The owner quit; the server is told once it answers.
  stopping: AtomicBool,
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
  write!(
    s,
    "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
  )
  .ok()?;
  let mut head = [0u8; 12];
  s.read_exact(&mut head).ok()?;
  std::str::from_utf8(&head[9..12]).ok()?.parse().ok()
}

fn answers(port: u16) -> bool {
  http(port, "GET", "/api/canvases") == Some(200)
}

fn home(app: &AppHandle) -> PathBuf {
  std::env::var_os("OBEYA_HOME")
    .map(PathBuf::from)
    .unwrap_or_else(|| app.path().home_dir().unwrap_or_default().join(".obeya"))
}

/// The Obeya that runs on `home` (src/server/instance.ts): its port, and whether the app started it.
fn running(home: &Path) -> Option<(u16, bool)> {
  let text = fs::read_to_string(home.join("server.json")).ok()?;
  let entry: serde_json::Value = serde_json::from_str(&text).ok()?;
  let port = u16::try_from(entry["port"].as_u64()?).ok()?;
  answers(port).then(|| (port, entry["app"].as_bool().unwrap_or(false)))
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

fn open_in_browser(url: &str) {
  let _ = tauri_plugin_opener::open_url(url, None::<&str>);
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
  let mut cmd = Command::new(server);
  cmd
    .args(["--port", &port.to_string()])
    .env("OBEYA_APP", "1")
    .env("OBEYA_HOME", home)
    .stdin(Stdio::null())
    .stdout(log.0.try_clone()?)
    .stderr(log.0.try_clone()?);
  if let Ok(dir) = app.path().resource_dir() {
    cmd.env("OBEYA_RESOURCES", dir.join("resources"));
  }
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    // the server is a console program: without this, a console window would open beside the app
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  cmd.spawn()
}

/// Brings up the Obeya of this home (the running one, else a new server) and shows its canvas;
/// ends the app when the server it owns has ended.
fn serve(app: AppHandle, obeya: Arc<Obeya>) {
  let home = home(&app);
  let attach = |port: u16, owned: bool| {
    obeya.port.store(port, Ordering::SeqCst);
    obeya.owned.store(owned, Ordering::SeqCst);
    navigate(&app, &obeya);
  };
  if let Some((port, owned)) = running(&home) {
    attach(port, owned);
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
  obeya.owned.store(true, Ordering::SeqCst);
  let started = Instant::now();
  while !answers(port) {
    if let Ok(Some(status)) = child.try_wait() {
      // another start on this home got there first: the server said so and ended
      if let Some((port, owned)) = running(&home) {
        attach(port, owned);
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
  attach(port, true);
  match child.wait() {
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

/// An Obeya the shell did not start in this run: when it is the app's, the app ends with it.
fn watch(app: &AppHandle, obeya: &Obeya, home: &Path) {
  if !obeya.owned.load(Ordering::SeqCst) {
    return;
  }
  let port = obeya.port.load(Ordering::SeqCst);
  let mut silent = 0;
  loop {
    thread::sleep(Duration::from_secs(1));
    silent = if answers(port) { 0 } else { silent + 1 };
    // a restart takes seconds and keeps the home's entry; a stop ends it for good and gives the entry up
    let stopped = obeya.stopping.load(Ordering::SeqCst) || !home.join("server.json").exists();
    if silent > 0 && stopped || silent > 30 {
      return app.exit(0);
    }
  }
}

/// Shows the canvas once it answers, and tells it to stop when the owner quit meanwhile.
fn navigate(app: &AppHandle, obeya: &Obeya) {
  let (Some(url), Some(w)) = (obeya.url(), main_window(app)) else { return };
  if let Ok(url) = Url::parse(&url) {
    let _ = w.navigate(url);
  }
  if obeya.stopping.load(Ordering::SeqCst) {
    http(obeya.port.load(Ordering::SeqCst), "POST", "/api/stop");
  }
}

/// The owner quits: an Obeya the app owns is told to stop, and the app waits for it (true).
fn quit(app: &AppHandle, obeya: &Obeya) -> bool {
  if !obeya.owned.load(Ordering::SeqCst) {
    return false;
  }
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

/// A file name in `dir` that is not taken yet: `name`, else `name (2)` and so on.
fn free_name(dir: &Path, name: &str) -> PathBuf {
  let path = dir.join(name);
  if !path.exists() {
    return path;
  }
  let (stem, ext) = name.rsplit_once('.').map_or((name, String::new()), |(s, e)| (s, format!(".{e}")));
  (2..).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).unwrap()
}

fn window(app: &AppHandle, obeya: Arc<Obeya>) -> tauri::Result<WebviewWindow> {
  let navigation = obeya.clone();
  let loaded = obeya.clone();
  let downloads = app.path().download_dir().ok();
  let saved: Arc<Mutex<HashMap<String, PathBuf>>> = Default::default();
  let check = std::env::var("OBEYA_APP_CHECK").ok();
  let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
    .title("Obeya")
    .inner_size(1440.0, 900.0)
    .min_inner_size(720.0, 480.0)
    .initialization_script(format!(
      "window.obeyaApp = {{ version: {:?}, platform: {:?} }};",
      app.package_info().version.to_string(),
      std::env::consts::OS
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
    .on_new_window(|url, _| {
      open_in_browser(url.as_str());
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
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .setup(move |app| {
      let handle = app.handle().clone();
      if cfg!(target_os = "macos") {
        app.set_menu(menu(&handle)?)?;
      }
      let for_menu = for_setup.clone();
      app.on_menu_event(move |app, event| {
        if event.id() == "browser" {
          if let Some(url) = main_window(app).and_then(|w| w.url().ok()) {
            open_in_browser(url.as_str());
          }
        } else if event.id() == "quit" && !quit(app, &for_menu) {
          app.exit(0);
        }
      });
      window(&handle, for_setup.clone())?;
      let obeya = for_setup.clone();
      thread::spawn(move || serve(handle, obeya));
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
    #[cfg(target_os = "macos")]
    RunEvent::Reopen { .. } => show(app),
    // ended without asking (the Dock's Quit, logging out): the server is told on the way out and
    // stops on its own once its workers paused
    RunEvent::Exit if obeya.owned.load(Ordering::SeqCst) && !obeya.stopping.load(Ordering::SeqCst) => {
      http(obeya.port.load(Ordering::SeqCst), "POST", "/api/stop");
    }
    _ => {}
  });
}
