// Hearing the push-to-talk key while another app is in front. The key is written as the browser
// names keys (src/core/push-key.ts): one held alone ("AltRight"), or modifiers and a key
// ("Control+Shift+Space").
//
// - A key alone: the shell only listens, so the key still reaches the app in front, and a tap of it
//   keeps its use there. macOS: a listen-only event tap, which needs the "Input Monitoring"
//   permission (asked for once; until it is given the key does nothing). Windows: a low-level
//   keyboard hook. X11: XInput2's raw key events on the root window.
// - A combination: Tauri's global-shortcut plugin takes it for itself (no permission on a Mac).
// - Wayland gives an app no keys of others: the desktop's Global Shortcuts portal binds a shortcut
//   (the key as the preferred trigger; the owner confirms or changes it in the desktop's dialog)
//   and reports its press and release. Without the portal there is only the window's Space.
//
// What it hears goes to `ptt` as Down, Up, and Other (another key went down while the key was
// held: a shortcut with it, not push-to-talk). Modifiers pressed with it are no such other key.

use std::sync::{
  atomic::{AtomicBool, AtomicU32, Ordering},
  mpsc::Sender,
  Arc, Mutex, OnceLock,
};

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Key {
  Down,
  Up,
  Other,
}

/// What the shell hears, as the server shows it (`PushKeyState` in src/core/push-key.ts).
#[derive(Clone, Debug, PartialEq)]
pub struct Hearing {
  pub state: &'static str,
  pub detail: Option<String>,
}

impl Hearing {
  fn new(state: &'static str) -> Self {
    Hearing { state, detail: None }
  }
}

const NONE: u32 = u32::MAX;
/// The platform's code of the key held alone, or NONE.
static TARGET: AtomicU32 = AtomicU32::new(NONE);
static HELD: AtomicBool = AtomicBool::new(false);
static SEND: OnceLock<Mutex<Sender<Key>>> = OnceLock::new();

fn send(key: Key) {
  if let Some(tx) = SEND.get() {
    let _ = tx.lock().unwrap().send(key);
  }
}

/// A key went down or up, as a hook saw it; `modifier`: it is one.
fn heard(code: u32, down: bool, modifier: bool) {
  let target = TARGET.load(Ordering::SeqCst);
  if target == NONE {
    return;
  }
  if code == target {
    if down && !HELD.swap(true, Ordering::SeqCst) {
      send(Key::Down);
    } else if !down && HELD.swap(false, Ordering::SeqCst) {
      send(Key::Up);
    }
  } else if down && !modifier && HELD.load(Ordering::SeqCst) {
    send(Key::Other);
  }
}

pub fn wayland() -> bool {
  cfg!(target_os = "linux")
    && (std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s == "wayland") || std::env::var_os("WAYLAND_DISPLAY").is_some())
}

/// The session the key is heard in, for the settings: `x11` or `wayland` on Linux.
pub fn session() -> Option<&'static str> {
  cfg!(target_os = "linux").then(|| if wayland() { "wayland" } else { "x11" })
}

pub struct Keys {
  app: AppHandle,
  key: Mutex<String>,
  hearing: Arc<Mutex<Hearing>>,
  /// The hook for keys alone runs (it is started once and then follows TARGET).
  hooked: AtomicBool,
  /// The key comes from elsewhere (ptt.rs's check): nothing listens to the keyboard.
  check: bool,
}

impl Keys {
  pub fn new(app: AppHandle, tx: Sender<Key>, check: bool) -> Arc<Self> {
    let _ = SEND.set(Mutex::new(tx));
    Arc::new(Keys {
      app,
      key: Mutex::new(String::new()),
      hearing: Arc::new(Mutex::new(Hearing::new("on"))),
      hooked: AtomicBool::new(false),
      check,
    })
  }

  pub fn hearing(&self) -> Hearing {
    #[cfg(target_os = "macos")]
    if self.hearing.lock().unwrap().state == "permission" && TARGET.load(Ordering::SeqCst) != NONE {
      // allowed meanwhile in the system settings: the tap starts now
      self.hook();
    }
    self.hearing.lock().unwrap().clone()
  }

