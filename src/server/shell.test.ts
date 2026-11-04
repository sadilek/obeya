import { describe, expect, test } from 'bun:test';
import { writesNothing } from './shell';

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
    ])
      expect([c, writesNothing(c)]).toEqual([c, false]);
  });
});
