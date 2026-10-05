import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { excerpt, excerptOf, excerptText, findTranscript } from './transcript';

const SAMPLE = join(import.meta.dir, 'fixtures', 'transcript.jsonl');
const sample = () => readFileSync(SAMPLE, 'utf8');

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('transcript excerpt', () => {
  test('finds failed calls, corrections, repeated commands and rewritten files, with the words around them', () => {
    const e = excerpt(sample())!;
    // the subagent's call is not the worker's
    expect(e.steps).toBe(13);
    expect(e.firstChange).toBe(4);
    const [flags, script, typecheck, polling, rewrite] = e.findings;
    expect(flags).toMatchObject({
      kind: 'retry',
      calls: [
        { step: 3, tool: 'Bash', what: '`bun run dev --port=4500`', failed: true, before: 'Ich starte den Server.' },
        { step: 4, what: '`bun run dev -p 4500`', failed: false, after: 'Läuft auf 4500.' },
      ],
    });
    expect(flags?.kind === 'retry' && flags.calls[0]!.error).toContain("unknown option '--port=4500'");
    expect(script).toMatchObject({ kind: 'failure', call: { step: 6, what: '`bun scripts/demo.ts`', after: 'Das Skript scheitert; ich schreibe es neu.' } });
    expect(script?.kind === 'failure' && script.call.error).toContain('TypeError: x is undefined');
    // `bun test` cut off by a restart is no mistake
    expect(typecheck).toMatchObject({ kind: 'failure', call: { step: 9, what: '`bun run typecheck`', before: 'Obeya startet neu.', after: 'Ein Tippfehler; ich korrigiere ihn.' } });
    expect(polling).toMatchObject({ kind: 'retry', calls: [{ step: 11 }, { step: 12 }, { step: 13 }] });
    expect(rewrite).toEqual({ kind: 'rewrite', file: '/ws/card/scripts/demo.ts', times: 2, before: 'Das Skript scheitert; ich schreibe es neu.' });
    expect(e.findings).toHaveLength(5);
  });

  test('reads as one text for the model, run by run', () => {
    const e = excerpt(sample())!;
    const text = excerptText([{ steps: 40, firstChange: 3, findings: [] }, e]);
    expect(text).toContain('Run 2 of 2: 13 tool calls, the first change to a file after 4.');
    expect(text).toContain('2 similar Bash calls in a row, 1 failed');
    expect(text).toContain("Error: Exit code 1\n   error: unknown option '--port=4500'");
    expect(text).toContain('/ws/card/scripts/demo.ts written whole 2 times.');
    expect(excerptText([{ steps: 40, firstChange: 3, findings: [] }])).toBe('');
  });

  test('a long error keeps its start and its end', () => {
    const line = (o: object) => JSON.stringify(o);
    const long = `Exit code 1\n${'x'.repeat(3000)}\nthe cause`;
    const jsonl = [
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'make' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: long, is_error: true }] } }),
    ].join('\n');
    const f = excerpt(jsonl)!.findings[0]!;
    const error = f.kind === 'failure' ? f.call.error! : '';
    expect(error.startsWith('Exit code 1')).toBe(true);
    expect(error.endsWith('the cause')).toBe(true);
    expect(error.length).toBeLessThan(900);
  });

  test('a run without anything gone wrong, a file of another format, or no file gives no excerpt', () => {
    dir = mkdtempSync(join(tmpdir(), 'obeya-tr-'));
    const smooth = join(dir, 'smooth.jsonl');
    writeFileSync(
      smooth,
      [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'bun test' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    expect(excerpt(readFileSync(smooth, 'utf8'))).toMatchObject({ steps: 1, findings: [] });
    expect(excerptOf(smooth)).toBeNull();
    const other = join(dir, 'other.jsonl');
    writeFileSync(other, '{"kind":"event","payload":{"calls":[]}}\nnot json at all\n');
    expect(excerpt(readFileSync(other, 'utf8'))).toBeNull();
    expect(excerptOf(other)).toBeNull();
    expect(excerptOf(join(dir, 'missing.jsonl'))).toBeNull();
    expect(excerptOf(null)).toBeNull();
    expect(excerptOf(SAMPLE)!.findings).toHaveLength(5);
  });

  test('finds a session’s file under its working directory, or in any directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'obeya-tr-'));
    const id = '11111111-2222-3333-4444-555555555555';
    mkdirSync(join(dir, '-Users-me--obeya-workspaces-c-1'));
    writeFileSync(join(dir, '-Users-me--obeya-workspaces-c-1', `${id}.jsonl`), sample());
    expect(findTranscript(id, '/Users/me/.obeya/workspaces/c/1', dir)).toBe(join(dir, '-Users-me--obeya-workspaces-c-1', `${id}.jsonl`));
    expect(findTranscript(id, '/somewhere/else', dir)).toBe(join(dir, '-Users-me--obeya-workspaces-c-1', `${id}.jsonl`));
    expect(findTranscript(id, null, dir)).not.toBeNull();
    expect(findTranscript('22222222-0000-0000-0000-000000000000', null, dir)).toBeNull();
    expect(findTranscript('../../etc/passwd', null, dir)).toBeNull();
    expect(findTranscript(id, null, join(dir, 'missing'))).toBeNull();
  });
});
