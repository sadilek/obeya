// Prints how to run the app of the repository in the working directory, when its settings say
// (`app.run` in `.obeya/settings.json` on its default branch): the recipe a worker under Obeya
// finds in its brief. Run with Bun (`bun recipe.ts`), since it reads the settings.

import { readShared } from '../../../../src/adapters/index.ts';
import { repoInfo } from '../../../../src/server/repo.ts';

try {
  const run = (await readShared((await repoInfo(process.cwd())).path)).settings?.app?.run;
  console.log(run || 'No recipe for this repository: its own docs say how to start it.');
} catch (e) {
  console.log(`No recipe: ${e instanceof Error ? e.message : e}. Run it in the repository whose app the demo shows.`);
}
