// Writes Obeya's sign and wordmark as files: bun scripts/logo.tsx (the PNGs need rsvg-convert).
// src/ui/logo/logo.svg is the favicon (the cards look the same on light and dark), wordmark.svg and
// wordmark-dark.svg carry the letters in the ink of either theme, logo.png stands in for the favicon
// where SVG is not taken, apple-touch-icon.png is the sign on the canvas's paper for home screens,
// app/icons/source.png the app's icon, from which `bunx tauri icon` makes the rest of app/icons/.
import { mkdirSync, writeFileSync } from 'fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sign, Wordmark } from '../src/ui/logo';

const dir = `${import.meta.dir}/../src/ui/logo`;
mkdirSync(dir, { recursive: true });
const write = (name: string, svg: string) => writeFileSync(`${dir}/${name}`, `${svg}\n`);
write('logo.svg', renderToStaticMarkup(<Sign />));
write('wordmark.svg', renderToStaticMarkup(<Wordmark ink="#1d1c1a" />));
write('wordmark-dark.svg', renderToStaticMarkup(<Wordmark ink="#eeeae3" />));

const png = async (svg: string, px: number, name: string) => {
  const p = Bun.spawn(['rsvg-convert', '-w', `${px}`, '-h', `${px}`, '-o', `${dir}/${name}`], { stdin: new Blob([svg]) });
  if ((await p.exited) !== 0) throw new Error(`rsvg-convert failed for ${name}`);
};
await png(renderToStaticMarkup(<Sign />), 64, 'logo.png');
// a touch icon is shown on an opaque square with rounded corners: the sign keeps a margin on paper
await png(
  `<svg width="180" height="180" viewBox="-6 -6 44 44" xmlns="http://www.w3.org/2000/svg"><rect x="-6" y="-6" width="44" height="44" fill="#f4f2ee"/>${renderToStaticMarkup(<Sign />).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg>`,
  180,
  'apple-touch-icon.png',
);
// an app icon is the sign on a rounded square of paper, with the margin macOS draws its icons with
await (async () => {
  const p = Bun.spawn(['rsvg-convert', '-w', '1024', '-h', '1024', '-o', `${import.meta.dir}/../app/icons/source.png`], {
    stdin: new Blob([
      `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><rect x="100" y="100" width="824" height="824" rx="185" fill="#f4f2ee"/><g transform="translate(240 240) scale(17)">${renderToStaticMarkup(<Sign />).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g></svg>`,
    ]),
  });
  if ((await p.exited) !== 0) throw new Error('rsvg-convert failed for the app icon');
})();
console.log(dir);
