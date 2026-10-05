// Preloaded by `bun test` (bunfig.toml): its hooks run once around all test files.

import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemplates } from './testing';

// the Arbeitsrückschau looks for transcripts there: never the machine's own
const claude = (process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'obeya-claude-')));

afterAll(() => {
  removeTemplates();
  rmSync(claude, { recursive: true, force: true });
});
