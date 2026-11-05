// What waits for the owner, as a number on the app's icon: the count of the bar's navigation button
// (cards that need the owner on every canvas, and one per canvas whose Obeya answers wait unread).
//
// - A Mac shows it as the Dock's badge, a Linux desktop as its launcher's where it has one (the Unity
//   launcher API, which KDE and Ubuntu's dock speak), Windows as an overlay on the taskbar button,
//   which the shell draws (`overlay`): Windows has no badge with a number of its own.
// - The shell asks the server (`GET /api/waiting-count`), naming the count it shows; the server
//   answers once that is another, or after a while with the same. So the badge follows at once, also
//   while the window is closed and its page asleep, without asking every second.
// - While the server does not answer (it starts again, say) the badge stays as it was.

use std::{
  sync::{atomic::Ordering, Arc},
  thread,
  time::Duration,
};

use tauri::AppHandle;

use crate::{get, main_window, Obeya};

/// How long the server may hold an answer that brings nothing new (it holds it 50 s).
const HOLD: Duration = Duration::from_secs(70);
/// Before asking again a server that did not answer, or an Obeya from before the count.
const AGAIN: Duration = Duration::from_secs(3);

pub fn start(app: &AppHandle, obeya: Arc<Obeya>) {
  let app = app.clone();
  thread::spawn(move || {
    let mut shown: Option<u64> = None;
    loop {
      let port = obeya.port.load(Ordering::SeqCst);
      let path = match shown {
        Some(n) => format!("/api/waiting-count?seen={n}"),
        None => "/api/waiting-count".into(),
      };
      let count = (port != 0).then(|| get(port, &path, HOLD)).flatten().and_then(|a| a["count"].as_u64());
      match count {
        Some(n) if shown != Some(n) => {
          show(&app, n);
          shown = Some(n);
        }
        Some(_) => {}
        None => thread::sleep(AGAIN),
      }
    }
  });
}

/// The count on the icon; none at 0.
fn show(app: &AppHandle, n: u64) {
  let Some(w) = main_window(app) else { return };
  #[cfg(windows)]
  let _ = w.set_overlay_icon((n > 0).then(|| tauri::image::Image::new_owned(overlay(n), SIZE, SIZE)));
  #[cfg(not(windows))]
  let _ = w.set_badge_count((n > 0).then(|| i64::try_from(n).unwrap_or(i64::MAX)));
}

/// The overlay's side in pixels: Windows shows it at a small icon's size (16 px at 100 %), scaled down.
#[cfg_attr(not(windows), allow(dead_code))]
const SIZE: u32 = 32;

/// The bar's colour for what waits (--waiting in src/ui/styles.css).
#[cfg_attr(not(windows), allow(dead_code))]
const DISC: [u8; 3] = [0xf2, 0x74, 0x05];

/// Digits and the plus, 3 × 5 pixels each, a row per byte from the top, its bits from the left.
#[cfg_attr(not(windows), allow(dead_code))]
const GLYPHS: [(char, [u8; 5]); 11] = [
  ('0', [0b111, 0b101, 0b101, 0b101, 0b111]),
  ('1', [0b010, 0b110, 0b010, 0b010, 0b111]),
  ('2', [0b111, 0b001, 0b111, 0b100, 0b111]),
  ('3', [0b111, 0b001, 0b111, 0b001, 0b111]),
  ('4', [0b101, 0b101, 0b111, 0b001, 0b001]),
  ('5', [0b111, 0b100, 0b111, 0b001, 0b111]),
  ('6', [0b111, 0b100, 0b111, 0b101, 0b111]),
  ('7', [0b111, 0b001, 0b001, 0b001, 0b001]),
  ('8', [0b111, 0b101, 0b111, 0b101, 0b111]),
  ('9', [0b111, 0b101, 0b111, 0b001, 0b111]),
  ('+', [0b000, 0b010, 0b111, 0b010, 0b000]),
];

/// The overlay for `n`, RGBA: a disc in the bar's colour with the count in white, "9+" past nine,
/// which is as much as stays legible at 16 px.
#[cfg_attr(not(windows), allow(dead_code))]
fn overlay(n: u64) -> Vec<u8> {
  let text = if n > 9 { "9+".to_string() } else { n.to_string() };
  // one digit large, two smaller; a pixel apart
  let scale = if text.len() == 1 { 4 } else { 3 };
  let (cols, rows) = (text.len() as u32 * 4 - 1, 5);
  let (x0, y0) = ((SIZE - cols * scale) / 2, (SIZE - rows * scale) / 2);
  let ink = |x: u32, y: u32| {
    let (cx, cy) = (x.checked_sub(x0)? / scale, y.checked_sub(y0)? / scale);
    let c = text.chars().nth((cx / 4) as usize)?;
    let rows = GLYPHS.iter().find(|g| g.0 == c)?.1;
    let bit = cx % 4;
    (bit < 3 && *rows.get(cy as usize)? >> (2 - bit) & 1 == 1).then_some(())
  };
  let r = SIZE as f64 / 2.0;
  let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
  for y in 0..SIZE {
    for x in 0..SIZE {
      // the disc's edge smoothed over a pixel
      let d = ((x as f64 + 0.5 - r).powi(2) + (y as f64 + 0.5 - r).powi(2)).sqrt();
      let alpha = (r - d + 0.5).clamp(0.0, 1.0);
      let [red, green, blue] = if ink(x, y).is_some() { [255; 3] } else { DISC };
      rgba.extend_from_slice(&[red, green, blue, (alpha * 255.0).round() as u8]);
    }
  }
  rgba
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The overlay as text: `#` white, `o` the disc, `.` clear.
  fn picture(n: u64) -> Vec<String> {
    overlay(n)
      .chunks(4 * SIZE as usize)
      .map(|row| {
        row
          .chunks(4)
          .map(|p| match p {
            [255, 255, 255, 255] => '#',
            [_, _, _, 0] => '.',
            _ => 'o',
          })
          .collect()
      })
      .collect()
  }

  #[test]
  fn one_digit_stands_large_in_the_middle() {
    let p = picture(7);
    assert_eq!(p.len(), SIZE as usize);
    // the 7's top bar, 12 px wide, from x 10, and its stem on the right down to the bottom
    assert_eq!(&p[6][8..24], "oo############oo");
    assert_eq!(&p[25][8..24], "oooooooooo####oo");
    assert_eq!(&p[26][8..24], "oooooooooooooooo");
    // clear in the corners
    assert!(p[0].starts_with("...") && p[31].ends_with("..."));
  }

  #[test]
  fn past_nine_it_says_nine_plus() {
    assert_eq!(overlay(10), overlay(250));
    let p = picture(12);
    // the 9's middle bar and the plus's crossbar side by side, three pixels a dot
    assert_eq!(&p[14][4..28], "o#########ooo#########oo");
  }

  #[test]
  fn every_pixel_has_its_colour() {
    for n in [1, 9, 42] {
      assert_eq!(overlay(n).len(), (SIZE * SIZE * 4) as usize);
    }
  }
}