  fn set_hearing(&self, h: Hearing) {
    *self.hearing.lock().unwrap() = h;
  }

  /// Listens for `key` from now on (the settings changed it, or the shell just started).
  pub fn listen(&self, key: &str) {
    {
      let mut current = self.key.lock().unwrap();
      if *current == key {
        return;
      }
      *current = key.to_string();
    }
    if self.check {
      return;
    }
    TARGET.store(NONE, Ordering::SeqCst);
    HELD.store(false, Ordering::SeqCst);
    let _ = self.app.global_shortcut().unregister_all();
    if wayland() {
      #[cfg(target_os = "linux")]
      portal::bind(key, self.hearing.clone());
      return;
    }
    if key.contains('+') {
      // as global-hotkey writes it: Super for the Windows key and Command
      let shortcut = key.replace("Meta", "Super");
      let result = self.app.global_shortcut().on_shortcut(shortcut.as_str(), |_, _, event| {
        send(if event.state == ShortcutState::Pressed { Key::Down } else { Key::Up })
      });
      self.set_hearing(match result {
        Ok(()) => Hearing::new("on"),
        Err(e) => Hearing { state: "error", detail: Some(e.to_string()) },
      });
      return;
    }
    let Some(code) = native::code(key) else {
      return self.set_hearing(Hearing::new("unsupported"));
    };
    TARGET.store(code, Ordering::SeqCst);
    self.hook();
  }

  /// Starts the hook for keys alone, once.
  fn hook(&self) {
    if self.hooked.load(Ordering::SeqCst) {
      return self.set_hearing(Hearing::new("on"));
    }
    match native::start() {
      Ok(()) => {
        self.hooked.store(true, Ordering::SeqCst);
        self.set_hearing(Hearing::new("on"))
      }
      Err(h) => self.set_hearing(h),
    }
  }
}

#[cfg(target_os = "macos")]
mod native {
  use super::{heard, Hearing};
  use std::{
    ffi::c_void,
    ptr,
    sync::{atomic::AtomicBool, atomic::AtomicPtr, atomic::Ordering, mpsc},
    thread,
  };

  type Ref = *mut c_void;
  type Callback = extern "C" fn(proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref;

  #[link(name = "ApplicationServices", kind = "framework")]
  extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
    fn CGEventTapCreate(tap: u32, place: u32, options: u32, events: u64, callback: Callback, user: Ref) -> Ref;
    fn CGEventTapEnable(tap: Ref, enable: bool);
    fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
    fn CGEventGetFlags(event: Ref) -> u64;
  }
  #[link(name = "CoreFoundation", kind = "framework")]
  extern "C" {
    fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
    fn CFRunLoopGetCurrent() -> Ref;
    fn CFRunLoopAddSource(run_loop: Ref, source: Ref, mode: Ref);
    fn CFRunLoopRun();
    static kCFRunLoopCommonModes: Ref;
  }

  const SESSION_TAP: u32 = 1;
  const HEAD_INSERT: u32 = 0;
  const LISTEN_ONLY: u32 = 1;
  const KEY_DOWN: u32 = 10;
  const KEY_UP: u32 = 11;
  const FLAGS_CHANGED: u32 = 12;
  const DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
  const DISABLED_BY_USER: u32 = 0xFFFF_FFFF;
  const KEYCODE: u32 = 9;
  const AUTOREPEAT: u32 = 8;

  static TAP: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
  static ASKED: AtomicBool = AtomicBool::new(false);

  /// Modifier keys (virtual key codes) and their bit among an event's device-dependent flags.
  const MODIFIERS: [(u32, u64); 8] = [
    (59, 0x01),   // left Control
    (62, 0x2000), // right Control
    (58, 0x20),   // left Option
    (61, 0x40),   // right Option
    (56, 0x02),   // left Shift
    (60, 0x04),   // right Shift
    (55, 0x08),   // left Command
    (54, 0x10),   // right Command
  ];

