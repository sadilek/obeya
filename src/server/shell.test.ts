import { describe, expect, test } from 'bun:test';
import { foregroundSleep, writesNothing } from './shell';

describe('writesNothing', () => {
  test('commands that only read, print or wait', () => {
    for (const c of [
      'sleep 30',
      'sleep 90; wc -l out/export.csv',
      'ls -la out/ 2>/dev/null || echo "no export yet"',
      'cd out && wc -l export.csv',
      'while [ ! -f out/export.csv ]; do sleep 5; done; head -3 out/export.csv',
      'for f in out/*.csv; do wc -l "$f"; done',
      'cat out/export.csv | sort | uniq -c | head',
      "sed -n '1,80p' notes.md",
      "awk -F, '{print $1}' out/export.csv",
      'grep -rn TODO . 2>&1 | head -20',
      'find . -name "*.csv" -mtime -1',
      'timeout 30 tail -f log.txt',
      'wc -l < out/export.csv',
      'echo "rows: $((1 + 2))"',
      'test -f out/export.csv && echo yes # check',
      'cat <<EOF\nnot a write > here\nEOF',
      'ls $(dirname out/export.csv)',
      'FOO=1 env LANG=C wc -l out/export.csv',
      'wc -l out/export.csv >&2',
      'ls missing 2>&-',
      "sed -n '/^## /p' notes.md",
    ])
      expect([c, writesNothing(c)]).toEqual([c, true]);
  });

  test('commands that may write', () => {
    for (const c of [
      '',
      'python3 make_report.py',
      'seq 1 10 > out/n.txt',
      'echo hi >> log.txt',
      'wc -l out/export.csv &> counts.txt',
      'sort -o sorted.txt in.txt',
      'uniq in.txt out.txt',
      'sed -i "" s/a/b/ notes.md',
      "sed 's/a/b/w changed.txt' notes.md",
      "awk '{print > \"x\"}' in",
      'find . -name "*.tmp" -delete',
      'find . -exec rm {} +',
      'ls | xargs rm',
      'cat in | tee out',
      'mkdir -p out && touch out/x',
      'bash -c "sleep 1"',
      'cat > notes.md <<EOF\nhello\nEOF',
      'echo "$(rm -rf out)"',
      'wc -l <(sort in) >(cat > x)',
      '$EDITOR notes.md',
      'f() { rm x; }; f',
      'case $x in a) rm y;; esac',
      'echo hi > 123',
      "echo hi > '&1'",
      'cat <<EOF\n$(touch out)\nEOF',
      'echo $(( $(touch out; echo 1) + 1 ))',
      'cat <`touch out; echo in`',
      'awk -f write.awk in',
      'sed -f write.sed in',
      "sed 's|a|b|w out' in",
      "sed --expression='w out' in",
      "sed -e'w out' in",
      "sed 's/a/touch x/e' in",
      './cat',
      "env --split-string='touch out' echo hi",
      'echo hi >&out.txt',
      'rg --pre=./pre a in',
      'file -C -m magic',
      "sed 'wout' /dev/null",
      "sed 's/x/y/wout' in",
      "sed $'w\\x20out' /dev/null",
      'sort --out=out in',
      'file --com -m magic',
      "let 'a[$(touch out)]=0'",
      "declare -a 'a[$(touch out)]=x'",
      'rg --hostname-bin=./writer x in',
      'cat <<"E\'OF"\nhello\nE\'OF\ntouch out',
    ])
      expect([c, writesNothing(c)]).toEqual([c, false]);
  });
});

test('foreground sleep: sleep durations, loops, bounds and background', () => {
  const cases: [string, number][] = [
    ['sleep 290', 290],
    ['sleep 5m', 300],
    ['sleep 1m 30s', 90],
    ['sleep 0.5', 0.5],
    ['sleep 290 && curl -s https://example.com/health', 290],
    ['cd app; sleep 20; sleep 20', 40],
    ['sleep 60 2>&1', 60],
    // behind & it runs on while the command returns
    ['sleep 300 &', 0],
    ['(sleep 300; touch done) & echo started', 0],
    // loops: the body times the iterations, unbounded for while and until
    ['for i in $(seq 1 60); do curl -s x && break; sleep 5; done', 300],
    ['for i in {1..10}; do sleep 2; done', 20],
    ['for host in a b c; do ping -c1 $host; sleep 1; done', 3],
    ['until curl -s localhost:4000 >/dev/null; do sleep 0.5; done', Infinity],
    ['while true; do\n  gh run view 123 | grep -q completed && break\n  sleep 10\ndone', Infinity],
    ['for i in $(seq 1 5); do echo $i; done', 0],
    // timeout bounds the command it starts, wherever that stands, but not longer than it waits
    ["timeout 30 bash -c 'until curl -s localhost:4000; do sleep 1; done'", 30],
    ["cd app && timeout 28 bash -c 'until grep -q ready log; do sleep 2; done' && cat log", 28],
    ['PORT=4000 gtimeout -k 5 --foreground 20s bash -c "until curl -s localhost:\\$PORT; do sleep 1; done"', 20],
    ["for i in 1 2 3; do timeout 10 bash -c 'until test -f x; do sleep 1; done'; done", 30],
    ["timeout 20 bash -c 'until test -f x; do sleep 1; done'; sleep 60", 80],
    ['timeout 600 sleep 5', 5],
    ['timeout 5 curl -s x 2>&1 | head', 0],
    ['timeout 0 sleep 60', 60],
    ['timeout 300 sleep 300 &', 0],
    ['sleep infinity', Infinity],
    // a heredoc's text is data, unless a shell runs it
    ["cat > wait.sh <<'EOF'\nuntil curl -s x; do sleep 2; done\nEOF\nchmod +x wait.sh", 0],
    ['cat > wait.sh <<EOF\nuntil curl -s x; do sleep 2; done\nEOF\nsleep 5', 5],
    ['cat <<-END > f\n\twhile true; do sleep 1; done\n\tEND', 0],
    ['git commit -m "$(cat <<\'EOF\'\nWait until the server is up; do sleep 2; done\nEOF\n)"', 0],
    ["cat > a <<'A' && cat > b <<'B'\nsleep 100\nA\nsleep 200\nB\nsleep 3", 3],
    ["bash <<'EOF'\nuntil curl -s x; do sleep 2; done\nEOF", Infinity],
    ['ssh host bash -s <<EOF\nsleep 60\nEOF', 60],
    ["cat <<'EOF' | sh\nsleep 60\nEOF", 60],
    ["cat > f <<'EOF' && bash f\nsleep 60\nEOF", 0],
    // no heredoc: a here-string, `<<` in quotes or a comment, a shift
    ['grep -q x <<< "$out"; sleep 40', 40],
    ["echo 'a <<b'\nsleep 40\nb", 40],
    ['echo "a <<b"\nsleep 40\nb', 40],
    ['# cat <<EOF\nsleep 40\nEOF', 40],
    ['echo $((1<<4))\nsleep 40\n4', 40],
    ['bun test', 0],
    ['git log --oneline | head', 0],
  ];
  for (const [command, s] of cases) expect([command, foregroundSleep(command)]).toEqual([command, s]);
});
