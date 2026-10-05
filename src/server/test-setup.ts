// Preloaded by `bun test` (bunfig.toml): its hooks run once around all test files.

import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemplates } from './testing';

// the Arbeitsrückschau looks for transcripts there: never the machine's own. The live tests need
// the machine's login from there, so they set it back while they run (from `OBEYA_MACHINE_CLAUDE_CONFIG_DIR`).
if (process.env.CLAUDE_CONFIG_DIR) process.env.OBEYA_MACHINE_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const claude = (process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'obeya-claude-')));

afterAll(() => {
  removeTemplates();
  rmSync(claude, { recursive: true, force: true });
});