  pub fn code(key: &str) -> Option<u32> {
    let f = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90];
    Some(match key {
      "ControlLeft" => 59,
      "ControlRight" => 62,
      "AltLeft" => 58,
      "AltRight" => 61,
      "ShiftLeft" => 56,
      "ShiftRight" => 60,
      "MetaLeft" => 55,
      "MetaRight" => 54,
      // a PC keyboard's Insert is the Mac's Help key
      "Insert" => 114,
      _ => return key.strip_prefix('F').and_then(|n| n.parse::<usize>().ok()).and_then(|n| f.get(n.wrapping_sub(1)).copied()),
    })
  }

  extern "C" fn tapped(_: Ref, kind: u32, event: Ref, _: Ref) -> Ref {
    if kind == DISABLED_BY_TIMEOUT || kind == DISABLED_BY_USER {
      // macOS turns a tap off that once took too long; it goes on
      unsafe { CGEventTapEnable(TAP.load(Ordering::SeqCst), true) };
      return event;
    }
    let code = unsafe { CGEventGetIntegerValueField(event, KEYCODE) } as u32;
    match kind {
      FLAGS_CHANGED => {
        if let Some((_, bit)) = MODIFIERS.iter().find(|(c, _)| *c == code) {
          heard(code, unsafe { CGEventGetFlags(event) } & bit != 0, true);
        }
      }
      KEY_DOWN if unsafe { CGEventGetIntegerValueField(event, AUTOREPEAT) } == 0 => heard(code, true, false),
      KEY_UP => heard(code, false, false),
      _ => {}
    }
    event
  }

  pub fn start() -> Result<(), Hearing> {
    if !unsafe { CGPreflightListenEventAccess() } {
      // the system asks once; after that the owner allows it in the system settings
      if !ASKED.swap(true, Ordering::SeqCst) {
        unsafe { CGRequestListenEventAccess() };
      }
      return Err(Hearing::new("permission"));
    }
    let (done, started) = mpsc::channel();
    thread::spawn(move || unsafe {
      let mask = (1u64 << KEY_DOWN) | (1 << KEY_UP) | (1 << FLAGS_CHANGED);
      let tap = CGEventTapCreate(SESSION_TAP, HEAD_INSERT, LISTEN_ONLY, mask, tapped, ptr::null_mut());
      if tap.is_null() {
        let _ = done.send(false);
        return;
      }
      TAP.store(tap, Ordering::SeqCst);
      let source = CFMachPortCreateRunLoopSource(ptr::null_mut(), tap, 0);
      CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
      CGEventTapEnable(tap, true);
      let _ = done.send(true);
      CFRunLoopRun();
    });
    match started.recv() {
      Ok(true) => Ok(()),
      // allowed, but not for this process yet: macOS wants the app started again
      _ => Err(Hearing { state: "permission", detail: Some("restart".into()) }),
    }
  }
}

