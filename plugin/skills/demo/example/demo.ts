// A model demo script. A real one lives in its own directory under ~/demos/ and imports the
// director by its absolute path in the skill directory; this one sits inside the skill, so it
// imports it relatively. Typecheck only: it is not run.
import { runDemo, type Director } from '../lib/director.ts';

const URL = 'http://127.0.0.1:3000/';
const list = (d: Director) => d.page.locator('main .orders');

await runDemo(
  {
    title: 'Orders can be filtered by status',
    baseUrl: URL,
    // Unrecorded; cookies and storage carry into the recording. Reset or stage the app here, so
    // every take starts from the same state.
    login: async (page) => {
      await page.goto(`${URL}login`);
      await page.getByRole('button', { name: 'Sign in as admin' }).click();
    },
    // The opening shot, also unrecorded.
    open: async (d) => {
      await d.goto('/orders');
      await list(d).waitFor();
    },
    scenes: [
      {
        title: 'The situation',
        say: 'The order list showed every order at once. With a few hundred of them, the open ones were hard to find.',
        run: async (d) => {
          await d.highlight(list(d));
          await d.untilSpoken(1);
        },
      },
      {
        title: 'The filter',
        say: 'Above the list there is now a status filter. Choosing open leaves only the orders that still wait for delivery.',
        run: async (d) => {
          const filter = d.page.getByLabel('Status');
          await d.highlight(filter, 'new');
          await d.untilSpoken(0.5);
          await d.click(filter);
          await d.click(d.page.getByRole('option', { name: 'Open' }));
          await d.highlight(list(d));
        },
      },
      {
        title: 'Recap',
        say: 'The filter makes the open orders one click away. Ready to release.',
      },
    ],
    report: {
      summary: 'The order list gets a status filter, so open orders can be found without scrolling.',
      shown: ['The status filter above the list', 'Filtering for open orders'],
      notShown: ['The filter in the mobile layout: the same component, checked in a test'],
      findings: [],
      meta: { branch: 'orders-filter (2 commits)', stack: 'local dev server, seeded data' },
    },
  },
  import.meta.dirname,
);
