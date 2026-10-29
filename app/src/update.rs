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
//   updates itself from its checkout, and so does a shell installed from one (`bun run app install`,
//   which compiles in the version of app/ it was built from, OBEYA_BUILT_TREE): every minute it
//   looks at app/ on the checkout's HEAD, and once that is another, the checkout's scripts/app.ts
//   builds the shell and installs it in this one's place. The shell then tells the server it started
//   of it as of an update, which the server installs without asking, as it restarts for new code;
//   nothing is left to install then but starting again. A server it did not start (a terminal's)
//   runs on, and the shell starts again by itself (`start_again`). A build that failed (its output
//   is in app-build.log in the home) is tried again for the next change of app/.
// - OBEYA_UPDATE_EVERY=<seconds> asks that often instead (scripts/check-update.ts).

use std::{
  fs,
  path::Path,
  process::{Command, Stdio},
  sync::{atomic::Ordering, Arc, Mutex},
  thread,
  time::Duration,
};

use serde_json::json;
use tauri::{utils::config::BundleType, AppHandle, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{main_window, no_window, post, say, Obeya};

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
  /// Installed from a checkout: a new build of the shell is in this one's place.
  rebuilt: Mutex<bool>,
}

fn deb() -> bool {
  matches!(tauri::utils::platform::bundle_type(), Some(BundleType::Deb))
}

pub fn start(app: &AppHandle, obeya: Arc<Obeya>) -> Arc<Updates> {
  let updates = Arc::new(Updates::default());
  if let Some(checkout) = crate::checkout() {
    let Some(built) = option_env!("OBEYA_BUILT_TREE").filter(|t| !t.is_empty()) else {
      return updates;
    };
    let (home, u) = (crate::home(), updates.clone());
    thread::spawn(move || rebuild(&checkout, built, &home, &u));
  } else {
    check_releases(app, &updates);
  }
  let (a, u) = (app.clone(), updates.clone());
  thread::spawn(move || loop {
    report(&a, &obeya, &u);
    thread::sleep(Duration::from_secs(3));
  });
  updates
}

/// At start and every six hours: a newer release, downloaded.
fn check_releases(app: &AppHandle, updates: &Arc<Updates>) {
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
}

/// Installed from a checkout: builds and installs the shell anew whenever app/ on the checkout's
/// HEAD is another than the one it was last built from.
fn rebuild(checkout: &Path, built: &str, home: &Path, updates: &Updates) {
  let mut last = built.to_string();
  loop {
    if let Some(tree) = tree(checkout).filter(|t| *t != last) {
      last = tree;
      let log = home.join("app-build.log");
      let bun = crate::bun();
      let mut cmd = Command::new(&bun);
      cmd
        .arg(checkout.join("scripts").join("app.ts"))
        // compiled into the new build in turn
        .env("OBEYA_BUN", &bun)
        .args(["install", "--no-open"])
        .current_dir(checkout)
        .stdin(Stdio::null());
      no_window(&mut cmd);
      let built = fs::File::create(&log)
        .and_then(|f| Ok((f.try_clone()?, f)))
        .and_then(|(out, err)| cmd.stdout(out).stderr(err).status())
        .is_ok_and(|s| s.success());
      if built {
        *updates.rebuilt.lock().unwrap() = true;
      } else {
        eprintln!("obeya: the shell did not build anew, see {}", log.display());
      }
    }
    thread::sleep(Duration::from_secs(60));
  }
}

/// The version of app/ on the checkout's HEAD.
fn tree(checkout: &Path) -> Option<String> {
  let mut cmd = Command::new("git");
  cmd.arg("-C").arg(checkout).args(["rev-parse", "HEAD:app"]).stdin(Stdio::null()).stderr(Stdio::null());
  no_window(&mut cmd);
  let out = cmd.output().ok()?;
  let tree = String::from_utf8_lossy(&out.stdout).trim().to_string();
  (out.status.success() && !tree.is_empty()).then_some(tree)
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

/// Tells the server of the version that is ready, while it is one the app started in this run. A
/// new build of the shell where the server runs on without it (started from a terminal) starts
/// again by itself (`start_again`).
fn report(app: &AppHandle, obeya: &Obeya, updates: &Updates) {
  let port = obeya.port.load(Ordering::SeqCst);
  if port == 0 || obeya.stopping.load(Ordering::SeqCst) {
    return;
  }
  if !obeya.child.load(Ordering::SeqCst) {
    if *updates.rebuilt.lock().unwrap() {
      start_again(app, obeya, port);
    }
    return;
  }
  let body = match updates.ready.lock().unwrap().as_ref() {
    None if *updates.rebuilt.lock().unwrap() => json!({ "rebuilt": true }),
    None => return,
    Some(Ready { update, bytes }) => json!({
      "version": update.version,
      "notes": update.body,
      "date": update.date.map(|d| d.unix_timestamp() * 1000),
      "download": bytes.is_none().then(|| format!("{RELEASES}/tag/v{}", update.version)),
    }),
  };
  post(port, "/api/app-update", &body);
}

/// A new build of the shell is in place, and the server runs on without it: it starts again once the
/// owner neither dictates nor watches a video (as the server's restart waits for them, which says
/// so) and its window allows (`may_relaunch`), after the page handed over what a reload keeps
/// (src/ui/api.ts, `handOver`), or did not within a few seconds (a page that does not know how).
fn start_again(app: &AppHandle, obeya: &Obeya, port: u16) {
  let ask = |kept: &str| post(port, "/api/app-rebuilt", &json!({ "kept": kept }));
  let now = |a: &Option<serde_json::Value>| a.as_ref().is_some_and(|a| a["now"] == true);
  if !now(&ask("")) || !crate::may_relaunch(app) {
    return;
  }
  let token = format!("{}", crate::now_ms());
  if let Some(w) = main_window(app) {
    let _ = w.eval(format!("window.obeyaHandOver?.({token:?})"));
  }
  for _ in 0..25 {
    thread::sleep(Duration::from_millis(200));
    let answer = ask(&token);
    if answer.as_ref().is_some_and(|a| a["kept"] == true) {
      break;
    }
  }
  // the owner may have begun to speak meanwhile; what was handed over waits for the next try
  if now(&ask("")) && crate::may_relaunch(app) {
    crate::relaunch(app, obeya);
  }
}

/// The server ended to be updated: installs the update and starts the app again, the new version
/// if it went in, else this one, after saying why. A new build of the shell is in place already.
pub fn install(app: &AppHandle, obeya: &Obeya, updates: &Updates) {
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
  crate::relaunch(app, obeya);
}
