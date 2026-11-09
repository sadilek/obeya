// Writes the video player of Obeya's cards and demo pages into obeya.si: `site/player.js` (the player
// as `obeyaPlayer`, src/server/demo-page.ts) and `site/player.css` (src/core/player.css), which the
// hero video on site/index.html plays in. Both are built, not kept in git: the Pages workflow runs this
// before it publishes, and a look at the site from the checkout needs it run once.
//
//   bun scripts/site-player.ts [<site dir>]
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sitePlayerScript } from '../src/server/demo-page';
import PLAYER_STYLE from '../src/core/player.css' with { type: 'text' };

const site = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'site'));
writeFileSync(join(site, 'player.js'), sitePlayerScript());
writeFileSync(join(site, 'player.css'), PLAYER_STYLE);
console.log(`player.js and player.css written to ${site}`);
