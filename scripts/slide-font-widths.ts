// Measures the advance widths of the faces a walkthrough's slides are set in, in Chrome, for the fit
// check in src/server/slide-checks.ts (`WIDTHS`): run it after the slides' fonts, weights or
// letter-spacing change in src/ui/styles.css (`.wt-*`), and paste what it prints over `WIDTHS`.
//
//   bun scripts/slide-font-widths.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHARS, FACES } from '../src/server/slide-checks';

const fonts = join(import.meta.dir, '../src/ui/fonts');
const face = (family: string, file: string, weights: string) =>
  `@font-face { font-family: "${family}"; font-weight: ${weights}; src: url(data:font/woff2;base64,${readFileSync(join(fonts, file)).toString('base64')}) format("woff2"); }`;
const page = `<!doctype html><style>
${face('Inter', 'inter-latin-wght-normal.woff2', '100 900')}
${face('Bricolage Grotesque', 'bricolage-grotesque-latin-wght-normal.woff2', '200 800')}
span { white-space: pre; font-size: 100px; font-kerning: none; }
</style><body></body>`;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const tab = await browser.newPage();
  await tab.setContent(page);
  const widths = await tab.evaluate(
    async ({ chars, faces }) => {
      const out: Record<string, string> = {};
      for (const [name, f] of Object.entries(faces)) {
        await document.fonts.load(`${f.weight} 100px "${f.family}"`);
        const per = [...chars].map((c) => {
          const s = document.createElement('span');
          s.style.cssText = `font-family: "${f.family}"; font-weight: ${f.weight}; letter-spacing: ${f.tracking}em`;
          // twenty of it, so a width of a fraction of a pixel adds up
          s.textContent = c.repeat(20);
          document.body.append(s);
          const w = s.getBoundingClientRect().width / 20;
          s.remove();
          return Math.round(w);
        });
        out[name] = per.join(',');
      }
      return out;
    },
    { chars: CHARS, faces: FACES },
  );
  console.log('const WIDTHS = {');
  for (const [name, list] of Object.entries(widths)) console.log(`  ${name}: '${list}',`);
  console.log('};');
} finally {
  await browser.close();
}
