// The canvas the hero video starts on, as a stage file for `scripts/scratch-obeya.ts`: the Tipjar app
// beside this file as the repository, a plan doc with three workstreams, and cards in the states the
// video talks about. Positions are chosen so that the card the video creates lands in view and nothing
// sits under the microphone or the minimap.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scratchDir } from '../common';

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
    dir: scratchDir(PORT),
    name: 'Tipjar',
    // the repository's settings (.obeya/settings.json) among the files: work lands on main
    files: rest,
    plans,
    cards: [
      { key: 'P', project: 'docs/plan/tipjar-2.md', x: 60, y: 120 },
      { key: 'D', title: 'Dark mode', body: 'Tipjar follows the system’s dark mode.', state: 'live', x: 1030, y: 110, createdAgo: '1d' },
      // hangs off Dark mode with a dashed line, where Obeya puts a proposal: right below the card it came from
      {
        key: 'Q',
        title: 'Remember the last tip',
        body: 'Tipjar opens with the tip percentage chosen last time.',
        state: 'proposal',
        from: 'D',
        row: { proposal: { reason: 'Noticed while working on Dark mode: most people pick the same tip every time.', questions: [] } },
      },
      // Obeya's own proposal, from its work retrospective over the finished cards' runs
      {
        key: 'R',
        title: 'A script that serves Tipjar for demos',
        body: 'Agents searched for how to serve the app before recording a demo. A script `bun run serve` starts it on a free port and prints the URL.',
        state: 'proposal',
        // archived until the video brings it back while the approved card lands (`unarchive`), so the
        // opening shows the wall without it
        archivedAgo: '1m',
        x: 1460,
        y: 330,
        row: { retro: 'On three cards the agent first searched for how to serve the app before it recorded its demo.' },
      },
      // working without an agent: no workspace, so a scratch Obeya with real workers leaves it be
      { key: 'C', title: 'Run the tests on every push', body: 'A GitHub Actions workflow runs bun test on every push and pull request.', state: 'working', statusLine: 'Writing the workflow', scope: ['.github/workflows/test.yml'], x: 610, y: 110 },
      { key: 'I', title: 'App icon', body: 'An icon for the home screen.', state: 'waiting', need: 'question', question: { text: 'Which of the three drafts should become the icon?', options: ['The jar', 'The coin', 'The receipt'] }, scope: ['icon.svg'], x: 610, y: 290 },
      {
        key: 'T',
        title: 'Settle up after a trip',
        body: 'Several bills over a weekend, several people: who owes whom at the end.',
        state: 'idea',
        x: 620,
        y: 560,
        // the discussion so far, which the video shows when it opens the idea
        events: [
          { kind: 'talk', author: 'explorer', text: 'Who pays during the trip: does each person pay some of the bills, or does one person pay for everything and the others pay back?', ago: '50m' },
          { kind: 'talk', author: 'owner', text: 'Everyone pays some of the bills.', ago: '45m' },
          {
            kind: 'talk',
            author: 'explorer',
            text: 'Then a trip needs a shared list of bills, and at the end the balances: who pays whom, in as few transfers as possible. Those are several parts that build on each other, so I would plan it as a project.',
            ago: '44m',
          },
        ],
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
    ],
    // the rules every agent follows, and one Obeya learned from the owner's answers and proposes
    preferences: [
      { text: 'Questions to me with at most three options.' },
      { text: 'Solve rebase conflicts yourself.' },
      { text: 'Every change to the bill gets a test with cents that do not split evenly.', state: 'proposed', card: 'C', quote: 'Test it with an odd amount, like 100 split three ways.' },
    ],
    // Launch's App icon is the card the video drags beside Look and feel, the group it makes with a lasso
    groups: [
      { name: 'Tipjar 2.0', cards: ['P'] },
      { name: 'Launch', cards: ['C', 'I'] },
    ],
  };
  writeFileSync(file, JSON.stringify(stage, null, 1));
}
