// What Obeya needs on this machine, as one list for the setup assistant: shown on the first start
// (no canvases.json in Obeya's home), in the app and the checkout alike, and later from the
// settings. Claude Code with a login and git are needed; gh with a login is for pull requests;
// voice and demos are the checks the settings sheet makes (voice-setup.ts, the demo skill's
// setup.ts). What installs without admin rights Obeya installs at a click (Claude Code and uv with
// their official installers, Piper and Whisper through the voice's installation, a demo's voice);
// system software comes with the command for this platform, which Obeya runs at a click where it
// needs no password (Homebrew, winget); a login opens a terminal. Then the first canvas: a
// repository's folder, or a clone of one.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
// by its path: the package exports no package.json, which Bun imports all the same but TypeScript does not
import sdk from '../../node_modules/@anthropic-ai/claude-agent-sdk/package.json';
import type { FirstCanvas, MachineItem, MachineJob, MachineSection, MachineSectionId, MachineView } from '../core/types';
import { readDemoSettings } from '../../plugin/skills/demo/lib/settings.ts';
import { checkSetup, installHint, type LinuxFamily, linuxFamily, output } from '../../plugin/skills/demo/lib/setup.ts';
import { installVoice } from '../../plugin/skills/demo/lib/voices.ts';
import { BadRequest } from './board';
import type { CanvasRuntime } from './canvas';
import { type Config, expand } from './config';
import { COMPILED } from './resources';
import { claudeExecutable } from './runtime';
import type { ShellReports } from './push-key';
import { ownerLanguage, pushKeyChoice } from './settings';
import type { VoiceSetup } from './voice-setup';

type Env = Record<string, string | undefined>;

/** The Claude Code the Agent SDK brings, which Obeya was checked with. */
export const CHECKED_CLAUDE: string = sdk.claudeCodeVersion;

/** Where the official installers of Claude Code and uv put their programs. */
export const localBin = () => join(homedir(), '.local', 'bin');

/**
 * Puts the directories on the PATH that the programs Obeya checks and starts are installed in but
 * a process started from the desktop may lack: the official installers' `~/.local/bin`, and
 * Homebrew's on a Mac.
 */
export function extendPath(env: Env = process.env, platform: string = process.platform) {
  const dirs = [localBin(), ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])];
  const parts = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const d of dirs) if (existsSync(d) && !parts.includes(d)) parts.push(d);
  env.PATH = parts.join(delimiter);
}

/** On Windows, what installers added to the user's and the machine's PATH since Obeya started. */
async function windowsPath(env: Env) {
  const out = await output('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], env);
  if (!out) return;
  const parts = (env.PATH ?? '').split(';').filter(Boolean);
  for (const d of out.trim().split(';')) if (d && !parts.includes(d)) parts.push(d);
  env.PATH = parts.join(';');
}

/** The official installers, which need no admin rights: in a shell, or in PowerShell on Windows. */
const INSTALLERS = {
  claude: { unix: 'curl -fsSL https://claude.ai/install.sh | bash', win: 'irm https://claude.ai/install.ps1 | iex', url: 'https://code.claude.com/docs/en/setup' },
  uv: { unix: 'curl -LsSf https://astral.sh/uv/install.sh | sh', win: 'irm https://astral.sh/uv/install.ps1 | iex', url: 'https://docs.astral.sh/uv/getting-started/installation/' },
};

/** How to install what the needed parts and pull requests need, on this platform. */
export function machineHint(id: 'claude' | 'uv' | 'git' | 'gh', platform: string, family: LinuxFamily, brew: boolean): NonNullable<MachineItem['install']> {
  const win = platform === 'win32';
  if (id === 'claude' || id === 'uv') {
    const i = INSTALLERS[id];
    return { commands: [win ? i.win : i.unix], url: i.url };
  }
  const packages = { git: { winget: 'Git.Git', pacman: 'git', url: 'https://git-scm.com/downloads' }, gh: { winget: 'GitHub.cli', pacman: 'github-cli', url: 'https://cli.github.com' } }[id];
  const command =
    platform === 'darwin'
      ? // git comes with the Command Line Tools, which install without Homebrew
        brew || id === 'gh'
        ? `brew install ${id}`
        : 'xcode-select --install'
      : win
        ? `winget install --id ${packages.winget} -e`
        : family === 'apt'
          ? `sudo apt install ${id}`
          : family === 'dnf'
            ? `sudo dnf install ${id}`
            : family === 'pacman'
              ? `sudo pacman -S ${packages.pacman}`
              : null;
  return { commands: command ? [command] : [], url: packages.url };
}

/** How Obeya runs an install command at a click; `null` where it needs a password, or a program that is not there. */
export function runnable(command: string, env: Env, platform: string = process.platform): string[] | null {
  if (/^curl -\S+ https:\/\/\S+ \| (ba)?sh$/.test(command)) return platform === 'win32' ? null : ['sh', '-c', command];
  if (command.startsWith('irm ')) return platform === 'win32' ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command] : null;
  const [program, ...args] = command.split(' ');
  const at = Bun.which(program!, { PATH: env.PATH ?? '' });
  if (!at) return null;
  if (program === 'brew') return [at, ...args];
  if (program === 'winget') return [at, ...args, '--accept-source-agreements', '--accept-package-agreements'];
  // the Command Line Tools' own dialog
  if (command === 'xcode-select --install') return [at, ...args];
  return null;
}

