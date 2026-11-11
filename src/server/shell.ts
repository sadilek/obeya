// Reading a shell command line without running it: what Obeya tells from an agent's command alone.

/** A command word that runs what it reads as shell code: a shell, or `ssh` running it elsewhere. */
export const SHELL = /^(?:\S*\/)?(?:(?:ba|z|da|k|mk)?sh|ssh)$/;

/**
 * The command line without the text of its heredocs (`cat > f <<'EOF' … EOF`, a commit message in
 * `"$(cat <<'EOF' … EOF)"`): only data, unless the command it is fed to, or one the heredoc's
 * command pipes into, is a shell. Single quotes hide `<<`, double quotes too, except within `$(…)`.
 */
export function withoutHeredocs(command: string): string {
  // what the scanner is in: code (the line itself or a `$(…)`/`(…)`, closed by `)`) or a double-quoted string
  const modes: ('line' | 'paren' | 'dq')[] = ['line'];
  const pending: { delimiter: string; tabs: boolean; keep: boolean }[] = [];
  let out = '';
  for (let i = 0; i < command.length; ) {
    const mode = modes.at(-1)!;
    const c = command[i]!;
    let unit = c;
    if (c === '\\') unit = command.slice(i, i + 2);
    else if (mode === 'dq') {
      if (c === '"') modes.pop();
      else if (command.startsWith('$(', i)) (unit = '$('), modes.push('paren');
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      unit = command.slice(i, end < 0 ? command.length : end + 1);
    } else if (c === '"') modes.push('dq');
    else if (c === '(') modes.push('paren');
    else if (c === ')' && mode === 'paren') modes.pop();
    else if (c === '#' && /^$|[\s;&|()]$/.test(out.slice(-1))) unit = command.slice(i).match(/^[^\n]*/)![0];
    else if (command.startsWith('<<<', i)) unit = '<<<';
    else if (command.startsWith('<<', i)) {
      const op = command.slice(i).match(/^<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|()<>'"\\])+)/);
      const delimiter = op?.[2]!.replace(/['"\\]/g, '');
      if (op && delimiter && /[A-Za-z_]/.test(delimiter)) {
        unit = op[0];
        // the pipeline the heredoc belongs to: back to the last command separator, on to the next one in its line
        const before = out.split(/[;&\n(]|\|\|/).at(-1)!;
        const after = command.slice(i + unit.length).split(/[;&\n)]|\|\|/)[0]!;
        const words = `${before} ${after}`.replace(/['"]/g, ' ').split(/[\s|]+/);
        pending.push({ delimiter, tabs: op[1] === '-', keep: words.some((w) => SHELL.test(w)) });
      }
    } else if (c === '\n' && pending.length > 0) {
      // the bodies follow this line, one after another, each up to the line that is its delimiter
      out += '\n';
      i++;
      for (const h of pending.splice(0)) {
        let end = i;
        for (;;) {
          const next = command.indexOf('\n', end);
          const line = command.slice(end, next < 0 ? command.length : next);
          if (next < 0 || (h.tabs ? line.replace(/^\t+/, '') : line) === h.delimiter) {
            end = next < 0 ? command.length : next + 1;
            break;
          }
          end = next + 1;
        }
        if (h.keep) out += command.slice(i, end);
        i = end;
      }
      continue;
    }
    out += unit;
    i += unit.length;
  }
  return out;
}

/** A token of a command line: a word, a separator between commands, or a redirection with its target. */
type Token = { word: string } | { op: string } | { redirect: string; to: string };

/** Where output may go without writing a file. */
const NO_FILE = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/;
/** What `>&` may duplicate or close: a file descriptor, not a file. */
const DESCRIPTOR = /^(?:\d+-?|-)$/;
/** A substitution, whose commands run: `$(…)` (not arithmetic `$((…))`) or backticks. */
const SUBSTITUTION = /\$\((?!\()|`/;

/**
 * The command line as words, separators and redirections, quotes taken off; null for what is not
 * read here (a substitution inside double quotes, a process substitution that is written to).
 * A command substitution `$(…)` and backticks separate commands, as the commands inside them run.
 */
function tokens(line: string): Token[] | null {
  const out: Token[] = [];
  let word: string | null = null;
  const end = () => {
    if (word !== null) out.push({ word });
    word = null;
  };
  for (let i = 0; i < line.length; ) {
    const c = line[i]!;
    const rest = line.slice(i);
    if (c === '\\') {
      if (line[i + 1] !== '\n') word = (word ?? '') + (line[i + 1] ?? '');
      i += 2;
    } else if (c === "'") {
      const close = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, close < 0 ? line.length : close);
      i = close < 0 ? line.length : close + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '`' || (line.startsWith('$(', j) && !line.startsWith('$((', j))) return null;
        if (line[j] === '\\') j++;
        s += line[j] ?? '';
      }
      word = (word ?? '') + s;
      i = j + 1;
    } else if (c === '#' && word === null) {
      const nl = line.indexOf('\n', i);
      i = nl < 0 ? line.length : nl;
    } else if (rest.startsWith('$((')) {
      // arithmetic: a value, no command, unless a substitution in it runs one
      const close = line.indexOf('))', i);
      const text = line.slice(i, close < 0 ? line.length : close + 2);
      if (SUBSTITUTION.test(text.slice(3))) return null;
      word = (word ?? '') + text;
      i = close < 0 ? line.length : close + 2;
    } else if (rest.startsWith('$(') || c === '`' || rest.startsWith('<(')) {
      end();
      out.push({ op: '(' });
      i += c === '`' ? 1 : 2;
    } else if (rest.startsWith('>(')) return null;
    else {
      const op = /^(?:&>>?|\d*(?:>>|>\||>&|<<<|<<-?|<&|<>|>|<))/.exec(rest)?.[0];
      // a number right before a redirection is its file descriptor, not a word
      if (op && (/^[&<>]/.test(op) || word === null)) {
        end();
        i += op.length;
        while (line[i] === ' ' || line[i] === '\t') i++;
        // the target is the next word, read as any word is
        const text = line.slice(i).match(/^(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s;&|()<>'"\\])*/)![0];
        const target = tokens(text);
        // a target that runs a command (`< \`…\``) is not read here
        if (!target || target.some((t) => !('word' in t))) return null;
        i += text.length;
        out.push({ redirect: op.replace(/^\d+/, ''), to: target.map((t) => ('word' in t ? t.word : '')).join('') });
      } else if (/^(?:&&|\|\||\|&)/.test(rest)) {
        end();
        out.push({ op: rest.slice(0, 2) });
        i += 2;
      } else if (/[;&|()\n]/.test(c)) {
        end();
        out.push({ op: c });
        i++;
      } else if (c === ' ' || c === '\t' || c === '\r') {
        end();
        i++;
      } else {
        word = (word ?? '') + c;
        i++;
      }
    }
  }
  end();
  return out;
}

/** Programs that write no file, whatever their arguments: they read, print, compare or wait. */
const READERS = new Set(
  ('sleep wc cat head tail ls pwd echo printf true false test [ [[ ]] : stat du df date which whoami id uname hostname ' +
    'grep egrep fgrep ag cut tr nl md5 md5sum shasum sha1sum sha256sum sha512sum cksum diff cmp comm basename dirname ' +
    'realpath readlink tree column jq wait cd pushd popd type seq expr od hexdump strings rev tac paste join fold numfmt ps ' +
    'pgrep uptime read exit return break continue let local declare export unset set shift').split(' '),
);

/** Words of the shell's own syntax that start a command or stand where one could: what follows them is the command. */
const KEYWORDS = new Set(['!', 'time', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '{', '}']);

/** Whether `args` of the program `name` (one of the readers with options that write, or one only some of whose uses write) write no file. */
function readOnly(name: string, args: string[]): boolean {
  if (READERS.has(name)) return true;
  const operands = args.filter((a) => !a.startsWith('-'));
  switch (name) {
    case 'sort':
      // `--o` is as good as `--output`
      return !args.some((a) => /^(?:-[^-]*o|--o)/.test(a));
    case 'rg':
      // a preprocessor it runs on each file
      return !args.some((a) => /^--(?:pre|hostname-bin)(?:=|$)/.test(a));
    case 'file':
      // compiling a magic file writes it
      return !args.some((a) => /^(?:-[^-]*C|--c)/.test(a));
    case 'uniq':
      // a second operand is where it writes
      return operands.length <= 1;
    case 'find':
      return !args.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a));
    case 'sed':
      // in place, a script from a file, or one that may write or run a command (`w file`, `s/…/…/wfile`, `e`)
      return !args.some((a) => /^(?:-[^-]*[iIf]|--in-place|--file)/.test(a) || /(?:^|[^A-Za-z])[wWe]/.test(a.replace(/^(?:--expression=|-[A-Za-z]*e)/, '')));
    case 'awk':
    case 'gawk':
      // a program from a file, one that redirects or runs a command, or edits in place
      return !args.some((a) => /[>|]|system\s*\(|^-[if]|^--(?:file|include)/.test(a));
    default:
      return false;
  }
}

/**
 * Whether a command line writes no file, read from the line alone: each of its commands is a
 * program that only reads, prints or waits (`sleep 30; wc -l out/export.csv`), and no output is
 * redirected into a file. What a line runs that is not known here (a script, a program with
 * options that write, `xargs`, a shell, a function) may write, and so does a line that is not
 * read to its end.
 */
export function writesNothing(command: string): boolean {
  const text = withoutHeredocs(command);
  // a substitution in a heredoc's text runs, though the text itself is only data
  const runs = (s: string) => s.match(new RegExp(SUBSTITUTION, 'g'))?.length ?? 0;
  if (runs(text) < runs(command)) return false;
  // a heredoc's delimiter with a quote inside its quotes is not read here
  if (/<<-?\s*(?:"[^"\n]*'|'[^'\n]*")/.test(command)) return false;
  const list = tokens(text);
  if (!list?.some((t) => 'word' in t)) return false;
  let words: string[] = [];
  const done = (): boolean => {
    let i = 0;
    // what precedes the command: keywords, variables set for it, prefixes that run it
    for (;;) {
      const w = words[i];
      if (w === undefined) return true;
      if (KEYWORDS.has(w) || /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(w)) i++;
      else if (w === 'for' || w === 'select') return true;
      else if (w === 'command' || w === 'builtin' || w === 'nice' || w === 'env') {
        i++;
        // of the options, only those that run nothing else (`env -S '…'` runs its string)
        while (words[i]?.startsWith('-')) {
          if (!/^-(?:[inpu]|-ignore-environment|-unset=.*)$/.test(words[i]!)) return false;
          i += words[i] === '-n' || words[i] === '-u' ? 2 : 1;
        }
      } else if (/^g?timeout$/.test(w)) {
        i++;
        while (words[i]?.startsWith('-')) i += /^-[ks]$/.test(words[i]!) ? 2 : 1;
        i++;
      } else break;
    }
    // a program by its path may be anything (`./cat`)
    if (words[i]!.includes('/')) return false;
    return readOnly(words[i]!, words.slice(i + 1));
  };
  for (const t of list) {
    // a substitution even in quotes may run (`let 'a[$(…)]=0'`)
    if ('word' in t && SUBSTITUTION.test(t.word)) return false;
    if ('word' in t) words.push(t.word);
    else if ('redirect' in t) {
      if (/^(?:>|>>|>\||&>|&>>|<>)$/.test(t.redirect) && !NO_FILE.test(t.to)) return false;
      if (t.redirect === '>&' && !NO_FILE.test(t.to) && !DESCRIPTOR.test(t.to)) return false;
    } else {
      if (!done()) return false;
      words = [];
    }
  }
  return done();
}

/** A foreground command may sleep this long; anything longer keeps the owner's notes from the agent. */
export const FOREGROUND_SLEEP_LIMIT = 30;

/** Short waits the refusal suggests; both pass it (tested), the first also where `timeout` is missing (macOS). */
export const BOUNDED_WAITS = [
  'for i in $(seq 1 15); do curl -sf localhost:3000 && break; sleep 2; done',
  "timeout 30 bash -c 'until curl -sf localhost:3000; do sleep 2; done'",
];

/**
 * How many seconds a shell command sleeps in the foreground, read from the command line alone:
 * `sleep` with its durations (`sleep 90`, `sleep 5m`, `sleep 1m 30s`), times the iterations of the
 * loop it is in (a `for` over a word list, `seq` or `{a..b}`; `while` and `until` have no bound).
 * A command that `timeout N` starts counts at most N, wherever it stands (`cd app && timeout 30 bash
 * -c 'until …; do sleep 2; done'`). What runs behind `&` does not count, nor does the text of a
 * heredoc unless a shell runs it (`bash <<EOF`, `cat <<EOF | sh`). Commands that only sleep inside
 * scripts or programs they call are not seen.
 */
export function foregroundSleep(command: string): number {
  // redirections such as 2>&1 are words, not `&`
  const tokens = boundTimeouts(withoutHeredocs(command)).replace(/['"`]/g, ' ').match(/\d*[<>]&\d*-?|&>>?|&&|\|\||[;&|(){}\n]|[^\s;&|(){}<>]+|[<>]+/g) ?? [];
  // per open loop or group (and the command line itself): seconds of finished commands, and of the one in progress
  type Frame = { done: number; current: number; iterations: number; closer: string };
  const stack: Frame[] = [{ done: 0, current: 0, iterations: 1, closer: '' }];
  const top = () => stack.at(-1)!;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === 'sleep') {
      let s = 0;
      while (i + 1 < tokens.length && /^(\d+(\.\d+)?[smhd]?|inf(inity)?)$/.test(tokens[i + 1]!)) s += seconds(tokens[++i]!);
      top().current += s;
    } else if (t === 'while' || t === 'until') stack.push({ done: 0, current: 0, iterations: Infinity, closer: 'done' });
    else if (t === '(' || t === '{') stack.push({ done: 0, current: 0, iterations: 1, closer: t === '(' ? ')' : '}' });
    else if (t === 'for') {
      // the words up to `do` say how often the body runs
      const header: string[] = [];
      while (i + 1 < tokens.length && tokens[i + 1] !== 'do') header.push(tokens[++i]!);
      stack.push({ done: 0, current: 0, iterations: iterations(header), closer: 'done' });
    } else if (t === top().closer) {
      const loop = stack.pop()!;
      const body = loop.done + loop.current;
      top().current += body > 0 ? body * loop.iterations : 0;
    } else if (t === '&') top().current = 0;
    else if (t === ';' || t === '&&' || t === '||' || t === '\n') {
      top().done += top().current;
      top().current = 0;
    }
  }
  // loops left open (a command line cut off) count as they stand
  let total = 0;
  for (let k = stack.length - 1; k >= 0; k--) {
    const f = stack[k]!;
    const body = f.done + f.current + total;
    total = body > 0 ? body * f.iterations : 0;
  }
  return total;
}

/** `timeout` (or coreutils' `gtimeout` on macOS) where a command begins: variables set for it, options, then the duration. */
const TIMEOUT = /^(?:\w+=\S*\s+)*g?timeout(?:\s+(?:-[ks]\s*\S+|--?[a-zA-Z][\w-]*(?:=\S+)?))*\s+(\d+(?:\.\d+)?[smhd]?)(?=\s)/;

/** Words after which a command begins, as after `;`. */
const COMMAND_BEFORE = new Set(['do', 'then', 'else', 'elif', '!', 'time']);

/**
 * The command line with each command that `timeout N` starts replaced by a `sleep` as long as it
 * can wait: N, or less if what it runs sleeps less (`timeout 0` sets no bound). Quotes count here,
 * so a loop handed to `bash -c '…'` stays in the command it belongs to.
 */
function boundTimeouts(command: string): string {
  let out = '';
  let start = true;
  for (let i = 0; i < command.length; ) {
    const rest = command.slice(i);
    const t = start ? TIMEOUT.exec(rest) : null;
    if (t) {
      const end = i + commandEnd(rest);
      const bound = seconds(t[1]!) || Infinity;
      out += `sleep ${Math.min(bound, foregroundSleep(command.slice(i + t[0].length, end)))} `;
      i = end;
      start = false;
      continue;
    }
    const unit = rest.match(/^(?:[ \t]+|\d*[<>]&\d*-?|&>>?|[<>]+|[;&|(){}\n]|'[^']*'?|"(?:\\.|[^"\\])*"?|\\.|[^\s;&|(){}<>'"\\]+)/)?.[0] ?? rest[0]!;
    out += unit;
    i += unit.length;
    if (/^[;&|({\n]$/.test(unit)) start = true;
    else if (!/^[ \t]+$/.test(unit) && !/^\d*[<>]/.test(unit)) start = COMMAND_BEFORE.has(unit);
  }
  return out;
}

/** Where the command at the start of `text` ends: at `;`, `&`, `|`, a line break or a `)` it did not open, outside quotes. */
function commandEnd(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\') i++;
    else if (c === "'") i = text.indexOf("'", i + 1) < 0 ? text.length : text.indexOf("'", i + 1);
    else if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && depth-- === 0) return i;
    else if (c === '&' && (/[<>]/.test(text[i - 1] ?? '') || text[i + 1] === '>')) continue;
    else if (/[;&|\n]/.test(c) && depth === 0) return i;
  }
  return text.length;
}

function seconds(d: string): number {
  if (d.startsWith('inf')) return Infinity;
  const n = Number.parseFloat(d);
  return n * ({ m: 60, h: 3600, d: 86400 }[d.at(-1)!] ?? 1);
}

/** How often a `for` runs from its header (`i in a b c`, `i in $(seq 1 60)`, `i in {1..60}`); unknown counts as unbounded. */
function iterations(header: string[]): number {
  const at = header.indexOf('in');
  if (at < 0) return Infinity;
  const words = header.slice(at + 1).filter((w) => !/^(&&|\|\||[;&|(){}\n])$/.test(w));
  const list = words.join(' ');
  const range = list.match(/^(-?\d+)\.\.(-?\d+)$/);
  if (range) return Math.abs(Number(range[2]) - Number(range[1])) + 1;
  const seq = list.match(/^\$? ?seq (-?\d+)(?: (-?\d+))?(?: (-?\d+))?$/);
  if (seq) {
    const [first, step, last] =
      seq[3] !== undefined ? [Number(seq[1]), Number(seq[2]), Number(seq[3])] : seq[2] !== undefined ? [Number(seq[1]), 1, Number(seq[2])] : [1, 1, Number(seq[1])];
    return step === 0 ? Infinity : Math.max(0, Math.floor((last - first) / step) + 1);
  }
  return words.some((w) => w.startsWith('$')) ? Infinity : words.length;
}
