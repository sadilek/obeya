---
name: browser
description: "A headless browser of this session's own, driven from the shell: load pages, click, drag and scroll with trusted input, hold keys, type, run JavaScript in the page, read its text, take screenshots and PDFs, feed a fake microphone from a WAV; for WebKit (Safari's engine), Firefox or a Playwright script of your own, it names the Playwright already installed. Use it to check a web UI in a real browser (how a change behaves, how a page renders) when the project has no browser tooling of its own. It is muted, shared with no other session, and closes when the session ends."
---

# A headless browser for UI checks

`${CLAUDE_SKILL_DIR}/lib/browser.ts` starts a headless Chromium for this session and drives it over
the Chrome DevTools Protocol. It runs with plain Node (22.18 or newer) on macOS, Linux and Windows,
on the browser the demo skill records with: Chrome where it is installed, else Edge, else
Playwright's own Chromium (`DEMO_CHROME` names another).

The browser belongs to this session: other sessions on the machine have their own, and it closes by
itself when this session ends. It is always muted, so a page's videos and narration stay silent, and its `speechSynthesis` speaks
nothing (it goes on as if it had: `start`, then `end` after about as long as saying it takes).
Its profile is fresh at every `start`: no logins or cookies of the machine's user.

For what headless Chromium can't reproduce (on-screen keyboard, fullscreen, rotation), use
`bun scripts/android-phone.ts` in Obeya's repository: Chrome in the Android emulator, with real taps.

## Commands

All commands: `node ${CLAUDE_SKILL_DIR}/lib/browser.ts <command>`

```bash
start [--window-size 1280,900] [--fake-mic file.wav]   # launch (idempotent; prints CDP port)
stop                              # close it (it also closes when the session ends)
status                            # CDP port, pid and open tabs
tabs                              # open tabs: id, url, title
open <url> [--no-wait]            # new tab, waits for document.readyState === complete, prints tab id
nav <url> [--tab id] [--no-wait]  # navigate an existing tab
close <tabId>                     # close a tab
eval <js> [--tab id]              # run JS in the page (awaits promises), prints JSON result
text [--tab id]                   # document.body.innerText
html [--tab id]                   # full page HTML
screenshot <file.png> [--tab id] [--full]   # --full = full page height
pdf <file.pdf> [--tab id]
input <step>… [--tab id]          # trusted mouse/keyboard input, see below
playwright                        # the import line of Playwright for a script, and its browsers
playwright install <browser>…     # install Playwright's own webkit or firefox
```

`--tab` accepts an id prefix; without it, the first (most recently used) tab is targeted.

## Typical session

```bash
B=${CLAUDE_SKILL_DIR}/lib/browser.ts
node $B start
node $B open http://127.0.0.1:4480/          # prints tab id
node $B text                                 # page content as plain text
node $B screenshot /tmp/page.png --full      # then Read the PNG to view it
node $B stop
```

## Interacting with pages

`input` sends trusted input through CDP (real pointer and key events, which synthetic JS events are
not: pointer capture, `isTrusted`, key holds). Steps run in order on one connection, so a key
pressed with `down:` stays held until `up:`:

```bash
node $B input "click:@#search" "type:hello" "key:Enter" "wait:500" "shot:/tmp/after.png"
node $B input "dbl:700,400" "drag:@.card,900,500" "wheel:700,400,0,-300" "wheel:700,400,0,-100,ctrl"
node $B input "down:Space" "wait:3000" "up:Space" "eval:document.title"   # hold a key (push-to-talk)
```

Steps: `click:X,Y`, `dbl:X,Y`, `drag:X1,Y1,X2,Y2[,X3,Y3…]` (more points: a path through them), `wheel:X,Y,DX,DY[,ctrl]`, `key:NAME`,
`down:NAME`, `up:NAME` (a character, Enter, Escape, Tab, Space, Backspace, ArrowUp, ArrowDown,
ArrowLeft, ArrowRight, Shift, Control, Alt, Meta), `type:TEXT`, `wait:MS`, `shot:FILE.png`, `eval:JS`. `click`, `dbl` and the
start of `drag` (`drag:@sel,X2,Y2`) also take `@<css selector>` (the centre of the first match,
scrolled into view); `wheel` and a drag's end take numbers only. A modifier held with `down:` goes
with the clicks, drags and keys after it until its `up:` (`"down:Shift" "click:@.a" "up:Shift"`).

For pages that record audio, `start --fake-mic speech.wav` grants the microphone and plays the WAV
in a loop as its input. The page has to be a secure context (`https`, or `localhost` /
`127.0.0.1`). Make the WAV with any text-to-speech that writes one: on macOS
`say -o speech.wav --data-format=LEI16@48000 "…"`, on Linux `espeak-ng -w speech.wav "…"`.

Plain JS through `eval` covers the rest; it runs arbitrary JS in the page and awaits promises:

```bash
node $B eval "document.querySelector('button.submit').click()"
node $B eval "await new Promise(r => setTimeout(r, 1000)); document.title"   # wait, then read
node $B eval "[...document.querySelectorAll('a')].map(a => a.href)"          # extract data as JSON
```

After a click that triggers navigation, give the page a moment (the `eval` wait pattern above) or
re-run `tabs` to see the new URL.

## WebKit, Firefox and scripts of your own

The commands drive Chromium. For a page in WebKit (the engine of Safari and of macOS web views) or
Firefox, or for a longer run in Playwright's API, write a script against the Playwright this skill
launches its browser with; it is installed already, and `playwright` prints the line that imports
it, from anywhere, and whether Playwright's own WebKit and Firefox are on the machine:

```bash
node $B playwright
# import { chromium, firefox, webkit } from "file:///…/node_modules/playwright-core/index.mjs";
# webkit: installed
# firefox: not installed (playwright install firefox)
```

Put that line at the top of the script (`probe.mjs`, say, anywhere) and run it with `node` or `bun`:

```js
const browser = await webkit.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4480/');
console.log(await page.evaluate(() => getSelection()?.toString()));
await browser.close();
```

A browser that is not installed yet comes with `node $B playwright install webkit` (a download, once
per machine; on Linux `install --with-deps webkit` also brings the system libraries it needs). A
script can also attach to this session's own Chromium, muted as it is:
`chromium.connectOverCDP('http://127.0.0.1:<port>')`, the port from `status`; its `close()` then
only disconnects.

## Notes

- `open`/`nav` wait up to 20 s for full load, then print a warning and continue; slow SPAs may need
  an extra `eval`-based wait for a specific element.
- Screenshots are PNG; view them with the Read tool.
- "No browser running in this session" or "stale state cleaned up" just mean: run `start` (again),
  as after a restart of the session.
- A headless page runs `requestAnimationFrame`, so camera flights and animations finish here,
  unlike in a hidden tab of a desktop browser.
