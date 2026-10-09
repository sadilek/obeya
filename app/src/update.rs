// Updates of the app from GitHub Releases, through Tauri's updater: the endpoint and the public key
// of Obeya's own key pair are in tauri.conf.json, and scripts/build-app.ts signs what a release
// holds with the private one.
//
// - At start and every six hours the shell asks for latest.json of the newest release. A newer
//   version is downloaded and its signature checked at once, so that installing it later takes
//   seconds, not a download.
// - Every few seconds the shell tells the server about it (`POST /api/app-update`): the bar shows
//   it, and the owner installs it from there. That goes as a restart for new code goes: the server
//   waits for the workers (and the owner's video or dictation) and ends with EXIT; the shell then
//   installs the update and starts the app again, whose server resumes the workers.
// - A .deb is not replaced by the app (dpkg needs root): the bar offers the release to download.
// - Only for an Obeya the app started in this run, whose end it sees. An Obeya from a checkout
//   (OBEYA_CHECKOUT) updates itself from its checkout.
// - OBEYA_UPDATE_EVERY=<seconds> asks that often instead (scripts/check-update.ts).

use std::{
  sync::{atomic::Ordering, Arc, Mutex},
  thread,
  time::Duration,
};

use serde_json::json;
use tauri::{utils::config::BundleType, AppHandle, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{main_window, ptt, say, Obeya};

/// The exit code with which the server asks the shell to install the update (src/server/self-update.ts).
pub const EXIT: i32 = 77;
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// After a check that failed (offline, say).
const AGAIN: Duration = Duration::from_secs(30 * 60);
const RELEASES: &str = "https://github.com/sadilek/obeya/releases";

/// A newer version, downloaded and checked; or for a .deb, where to get it.
struct Ready {
  update: Update,
  bytes: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct Updates {
  ready: Mutex<Option<Ready>>,
}

fn deb() -> bool {
  matches!(tauri::utils::platform::bundle_type(), Some(BundleType::Deb))
}

pub fn start(app: &AppHandle, obeya: Arc<Obeya>) -> Arc<Updates> {
  let updates = Arc::new(Updates::default());
  if std::env::var_os("OBEYA_CHECKOUT").is_some() {
    return updates;
  }
  let every = std::env::var("OBEYA_UPDATE_EVERY").ok().and_then(|s| s.parse().ok()).map(Duration::from_secs);
  let (a, u) = (app.clone(), updates.clone());
  thread::spawn(move || loop {
    let wait = match check(&a, &u) {
      Ok(()) => every.unwrap_or(EVERY),
      Err(e) => {
        eprintln!("obeya: checking for an update failed: {e}");
        every.unwrap_or(AGAIN)
      }
    };
    thread::sleep(wait);
  });
  let u = updates.clone();
  thread::spawn(move || loop {
    report(&obeya, &u);
    thread::sleep(Duration::from_secs(3));
  });
  updates
}

/// Asks for a newer version and downloads it; one downloaded already is not fetched again.
fn check(app: &AppHandle, updates: &Updates) -> Result<(), String> {
  let updater = app.updater().map_err(|e| e.to_string())?;
  let Some(update) = tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())? else {
    return Ok(());
  };
  if updates.ready.lock().unwrap().as_ref().is_some_and(|r| r.update.version == update.version) {
    return Ok(());
  }
  let bytes = if deb() {
    None
  } else {
    Some(tauri::async_runtime::block_on(update.download(|_, _| {}, || {})).map_err(|e| e.to_string())?)
  };
  *updates.ready.lock().unwrap() = Some(Ready { update, bytes });
  Ok(())
}

/// Tells the server of the version that is ready, while it is one the app started in this run.
fn report(obeya: &Obeya, updates: &Updates) {
  let port = obeya.port.load(Ordering::SeqCst);
  if port == 0 || !obeya.child.load(Ordering::SeqCst) {
    return;
  }
  let body = match updates.ready.lock().unwrap().as_ref() {
    None => return,
    Some(Ready { update, bytes }) => json!({
      "version": update.version,
      "notes": update.body,
      "date": update.date.map(|d| d.unix_timestamp() * 1000),
      "download": bytes.is_none().then(|| format!("{RELEASES}/tag/v{}", update.version)),
    }),
  };
  ptt::post(port, "/api/app-update", &body);
}

/// The server ended to be updated: installs the update and starts the app again, the new version
/// if it went in, else this one, after saying why.
pub fn install(app: &AppHandle, updates: &Updates) {
  if let Some(w) = main_window(app) {
    let page = if cfg!(windows) { "http://tauri.localhost/index.html?updating" } else { "tauri://localhost/index.html?updating" };
    if let Ok(url) = Url::parse(page) {
      let _ = w.navigate(url);
    }
  }
  let ready = updates.ready.lock().unwrap().take();
  if let Some(Ready { update, bytes: Some(bytes) }) = ready {
    // on Windows the installer takes over here: it replaces the app and starts it again
    if let Err(e) = update.install(bytes) {
      app
        .dialog()
        .message(say(
          &format!("Obeya {} ließ sich nicht installieren: {e}\n\nObeya startet wieder in der bisherigen Version.", update.version),
          &format!("Obeya {} could not be installed: {e}\n\nObeya starts again in the version it had.", update.version),
        ))
        .title("Obeya")
        .kind(MessageDialogKind::Error)
        .blocking_show();
    }
  }
  app.restart();
}
