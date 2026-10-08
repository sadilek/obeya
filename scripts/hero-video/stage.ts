// The canvas the hero video starts on, as a stage file for `scripts/scratch-obeya.ts`: the Tipjar app
// beside this file as the repository, a plan doc with three workstreams, and cards in the states the
// video talks about. Positions are chosen so that the card the video creates lands in view and nothing
// sits under the microphone or the minimap.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const PORT = 4730;
const APP = join(import.meta.dirname, 'tipjar');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

export function writeStage(file: string) {
  const all = Object.fromEntries(files(APP).map((p) => [relative(APP, p), readFileSync(p, 'utf8')]));
  const plans = Object.fromEntries(Object.entries(all).filter(([p]) => p.startsWith('docs/plan/')));
  const rest = Object.fromEntries(Object.entries(all).filter(([p]) => !p.startsWith('docs/plan/')));
  const stage = {
    port: PORT,
    dir: `/tmp/obeya-scratch-${PORT}`,
    // the repository's own adapter (.obeya/adapter/): work lands on main, every change gets a demo
    adapter: '',
    files: rest,
    plans,
    cards: [
      { key: 'P', project: 'docs/plan/tipjar-2.md', x: 60, y: 120 },
      { key: 'D', title: 'Dark mode', body: 'Tipjar follows the system’s dark mode.', state: 'live', x: 960, y: 100, createdAgo: '1d' },
      // working without an agent: no workspace, so a scratch Obeya with real workers leaves it be
      { key: 'C', title: 'Run the tests on every push', body: 'A GitHub Actions workflow runs bun test on every push and pull request.', state: 'working', statusLine: 'Writing the workflow', scope: ['.github/workflows/test.yml'], x: 960, y: 300 },
      { key: 'I', title: 'App icon', body: 'An icon for the home screen.', state: 'waiting', need: 'question', question: { text: 'Which of the three drafts should become the icon?', options: ['The jar', 'The coin', 'The receipt'] }, scope: ['icon.svg'], x: 280, y: 560 },
      {
        key: 'T',
        title: 'Settle up after a trip',
        body: 'Several bills over a weekend, several people: who owes whom at the end.',
        state: 'idea',
        x: 650,
        y: 560,
        row: {
          idea: {
            status: 'open',
            brief: 'Settle a whole trip, not one bill: several bills, several people, who pays whom.\n\n## Variants\n- A shared list of bills per trip\n- Balances and who pays whom\n\n## Effort\nSeveral parts that build on each other: a project.',
            thinking: false,
            yourTurn: true,
            questions: [],
            next: { step: 'planDoc', why: 'Several parts that build on each other.' },
            variants: [],
            mocks: [],
          },
        },
      },
      {
        key: 'Q',
        title: 'Remember the last tip',
        body: 'Tipjar opens with the tip percentage chosen last time.',
        state: 'proposal',
        x: -40,
        y: 520,
        row: { proposal: { reason: 'Noticed while working on Dark mode: most people pick the same tip every time.', questions: [] } },
      },
    ],
    groups: [{ name: 'Tipjar 2.0', cards: ['P'] }],
  };
  writeFileSync(file, JSON.stringify(stage, null, 1));
}
