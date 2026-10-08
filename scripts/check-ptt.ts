// Checks the app's push-to-talk key in another app (app/src/ptt.rs) on this machine, without
// pressing keys and without a microphone: the shell runs with OBEYA_PTT_CHECK, reads the key from
// stdin and takes a WAV as the recording. Against an Obeya that runs on <home> (the shell opens
// its window on it), it checks:
//   - the shell tells the server what it hears, and the server shows it (`GET /api/push-to-talk`);
//   - a tap of the key shows nothing and sends nothing;
//   - held, then another key with it (a shortcut): the panel shows that Obeya listens, then goes;
//     nothing is sent;
//   - held 1.5 s and let go: the panel shows, the recording goes to the canvas's `/voice`, and
//     Obeya's answer comes back to the panel (with what Whisper heard, when it heard something).
//
//   bun scripts/check-ptt.ts <the app's program> <home of a running Obeya> <speech.wav>
//   bun scripts/check-ptt.ts <the app's program> <home of a running Obeya> --keyboard
//
// --keyboard (X11, with xdotool): the shell hears the real keyboard (XInput2) and records the real
// microphone; xdotool presses the default key, right Ctrl. The last check then asks only that the
// recording reached Obeya, which without Whisper answers with an error.
//
// The program may be the installed app's or the checkout's shell (app/target/checkout/release/obeya
// after `bun run app`). Prints one line per check; exits 1 when one failed.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [programArg, homeArg, wavArg] = process.argv.slice(2);
if (!programArg || !homeArg || !wavArg) {
  console.error('usage: bun scripts/check-ptt.ts <the app\'s program> <home of a running Obeya> (<speech.wav> | --keyboard)');
  process.exit(2);
}
const keyboard = wavArg === '--keyboard';
const home = resolve(homeArg);
const { port } = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8')) as { port: number };
const base = `http://127.0.0.1:${port}`;

let failed = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = async (what: string, fn: () => Promise<string | void>) => {
  try {
    const detail = await fn();
    console.log(`✓ ${what}${detail ? `: ${detail}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
};
const expect = (cond: unknown, why: string) => {
  if (!cond) throw new Error(why);
};

const shell = Bun.spawn([resolve(programArg)], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
  env: { ...process.env, OBEYA_HOME: home, OBEYA_PTT_CHECK: keyboard ? 'keyboard' : resolve(wavArg) },
});
/** What the shell printed: `panel <height>` when the panel fits its lines, `heard <answer>`. */
const lines: string[] = [];
void (async () => {
  let rest = '';
  for await (const chunk of shell.stdout) {
    rest += new TextDecoder().decode(chunk);
    const parts = rest.split('\n');
    rest = parts.pop()!;
    lines.push(...parts);
  }
})();
const key = (k: 'down' | 'up' | 'other') => {
  if (keyboard) {
    // right Ctrl, the default on Linux; another key is a letter typed with it
    Bun.spawnSync(['xdotool', ...(k === 'other' ? ['key', 'a'] : [k === 'down' ? 'keydown' : 'keyup', 'Control_R'])]);
    return;
  }
  shell.stdin.write(`${k}\n`);
  shell.stdin.flush();
};
async function seen(prefix: string, ms: number, from = 0) {
  const deadline = Date.now() + ms;
  for (;;) {
    const line = lines.slice(from).find((l) => l.startsWith(prefix));
    if (line !== undefined) return line;
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}

try {
  await check('the shell reports what it hears', async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const view = (await (await fetch(`${base}/api/push-to-talk`)).json()) as { key: string; shell: { state: string; platform: string } | null };
      if (view.shell) {
        expect(view.shell.state === 'on', `the shell says ${JSON.stringify(view.shell)}`);
        return `${view.shell.platform}, ${view.shell.state}, key ${view.key}`;
      }
      expect(Date.now() < deadline, 'no report within 30 s');
      await sleep(500);
    }
  });
  // the panel's page loads meanwhile
  await sleep(2000);

  await check('a tap shows nothing and sends nothing', async () => {
    const from = lines.length;
    key('down');
    await sleep(100);
    key('up');
    await sleep(1500);
    expect(!lines.slice(from).length, `the shell said ${lines.slice(from).join(' | ')}`);
  });

  await check('held with another key: the panel shows, then goes, and nothing is sent', async () => {
    const from = lines.length;
    key('down');
    const shown = await seen('panel ', 3000, from);
    expect(shown && Number(shown.split(' ')[1]) > 0, 'the panel did not show');
    key('other');
    const gone = await seen('panel 0', 3000, from);
    expect(gone, 'the panel stayed');
    key('up');
    await sleep(1500);
    expect(!lines.slice(from).some((l) => l.startsWith('heard')), 'it was sent');
    return shown!;
  });

  await check('held and let go: the recording goes to Obeya and the answer to the panel', async () => {
    const from = lines.length;
    key('down');
    await sleep(1500);
    key('up');
    const heard = await seen('heard ', 150_000, from);
    expect(heard, 'no answer within 150 s');
    const sent = lines.slice(from).find((l) => l.startsWith('sent '))!;
    if (keyboard) {
      expect(sent !== 'sent 0', 'the recording did not reach Obeya');
      return `${sent}, ${heard}`;
    }
    const answer = JSON.parse(heard!.slice(6)) as { confirm?: string; text?: string } | null;
    expect(answer?.confirm, `the answer was ${heard}`);
    return `${answer!.text ? `„${answer!.text}“ → ` : ''}${answer!.confirm}`;
  });
} finally {
  shell.kill();
}
process.exit(failed ? 1 : 0);