/** The binary the SDK brings for this platform, where the checkout has it. */
function sdkClaude(platform: string, arch: string): string | null {
  const require = createRequire(import.meta.path);
  for (const name of [`${platform}-${arch}`, `${platform}-${arch}-musl`]) {
    try {
      const dir = resolve(require.resolve(`@anthropic-ai/claude-agent-sdk-${name}/package.json`), '..');
      const bin = join(dir, platform === 'win32' ? 'claude.exe' : 'claude');
      if (existsSync(bin)) return bin;
    } catch {}
  }
  return null;
}

/** A command as a shell shows it, its program quoted when its path has spaces. */
const shown = (argv: string[]) => argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');

/** Opens a terminal that runs `argv`; false where Obeya finds none to open (Linux without one it knows). */
export async function openTerminal(argv: string[], platform: string = process.platform, env: Env = process.env): Promise<boolean> {
  const line = shown(argv);
  const detached = (cmd: string, args: string[], o: { windowsVerbatimArguments?: boolean } = {}) =>
    new Promise<boolean>((done) => {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore', env, ...o });
      p.on('error', () => done(false));
      p.on('spawn', () => (p.unref(), done(true)));
    });
  if (platform === 'darwin') {
    const script = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return (await output('osascript', ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script "${script}"`, '-e', 'end tell'], env)) !== null;
  }
  if (platform === 'win32') return detached('cmd.exe', ['/c', `start "Obeya" cmd /k "${line}"`], { windowsVerbatimArguments: true });
  // the window stays open once the login ends, so what it said can be read
  const keep = ['sh', '-c', `${line}; printf '\\n'; read -r _`];
  for (const [program, ...flag] of [['x-terminal-emulator', '-e'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xfce4-terminal', '-x'], ['kitty'], ['alacritty', '-e'], ['xterm', '-e']] as const) {
    const at = Bun.which(program, { PATH: env.PATH ?? '' });
    if (at) return detached(at, [...flag, ...keep]);
  }
  return false;
}

/** The system's dialog for choosing a folder, where there is one: macOS, Windows, Linux with zenity or kdialog. */
function folderDialog(platform: string, env: Env, prompt: string): string[] | null {
  if (platform === 'darwin') return ['osascript', '-e', `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`];
  if (platform === 'win32')
    return [
      'powershell',
      '-NoProfile',
      '-STA',
      '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.ShowNewFolderButton = $false; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
    ];
  if (Bun.which('zenity', { PATH: env.PATH ?? '' })) return ['zenity', '--file-selection', '--directory', `--title=${prompt}`];
  if (Bun.which('kdialog', { PATH: env.PATH ?? '' })) return ['kdialog', '--getexistingdirectory', homedir(), '--title', prompt];
  return null;
}

/** A program's output, waiting as long as the owner takes (a dialog); null when it fails or is cancelled. */
function waited(argv: string[], env: Env): Promise<string | null> {
  return new Promise((done) => {
    const p = spawn(argv[0]!, argv.slice(1), { env, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => done(null));
    p.on('close', (code) => done(code === 0 ? out : null));
  });
}

/** The marker of a canvas the assistant created: once it runs, it gets a first card that says what to try. */
export const WELCOME_FILE = 'welcome';

/** Puts the first card on the canvas the assistant created, once, when it runs. */
export function welcome(home: string, canvases: CanvasRuntime[]) {
  const file = join(home, WELCOME_FILE);
  if (!existsSync(file)) return;
  const id = readFileSync(file, 'utf8').trim();
  rmSync(file, { force: true });
  const c = canvases.find((x) => x.id === id);
  if (!c) return;
  const items = c.board.snapshot().items;
  // right of the plan docs' projects the repository brings, at their top
  const at = items.length ? { x: Math.max(...items.map((i) => i.x)) + 560, y: Math.min(...items.map((i) => i.y)) } : { x: 0, y: 0 };
  const { title, body } = c.board.t.welcome;
  c.board.create({ title, body, ...at });
}

/** The clones a first canvas gets whose adapter works in clones. */
export const CLONES = 2;

/** The folder a clone gets: the repository's name, from a URL or `owner/name`. */
export function cloneName(spec: string): string {
  return (
    spec
      .trim()
      .replace(/[/\\]+$/, '')
      .replace(/\.git$/, '')
      .split(/[/:\\]/)
      .at(-1) ?? ''
  );
}

export interface MachineOptions {
  home: string;
  config: Config;
  /** Obeya's own voice check, with its installation; none in tests. */
  voice?: VoiceSetup;
  env?: Env;
  platform?: string;
  arch?: string;
  /** Whether this is the compiled binary, which runs the machine's Claude Code rather than the SDK's. */
  compiled?: boolean;
  /** Whether saving the first canvas starts Obeya again by itself. */
  restarts: boolean;
  /** The app's shell, for its push-to-talk key in another app (a line under voice while it runs). */
  shells?: ShellReports;
}

/** What the check found, with how Obeya acts on each piece. */
interface Found {
  sections: MachineSection[];
  /** The Claude Code that logs in, and gh's login. */
  logins: Partial<Record<MachineItem['id'], string[]>>;
}

export class MachineSetup {
  private job?: MachineJob;
  private canvasSaved = false;

  constructor(private o: MachineOptions) {}

  private get env() {
    return this.o.env ?? process.env;
  }
  private get platform() {
    return this.o.platform ?? process.platform;
  }

  async view(): Promise<MachineView> {
    const { sections } = await this.check();
    return {
      platform: this.platform,
      arch: this.o.arch ?? process.arch,
      sections,
      checkedClaude: CHECKED_CLAUDE,
      ...(this.job ? { job: { ...this.job } } : {}),
      picker: !!folderDialog(this.platform, this.env, ''),
      cloneInto: homedir(),
      restarts: this.o.restarts,
    };
  }

  private async check(): Promise<Found> {
    const env = this.env;
    const platform = this.platform;
    const arch = this.o.arch ?? process.arch;
    const family = platform === 'linux' ? linuxFamily() : null;
    const brew = platform === 'darwin' && !!Bun.which('brew', { PATH: env.PATH ?? '' });
    const hint = (id: 'claude' | 'uv' | 'git' | 'gh') => machineHint(id, platform, family, brew);
    /** A missing piece, offered at a click where its first command runs without a password. */
    const missing = (item: Omit<MachineItem, 'state'>): MachineItem => {
      const command = item.install?.commands[0];
      return { ...item, state: 'missing', ...(item.act || (command && runnable(command, env, platform)) ? { act: item.act ?? 'install' } : {}) };
    };
    const logins: Found['logins'] = {};

    const agentsPart = async (): Promise<MachineItem[]> => {
      // Claude Code: the checkout's agents run on the SDK's own binary, the compiled one's on the machine's
      const agents = claudeExecutable(env, this.o.compiled ?? COMPILED, platform);
      const own = Bun.which('claude', { PATH: env.PATH ?? '' });
      const items: MachineItem[] = [];
      let claude: string | null;
      if (!agents) {
        claude = own ?? sdkClaude(platform, arch);
        items.push({ id: 'claude', state: 'ok', found: `${CHECKED_CLAUDE} (Agent SDK)` });
      } else {
        const version = (await output(agents, ['--version'], env))?.match(/^(\d+\.\d+\.\d+)/)?.[1];
        claude = version ? agents : null;
        items.push(version ? { id: 'claude', state: 'ok', found: version } : missing({ id: 'claude', install: hint('claude') }));
      }
      const status = claude ? await output(claude, ['auth', 'status'], env) : null;
      let account: { loggedIn?: boolean; email?: string; authMethod?: string } = {};
      try {
        account = JSON.parse(status ?? '{}');
      } catch {}
      if (account.loggedIn) items.push({ id: 'claudeLogin', state: 'ok', found: account.email ?? account.authMethod ?? '' });
      else if (claude) {
        logins.claudeLogin = [claude, 'auth', 'login'];
        items.push(missing({ id: 'claudeLogin', install: { commands: [shown([claude === own ? 'claude' : claude, 'auth', 'login'])] }, act: 'login' }));
      } else items.push({ id: 'claudeLogin', state: 'missing' });
      return items;
    };

    const gitPart = async (): Promise<MachineItem[]> => {
      const git = (await output('git', ['--version'], env))?.match(/git version (\S+)/)?.[1];
      if (!git) return [missing({ id: 'git', install: hint('git') })];
      const [name, email] = (await Promise.all([output('git', ['config', '--global', 'user.name'], env), output('git', ['config', '--global', 'user.email'], env)])).map((x) => x?.trim());
      if (name && email) return [{ id: 'git', state: 'ok', found: git }, { id: 'gitUser', state: 'ok', found: `${name} <${email}>` }];
      const [n, e] = ownerLanguage(this.o.home) === 'de' ? ['Dein Name', 'du@example.com'] : ['Your Name', 'you@example.com'];
      const commands = [...(name ? [] : [`git config --global user.name "${n}"`]), ...(email ? [] : [`git config --global user.email "${e}"`])];
      return [
        { id: 'git', state: 'ok', found: git },
        { id: 'gitUser', state: 'missing', ...(name || email ? { found: (name || email)! } : {}), install: { commands }, act: 'identity' },
      ];
    };

    const prPart = async (): Promise<MachineItem[]> => {
      const gh = (await output('gh', ['--version'], env))?.match(/gh version (\S+)/)?.[1];
      if (!gh) return [missing({ id: 'gh', install: hint('gh') }), { id: 'ghLogin', state: 'missing' }];
      const auth = await output('gh', ['auth', 'status'], env);
      if (auth) return [{ id: 'gh', state: 'ok', found: gh }, { id: 'ghLogin', state: 'ok', found: auth.match(/account (\S+)/)?.[1] ?? '' }];
      logins.ghLogin = ['gh', 'auth', 'login'];
      return [{ id: 'gh', state: 'ok', found: gh }, missing({ id: 'ghLogin', install: { commands: ['gh auth login'] }, act: 'login' })];
    };

    const [claudeItems, gitItems, pr, voice, demo] = await Promise.all([
      agentsPart(),
      gitPart(),
      prPart(),
      this.o.voice ? this.o.voice.view() : null,
      checkSetup(readDemoSettings(this.o.home), { home: this.o.home, env }),
    ]);
    const needed = [...claudeItems, ...gitItems];
    // uv by its own installer, which needs no admin rights; the rest as the voice and demo checks say
    const ownUv = (i: MachineItem): MachineItem => (i.id === 'uv' && i.state === 'missing' ? missing({ id: 'uv', install: hint('uv') }) : i);
    // the app's key in another app, which on a Mac needs "Input Monitoring"
    const keyLine = this.o.shells?.item(pushKeyChoice(this.o.home).key);
    const keyItem = keyLine ? [keyLine] : [];
    const voiceItems = (voice?.items ?? []).map((i): MachineItem => {
      if (i.id === 'speech' && i.state === 'missing') return { ...i, act: 'install' };
      if (i.id === 'whisper' && i.state === 'later') return { ...i, act: 'install' };
      if (i.state === 'missing' && i.id !== 'whisper') return ownUv(missing(i));
      return i;
    });
    const demoItems = demo.items
      .map((i): MachineItem => (i.id === 'voice' && i.state === 'missing' ? { ...i, act: 'install' } : i.state === 'missing' ? ownUv(missing(i)) : i))
      // what the voice needs too shows once, unless demos need more of it (ffmpeg with libx264)
      .filter((i) => !voiceItems.some((v) => v.id === i.id && v.state === i.state && i.id !== 'whisper'));
    const mb = (items: MachineItem[]) => items.reduce((n, i) => n + (i.state === 'missing' || i.state === 'later' ? (i.mb ?? 0) : 0), 0);
    const sections: MachineSection[] = [
      { id: 'needed', items: needed, mb: 0 },
      { id: 'pr', items: pr, mb: 0 },
      ...(voice ? [{ id: 'voice' as const, items: [...voiceItems, ...keyItem], mb: voice.fetch.mb }] : []),
      { id: 'demos', items: demoItems, mb: mb(demoItems) },
    ];
    return { sections, logins };
  }

  private async item(section: MachineSectionId, id: MachineItem['id']) {
    const found = await this.check();
    const item = found.sections.find((s) => s.id === section)?.items.find((i) => i.id === id);
    if (!item) throw new BadRequest('invalid', `no ${id} among ${section}`);
    return { item, found };
  }

  /** Installs one piece in the background; the view says how far it got. */
  async install(input: unknown): Promise<MachineView> {
    const { section, id } = (input ?? {}) as { section?: MachineSectionId; id?: MachineItem['id'] };
    if (this.job?.running) throw new BadRequest('setupBusy', 'an installation or a clone is running');
    const { item } = await this.item(section!, id!);
    if (item.act !== 'install') throw new BadRequest('invalid', `Obeya does not install ${id}`);
    const job: MachineJob = (this.job = { kind: 'install', section, id, running: true, line: '' });
    const log = (line: string) => (job.line = line.slice(0, 300));
    let work: Promise<void>;
    if (section === 'voice' && (id === 'speech' || id === 'whisper')) {
      const voice = this.o.voice!;
      work = voice.install().then(() => voice.finished());
    } else if (section === 'demos' && id === 'voice') work = installVoice(readDemoSettings(this.o.home), log, this.o.home);
    else {
      const argv = runnable(item.install!.commands[0]!, this.env, this.platform)!;
      work = this.run(argv, log);
    }
    console.log(`Obeya: installing ${id} (${section})`);
    work
      .then(async () => {
        if (this.platform === 'win32') await windowsPath(this.env);
        extendPath(this.env, this.platform);
        console.log(`Obeya: ${id} installed`);
      })
      .catch((e: Error) => {
        job.error = e.message;
        console.error(`Obeya: installing ${id} failed: ${e.message}`);
      })
      .finally(() => (job.running = false));
    return this.view();
  }

  /** Runs a program for a job, its output's last line shown as it goes. */
  private run(argv: string[], log: (line: string) => void): Promise<void> {
    return new Promise((done, fail) => {
      const p = spawn(argv[0]!, argv.slice(1), { env: this.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let last = '';
      const take = (d: Buffer) => {
        // progress comes with carriage returns; the line is what it shows last
        const lines = String(d).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
        if (lines.length) log((last = lines.at(-1)!));
      };
      p.stdout.on('data', take);
      p.stderr.on('data', take);
      p.on('error', fail);
      p.on('close', (code) => (code === 0 ? done() : fail(new Error(`${shown(argv.slice(0, 3))} exited with ${code}${last ? `: ${last}` : ''}`))));
    });
  }

  /** Opens a terminal that logs in; `opened: false` where Obeya finds none, and the command is to be run by hand. */
  async login(input: unknown): Promise<{ opened: boolean }> {
    const { section, id } = (input ?? {}) as { section?: MachineSectionId; id?: MachineItem['id'] };
    const { item, found } = await this.item(section!, id!);
    const argv = found.logins[item.id];
    if (item.act !== 'login' || !argv) throw new BadRequest('invalid', `${id} needs no login`);
    return { opened: await openTerminal(argv, this.platform, this.env) };
  }

  /** git's name and e-mail for commits, as the owner gives them. */
  async identity(input: unknown): Promise<MachineView> {
    const { name, email } = (input ?? {}) as { name?: unknown; email?: unknown };
    for (const [key, value] of [
      ['user.name', name],
      ['user.email', email],
    ] as const) {
      if (typeof value !== 'string' || !value.trim()) continue;
      if ((await output('git', ['config', '--global', key, value.trim()], this.env)) === null) throw new BadRequest('invalid', `git config ${key} failed`);
    }
    return this.view();
  }

  /** A folder chosen in the system's dialog; null when the owner cancelled it. */
  async pick(prompt: string): Promise<{ path: string | null }> {
    const argv = folderDialog(this.platform, this.env, prompt);
    if (!argv) throw new BadRequest('invalid', 'no folder dialog here');
    const out = (await waited(argv, this.env))?.trim();
    return { path: out ? out.replace(/(?<=.)[/\\]$/, '') : null };
  }

  /** The first canvas: a repository's folder, saved at once; or a clone of one, in the background. */
  async canvas(input: unknown): Promise<FirstCanvas | MachineView> {
    const { path, clone, into } = (input ?? {}) as { path?: unknown; clone?: unknown; into?: unknown };
    if (typeof path === 'string' && path.trim()) return this.add(resolve(expand(path.trim())));
    if (typeof clone !== 'string' || !clone.trim()) throw new BadRequest('invalid', 'a folder or a repository to clone');
    if (this.job?.running) throw new BadRequest('setupBusy', 'an installation or a clone is running');
    const spec = clone.trim();
    const name = cloneName(spec);
    if (!name) throw new BadRequest('invalid', `no repository in ${spec}`);
    const dest = join(resolve(expand(typeof into === 'string' && into.trim() ? into.trim() : homedir())), name);
    if (existsSync(dest)) throw new BadRequest('cloneTarget', `${dest} exists`);
    // owner/name through gh where it is logged in (private repositories too), else from GitHub by its URL
    const short = /^[\w.-]+\/[\w.-]+$/.test(spec);
    const gh = short && (await output('gh', ['auth', 'status'], this.env)) !== null;
    const argv = gh ? ['gh', 'repo', 'clone', spec, dest, '--', '--progress'] : ['git', 'clone', '--progress', short ? `https://github.com/${spec}.git` : spec, dest];
    const job: MachineJob = (this.job = { kind: 'clone', running: true, line: '' });
    console.log(`Obeya: cloning ${spec} into ${dest}`);
    this.run(argv, (line) => (job.line = line.slice(0, 300)))
      .then(() => {
        job.canvas = this.add(dest).canvas;
      })
      .catch((e: Error) => {
        job.error = e instanceof BadRequest ? e.message : e.message.split('\n').at(-1)!;
        console.error(`Obeya: cloning ${spec} failed: ${e.message}`);
      })
      .finally(() => (job.running = false));
    return this.view();
  }

  /** Adds the repository as a canvas of its own and saves the configuration; Obeya starts again with it. */
  private add(path: string): FirstCanvas {
    if (this.canvasSaved) throw new BadRequest('setupBusy', 'the first canvas is saved; Obeya starts again with it');
    let next = [...this.o.config.current(), { repos: [{ path }] }];
    let { problems, resolved } = this.o.config.check(next);
    // an adapter that works in clones gets two, so two cards can be worked on at once
    if (resolved.at(-1)?.repos[0]?.workspaces === 'clones') {
      next = [...next.slice(0, -1), { repos: [{ path, clones: CLONES }] }];
      ({ problems, resolved } = this.o.config.check(next));
    }
    const problem = problems[0];
    if (problem) throw new BadRequest(problem.code === 'notRepo' ? 'notRepo' : 'config', problem.detail);
    const canvas = resolved.at(-1)!.id;
    writeFileSync(join(this.o.home, WELCOME_FILE), canvas);
    const { restarting } = this.o.config.save(next);
    this.canvasSaved = restarting;
    return { canvas, restarting };
  }
}
