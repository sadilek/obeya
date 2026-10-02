// Prints how to run the app of the repository in the working directory for a demo, when one of
// Obeya's repo adapters knows the repository: the recipe a worker under Obeya finds in its brief.
// Run with Bun (`bun recipe.ts`), since it reads the adapters.

import { pickAdapter } from '../../../../src/adapters/index.ts';
import { repoInfo } from '../../../../src/server/repo.ts';

try {
  const adapter = pickAdapter(repoInfo(process.cwd()));
  console.log(adapter.demo?.howToRun ?? `No recipe for this repository (adapter ${adapter.name}): its own docs say how to start it.`);
} catch (e) {
  console.log(`No recipe: ${e instanceof Error ? e.message : e}. Run it in the repository whose app the demo shows.`);
}