#[cfg(windows)]
mod native {
  use super::{heard, Hearing};
  use std::{ptr, sync::mpsc, thread};
  use windows_sys::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{
      CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
      WM_SYSKEYUP,
    },
  };

  /// Shift, Ctrl, Alt (either side and generic) and the Windows keys.
  const MODIFIERS: [u32; 11] = [0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C];

  pub fn code(key: &str) -> Option<u32> {
    Some(match key {
      "ShiftLeft" => 0xA0,
      "ShiftRight" => 0xA1,
      "ControlLeft" => 0xA2,
      "ControlRight" => 0xA3,
      "AltLeft" => 0xA4,
      "AltRight" => 0xA5,
      "MetaLeft" => 0x5B,
      "MetaRight" => 0x5C,
      "Pause" => 0x13,
      "ScrollLock" => 0x91,
      "Insert" => 0x2D,
      "ContextMenu" => 0x5D,
      _ => return key.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()).filter(|n| (1..=24).contains(n)).map(|n| 0x6F + n),
    })
  }

  unsafe extern "system" fn hooked(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
      let k = &*(lparam as *const KBDLLHOOKSTRUCT);
      let msg = wparam as u32;
      let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
      if down || msg == WM_KEYUP || msg == WM_SYSKEYUP {
        heard(k.vkCode, down, MODIFIERS.contains(&k.vkCode));
      }
    }
    CallNextHookEx(ptr::null_mut(), code, wparam, lparam)
  }

  pub fn start() -> Result<(), Hearing> {
    let (done, started) = mpsc::channel();
    thread::spawn(move || unsafe {
      // the hook is called on this thread, which therefore pumps messages
      let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hooked), GetModuleHandleW(ptr::null()), 0);
      let _ = done.send(!hook.is_null());
      if hook.is_null() {
        return;
      }
      let mut msg: MSG = std::mem::zeroed();
      while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {}
    });
    match started.recv() {
      Ok(true) => Ok(()),
      _ => Err(Hearing { state: "error", detail: Some("SetWindowsHookEx failed".into()) }),
    }
  }
}

#[cfg(target_os = "linux")]
mod native {
  use super::{heard, Hearing};
  use std::{ffi::CString, os::raw::c_int, ptr, sync::mpsc, thread};
  use x11_dl::{xinput2, xlib};

  /// X key codes (evdev's plus 8) of the modifiers, AltGr's ISO_Level3_Shift and Caps Lock.
  const MODIFIERS: [u32; 10] = [37, 105, 64, 108, 50, 62, 133, 134, 92, 66];

  pub fn code(key: &str) -> Option<u32> {
    Some(match key {
      "ControlLeft" => 37,
      "ControlRight" => 105,
      "AltLeft" => 64,
      "AltRight" => 108,
      "ShiftLeft" => 50,
      "ShiftRight" => 62,
      "MetaLeft" => 133,
      "MetaRight" => 134,
      "Pause" => 127,
      "ScrollLock" => 78,
      "Insert" => 118,
      "ContextMenu" => 135,
      _ => {
        let n = key.strip_prefix('F')?.parse::<u32>().ok()?;
        match n {
          1..=10 => 66 + n,
          11 | 12 => 84 + n,
          13..=24 => 178 + n,
          _ => return None,
        }
      }
    })
  }

  pub fn start() -> Result<(), Hearing> {
    let failed = |what: &str| Hearing { state: "error", detail: Some(what.into()) };
    let (done, started) = mpsc::channel::<Result<(), Hearing>>();
    thread::spawn(move || unsafe {
      let (Ok(x), Ok(xi)) = (xlib::Xlib::open(), xinput2::XInput2::open()) else {
        let _ = done.send(Err(failed("libX11 or libXi missing")));
        return;
      };
      let display = (x.XOpenDisplay)(ptr::null());
      if display.is_null() {
        let _ = done.send(Err(failed("no X display")));
        return;
      }
      let name = CString::new("XInputExtension").unwrap();
      let (mut opcode, mut event, mut error): (c_int, c_int, c_int) = (0, 0, 0);
      if (x.XQueryExtension)(display, name.as_ptr(), &mut opcode, &mut event, &mut error) == 0 {
        let _ = done.send(Err(failed("no XInput2")));
        return;
      }
      let mut bits = [0u8; 4];
      for e in [xinput2::XI_RawKeyPress, xinput2::XI_RawKeyRelease] {
        bits[(e >> 3) as usize] |= 1 << (e & 7);
      }
      let mut mask = xinput2::XIEventMask { deviceid: xinput2::XIAllMasterDevices, mask_len: bits.len() as c_int, mask: bits.as_mut_ptr() };
      (xi.XISelectEvents)(display, (x.XDefaultRootWindow)(display), &mut mask, 1);
      (x.XFlush)(display);
      let _ = done.send(Ok(()));
      let mut ev: xlib::XEvent = std::mem::zeroed();
      loop {
        (x.XNextEvent)(display, &mut ev);
        let mut cookie = ev.generic_event_cookie;
        if cookie.type_ != xlib::GenericEvent || cookie.extension != opcode || (x.XGetEventData)(display, &mut cookie) == 0 {
          continue;
        }
        let raw = &*(cookie.data as *const xinput2::XIRawEvent);
        let down = cookie.evtype == xinput2::XI_RawKeyPress;
        if down || cookie.evtype == xinput2::XI_RawKeyRelease {
          let code = raw.detail as u32;
          heard(code, down, MODIFIERS.contains(&code));
        }
        (x.XFreeEventData)(display, &mut cookie);
      }
    });
    started.recv().unwrap_or_else(|_| Err(failed("XInput2 thread ended")))
  }
}

