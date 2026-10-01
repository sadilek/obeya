// Preloaded by `bun test` (bunfig.toml): its hooks run once around all test files.

import { afterAll } from 'bun:test';
import { removeTemplates } from './testing';

afterAll(removeTemplates);
