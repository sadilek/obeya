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
const NO_FILE = /^(?:\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)|&\d*-?|\d+-?|-)$/;

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
      // arithmetic: a value, no command
      const close = line.indexOf('))', i);
      word = (word ?? '') + line.slice(i, close < 0 ? line.length : close + 2);
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
        if (!target) return null;
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
  ('sleep wc cat head tail ls pwd echo printf true false test [ [[ ]] : stat file du df date which whoami id uname hostname ' +
    'grep egrep fgrep rg ag cut tr nl md5 md5sum shasum sha1sum sha256sum sha512sum cksum diff cmp comm basename dirname ' +
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
      return !args.some((a) => /^(?:-o|--output)/.test(a) || /^-[^-]*o/.test(a));
    case 'uniq':
      // a second operand is where it writes
      return operands.length <= 1;
    case 'find':
      return !args.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a));
    case 'sed':
      // in place, or a script that writes (`w file`, `s/…/…/w file`)
      return !args.some((a) => /^(?:-[^-]*[iI]|--in-place)/.test(a) || /(?:^|[\s;}\/\d])[wW]\s/.test(a));
    case 'awk':
    case 'gawk':
      // a program that redirects or runs a command, or edits in place
      return !args.some((a) => /[>|]|system\s*\(|^-i/.test(a));
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
  const list = tokens(withoutHeredocs(command));
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
        while (words[i]?.startsWith('-')) i += words[i] === '-n' || words[i] === '-u' ? 2 : 1;
      } else if (/^g?timeout$/.test(w)) {
        i++;
        while (words[i]?.startsWith('-')) i += /^-[ks]$/.test(words[i]!) ? 2 : 1;
        i++;
      } else break;
    }
    const name = words[i]!.replace(/^.*\//, '');
    return readOnly(name, words.slice(i + 1));
  };
  for (const t of list) {
    if ('word' in t) words.push(t.word);
    else if ('redirect' in t) {
      if (/^(?:>|>>|>\||&>|&>>|<>)$/.test(t.redirect) && !NO_FILE.test(t.to)) return false;
      if (t.redirect === '>&' && !NO_FILE.test(t.to)) return false;
    } else {
      if (!done()) return false;
      words = [];
    }
  }
  return done();
}