/// Wayland: the desktop's Global Shortcuts portal binds the shortcut and reports it.
#[cfg(target_os = "linux")]
mod portal {
  use super::{send, Hearing, Key};
  use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
  use futures_util::StreamExt;
  use std::sync::{Arc, Mutex};

  const ID: &str = "push-to-talk";

  /// The key as the XDG shortcuts specification writes a trigger (modifiers and an XKB key name).
  fn trigger(key: &str) -> String {
    key
      .split('+')
      .map(|part| match part {
        "Control" => "CTRL".to_string(),
        "Alt" => "ALT".to_string(),
        "Shift" => "SHIFT".to_string(),
        "Meta" => "LOGO".to_string(),
        "Space" => "space".to_string(),
        "Backquote" => "grave".to_string(),
        "ScrollLock" => "Scroll_Lock".to_string(),
        "ContextMenu" => "Menu".to_string(),
        k if k.ends_with("Left") || k.ends_with("Right") => {
          let side = if k.ends_with("Left") { "L" } else { "R" };
          let name = k.trim_end_matches("Left").trim_end_matches("Right");
          format!("{}_{side}", if name == "Meta" { "Super" } else { name })
        }
        k if k.starts_with("Key") => k[3..].to_lowercase(),
        k if k.starts_with("Digit") => k[5..].to_string(),
        k => k.to_string(),
      })
      .collect::<Vec<_>>()
      .join("+")
  }

  static RUNNING: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

  pub fn bind(key: &str, hearing: Arc<Mutex<Hearing>>) {
    let preferred = trigger(key);
    let task = tauri::async_runtime::spawn(async move {
      let set = |h: Hearing| *hearing.lock().unwrap() = h;
      let failed = |e: ashpd::Error| Hearing { state: "error", detail: Some(e.to_string()) };
      let portal = match GlobalShortcuts::new().await {
        Ok(p) => p,
        Err(_) => return set(Hearing::new("none")),
      };
      let session = match portal.create_session().await {
        Ok(s) => s,
        Err(e) => return set(failed(e)),
      };
      let shortcut = NewShortcut::new(ID, "Obeya: push-to-talk").preferred_trigger(preferred.as_str());
      // the desktop shows its dialog, where the owner confirms the shortcut or picks another
      set(Hearing::new("bind"));
      let bound = match portal.bind_shortcuts(&session, &[shortcut], None).await.and_then(|r| r.response()) {
        Ok(b) => b,
        Err(e) => return set(failed(e)),
      };
      match bound.shortcuts().iter().find(|s| s.id() == ID) {
        Some(s) => set(Hearing { state: "on", detail: Some(s.trigger_description().to_string()) }),
        None => return set(Hearing::new("bind")),
      }
      let (Ok(mut down), Ok(mut up)) = (portal.receive_activated().await, portal.receive_deactivated().await) else {
        return set(Hearing { state: "error", detail: Some("no signals from the portal".into()) });
      };
      loop {
        tokio::select! {
          Some(a) = down.next() => if a.shortcut_id() == ID { send(Key::Down) },
          Some(d) = up.next() => if d.shortcut_id() == ID { send(Key::Up) },
          else => break,
        }
      }
    });
    if let Some(old) = RUNNING.lock().unwrap().replace(task) {
      old.abort();
    }
  }
}
