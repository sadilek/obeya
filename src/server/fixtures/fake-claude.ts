// A stand-in for Claude Code on a host, for tests and demos, its state in `~/.fake-claude` there:
// `--version` says the version in `version`; `update` waits the milliseconds in `update-ms` (none:
// no wait), then moves it to the one in `newest`, or fails with the text in `update-fails`; a
// session answers the Agent SDK's `initialize` with the models in `models.json` and waits for stdin to close.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const state = join(process.env.HOME ?? homedir(), '.fake-claude');
const read = (name: string) => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8').trim() : undefined);
const [arg] = process.argv.slice(2);

if (arg === '--version') {
  console.log(`${read('version')} (Claude Code)`);
} else if (arg === 'update') {
  const from = read('version');
  console.log(`Current version: ${from}`);
  console.log('Checking for updates...');
  await Bun.sleep(Number(read('update-ms') ?? 0));
  const fails = read('update-fails');
  if (fails) {
    console.error(fails);
    process.exit(1);
  }
  const to = read('newest') ?? from;
  writeFileSync(join(state, 'version'), `${to}\n`);
  console.log(`Successfully updated from ${from} to version ${to}`);
} else {
  const models = JSON.parse(read('models.json') ?? '[]');
  for await (const line of createInterface({ input: process.stdin })) {
    let message: { type?: string; request_id?: string; request?: { subtype?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type === 'control_request' && message.request?.subtype === 'initialize')
      console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], agents: [], models, account: {} } } }));
  }
}
