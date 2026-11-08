import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// React counts a component's hooks on every render: a hook called below an early return is skipped
// once the component takes that return, and React throws ("Rendered fewer hooks than expected").
// A card's detail stays mounted while the card changes form (a planned task becomes an idea, say),
// so it takes a different return without being mounted afresh. The check reads the sources as they
// are formatted: a component's top-level statements are indented by two spaces.

/** The top-level functions of a source: their name, first line and lines. */
function functions(src: string) {
  const lines = src.split('\n');
  const found: { name: string; line: number; body: string[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = /^(?:export )?(?:default )?function (\w+)/.exec(lines[i] ?? '')?.[1];
    if (!name) continue;
    const end = lines.findIndex((l, j) => j > i && l === '}');
    if (end < 0) continue;
    found.push({ name, line: i + 1, body: lines.slice(i + 1, end) });
    i = end;
  }
  return found;
}

/** Hook calls that come after the function's first return, with their line in the source. */
function hooksAfterReturn(body: string[], first: number): string[] {
  let returned = false;
  let statement = '';
  const late: string[] = [];
  body.forEach((l, i) => {
    if (/^ {2}\S/.test(l)) statement = l.trim();
    if (returned) {
      for (const m of l.matchAll(/\b(use[A-Z]\w*)\(/g)) late.push(`${first + i + 1}: ${m[1]}`);
      return;
    }
    // a return of the function's own: at its top level, or in an if at its top level
    if (/^ {2}(return\b|if \(.*\)\s*return\b)/.test(l)) returned = true;
    else if (/^ {4}return\b/.test(l) && /^(if \(|\} else)/.test(statement)) returned = true;
  });
  return late;
}

test('the check finds a hook below an early return', () => {
  const src = ['function Card(p: Props) {', '  const [a] = useState(0);', '  if (p.idea)', '    return <Idea />;', '  const b = useDraft(p.id);', '  return <Task />;', '}'].join('\n');
  const [f] = functions(src);
  expect(f && hooksAfterReturn(f.body, f.line)).toEqual(['5: useDraft']);
});

test('no component calls a hook after an early return', () => {
  const dir = import.meta.dir;
  const late: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const f of functions(src)) {
      if (!/^([A-Z]|use[A-Z])/.test(f.name)) continue;
      for (const at of hooksAfterReturn(f.body, f.line)) late.push(`${file}:${at} in ${f.name}`);
    }
  }
  expect(late).toEqual([]);
});
