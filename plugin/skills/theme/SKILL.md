---
name: theme
description: Write a repository's theme for its shared demo pages (`.obeya/theme.css`) — the colour variables for light and dark, a logo — from the repository's own look, preview the pages with it, and show them in a demo. Use when a task asks for a theme or the look of a repository's demo pages, or names this skill.
---

# Writing a repository's theme

A repository's shared demo pages (each demo's page and the overview of all of them) look like
Obeya's own until the repository has `.obeya/theme.css`. Obeya puts that file into every page after
its own style, as the default branch has it. What a theme can style, and what goes in of the files
it names, is in the section "A repository's theme" of
`${CLAUDE_SKILL_DIR}/../../../docs/design/sharing-demos.md`; where the checkout lacks it, the
template below names what each variable colours.

The result is a theme whose pages a colleague recognises as the project's: its colours in light and
dark, its logo where it has one, every text readable on its ground.

## 1. Find the project's look

From the files rather than by guessing:

- **Colours**: the app's own stylesheets and design tokens: CSS custom properties (`:root { --… }`),
  a Tailwind or UnoCSS config, SCSS variables, a theme file of its UI library (MUI, Chakra,
  Vuetify …), a mobile app's colour resources, `theme-color` in its HTML or web manifest. Note the
  background, surface, text, secondary text, border and the brand or primary colour, for light and
  for dark where the app has a dark mode.
- **Logo**: an SVG or PNG in `public/`, `static/`, `assets/`, `docs/`, the favicon or the README's
  header image. Prefer SVG; a variant for dark ground where there is one.
- **Fonts**: only where the app ships its font files in the repository (a font from an address on
  the internet does not load on the pages).

Where the repository has no look of its own (a library, a CLI without a site), say so to the owner
and ask which colours to take rather than invent a brand.

## 2. Write the theme

Copy `${CLAUDE_SKILL_DIR}/template.css` to `.obeya/theme.css` and fill it in:

- each of the seven variables in light and in dark, keeping the comment on what it colours;
- `--ink` on `--bg` and on `--card`, `--muted` on `--card` and `--accent` as a link on `--bg` must
  stay readable (4.5:1 contrast for text); a brand colour too light for links gets a darker shade
  as `--accent`;
- the logo copied into `.obeya/` beside the theme, the rule for it enabled; a logo in a dark mode
  that does not read on dark ground gets its dark variant there.

Rules beyond the variables (a font, rounder corners) only where the project's look needs them; the
pages' markup the design doc lists is what they may address.

## 3. Preview the pages

```
bun ${CLAUDE_SKILL_DIR}/lib/preview.ts [<out>] [--video <mp4>]
```

run in the repository, writes sample pages and the overview with the theme as the checkout has it
(committed or not), put in as Obeya does it, and the same pages in Obeya's own look; it prints the
pages to open. Look at them light and dark (the browser's colour scheme, `prefers-color-scheme`;
`obeya:browser` or Playwright's `emulateMedia`), and fix what is off: text hard to read, a logo cut
off or too large, a colour that is not the project's.

## 4. The demo

The demo shows the shared pages in the project's colours: the overview and a page in Obeya's own
look, then with the theme, light and dark. Record it on the preview's pages (a `--video` of the
app, where one is at hand, fills their player). Commit `.obeya/theme.css` and the files it names;
once on the default branch, Obeya's pages carry it, and the pages shared before show as outdated
until they are shared again.
