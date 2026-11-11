import { expect, test } from 'bun:test';

// The app's webview is WebKit (macOS, WebKitGTK on Linux), which knows `user-select` only by its
// prefix: without it, dragging a card selects some of its text there.
test('every user-select in the stylesheet also carries its -webkit- prefix', async () => {
  const css = await Bun.file(new URL('./styles.css', import.meta.url)).text();
  const rules = css.split('}').filter((r) => /(^|[^-])user-select:/.test(r));
  expect(rules.length).toBeGreaterThan(0);
  for (const r of rules) {
    const plain = [...r.matchAll(/(?:^|[^-])user-select:\s*(\w+)/g)].map((m) => m[1]);
    const prefixed = [...r.matchAll(/-webkit-user-select:\s*(\w+)/g)].map((m) => m[1]);
    expect({ rule: r.trim(), prefixed }).toEqual({ rule: r.trim(), prefixed: plain });
  }
});

// The dark look stands twice: for the system's choice (a media query, which a page follows before
// any script runs) and for the owner's (`data-theme`). A colour changed in one block alone would
// show only to one kind of owner.
test("the dark look is the same whether the system or the owner chose it", async () => {
  const css = await Bun.file(new URL('./styles.css', import.meta.url)).text();
  const system = [...css.matchAll(/@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{([^}]*)\} \}/g)].map((m) => m[1]!.trim());
  const chosen = [...css.matchAll(/:root\[data-theme="dark"\] \{([^}]*)\}/g)].map((m) => m[1]!.trim());
  expect(system.length).toBeGreaterThan(1);
  expect(chosen).toEqual(system);
});
