# S: sharing, demo sites, demo pages (`share.ts`, `site.ts`, `site-hosts.ts`, `site-setup.ts`, `personal-site.ts`, `demo-page.ts`, `demo.ts`, `demo-space.ts`, `artifact-copy.ts`, `theme.ts`, `slide-checks.ts`)

> Findings of the YAGNI, DRY and KISS review, part of [`code-cleanup.md`](../code-cleanup.md): read its
> "How to work from this" first. Line numbers are those of commit `acfa0484`.

The slice is careful code with almost no literal copies, and `demo-space.ts`, `slide-checks.ts`,
`personal-site.ts` and `theme.ts` are clean. Its two themes are structural: the page templates for
one version and for several versions repeat each other's markup and browser scripts, and the module
boundaries have drifted (`share.ts` and `site.ts` import each other, the template module holds the
demo-directory readers, the demo module serves files that are no demos, `site.ts` holds a sync
engine and a renderer). The rest are small helpers written twice and a few leftovers of the time
when a page could go to something other than a site.

## Findings

### S1. The single-version and several-version page templates repeat markup and scripts
- Principle: DRY
- Size: moderate
- Where: `src/server/demo-page.ts:460-467` vs `:662-667` (range probe), `:557-559` vs `:628-630`
  (chapter list), `:565` vs `:632-639` (video tag), `:571-580` vs `:668-675` (chapter clicks, big
  play button, current chapter), `:505-510` vs `:626-627` (artifact frame and its links), `:522-528`
  vs `:678-686` (frame height, `?alone`), `:428` vs `:444` (the player's `lib` object)
- Now: `demoPageHtml`, `artifactPageHtml` and `stackedPageHtml` each write these pieces themselves.
  The stacked page's script is the general form (a loop over every `.grid`, a map of frames with
  their step counts, `alone || '1'`); the single pages hold the same logic for one element under
  other variable names. `SEEKABLE` exists as a constant for the single page and again inline in the
  stacked script. `PLAYERS` and `sitePlayerScript` each spell out `{ captionPages, pageOf, cueWords,
  spokenWord, preferredTrack }`.
- Why it matters: every change to the player wiring, the range probe or the frame's height has to be
  made in two places and can drift unnoticed, since the scripts only run in a browser; the last
  three entries in `PAGE_CHANGES` are changes to the video pages.
- Change: shared fragments in `demo-page.ts`: `chapterList(chapters)`, `videoTag({ src?, poster?,
  silent?, tracks }, language)`, `artifactFrame(src, title)`, one `PLAYER_LIB` string, and two
  script constants used by all three pages: `VIDEO_WIRING` (the per-`.grid` loop; a video without a
  `src` attribute, the one-file export, gets `seekable = Promise.resolve()`) and `FRAME_HEIGHT` (the
  map of frames). The markup stays byte for byte; the single pages' scripts change, so `PAGES_HASH`
  is taken anew without a `PAGE_CHANGES` entry, which `page-changes.ts` provides for ("a refactoring
  ... gets none"). I would not go further to one page function for 1..n versions: it would put a
  `<section>` around a single page's demo, and the markup is the themes' interface (design,
  sharing-demos.md, "changes only on purpose").
- Win: about 40 lines, and one copy of each of four scripts.
- Risk: medium. `video-player.test.ts`, `share.test.ts` (export pages) and the pinned hash in
  `site.test.ts` cover the generated text; the scripts' behaviour needs one look in a browser at a
  video page, an artifact page with `?alone`, a stacked page and a one-file export.
- Confidence: high; both sides read line by line.

### S2. `share.ts` and `site.ts` import each other: the deploy-command helpers and the site's own types live in `share.ts`
- Principle: KISS
- Size: moderate
- Where: `src/server/share.ts:39-124` (`PageDemo`, `SharePage`, `ShareTarget`), `:131`
  (`SHARE_CWD`), `:156` (`COMMAND_TIMEOUT`), `:1365-1417` (`commandWords`, `scriptArgv`,
  `siteIncomplete`, `siteProblem`, `tail`); `src/server/site.ts:67`; `src/server/share.ts:23`
- Now: `site.ts` imports `COMMAND_TIMEOUT, commandWords, SHARE_CWD, SharePage, ShareTarget,
  scriptArgv, tail` from `share.ts`, and `share.ts` imports `siteBase, siteMissing, siteTarget` from
  `site.ts`. The `Sharing` class uses none of the seven helpers; their users are `site.ts` (the
  deploy), `config.ts:605` and `plugin/skills/settings/lib/check.ts:24` (`siteProblem`) and
  `canvas.ts:3326` (`siteIncomplete`). `ShareTarget` is the type of what `siteTarget` returns and
  has no other implementation (design decision 2026-10-15: "the demo site is the only place Share
  publishes to").
- Why it matters: the cycle works only because nothing of the other module is used at load time;
  whoever looks for how a deploy line is split, resolved and run finds half in each file, and the
  settings skill pulls in all of `share.ts` to validate a site.
- Change: move `commandWords`, `scriptArgv`, `tail`, `siteIncomplete`, `siteProblem`, `SHARE_CWD`,
  `COMMAND_TIMEOUT` and the three types to `site.ts` (the helpers could also go to a leaf
  `deploy-command.ts`; I would take `site.ts`, since they describe a site's deploy). `share.ts` then
  imports from `site.ts`, never the reverse.
- Win: the import cycle goes; about 140 lines leave `share.ts`.
- Risk: low; moves and import lines only. `share.test.ts`, `site.test.ts` and the configuration's
  tests import the names.
- Confidence: high; every importer grepped in `src`, `scripts`, `plugin`.

### S3. The `Sharing` class carries the reading sessions' prompts and tools beside the share state machine
- Principle: KISS
- Size: moderate
- Where: `src/server/share.ts:917-1003` (`writePage`, `chooseTags`), `:1264-1318` (`pageSystem`,
  `TAGS_SYSTEM`, `TAGS_FIELD`, `tagsSchema`, `picked`), `:1419` (`plainText`); precedent
  `src/server/tag-proposal.ts:60-140` (`proposeTags`)
- Now: `Sharing` (lines 166-1262) holds the page's lifecycle, the run that shares or tags many
  pages, the export, the legacy conversion, and two model sessions with their system prompts, tool
  schemas and answer parsing. The two sessions touch the class only through `this.o.runtime` and
  three values handed in (`cwd`, the card's summary, the language).
- Why it matters: a 1,100-line class in which the prompt text for a model sits 300 lines from the
  method that uses it; the sibling session of the same feature (`proposeTags`) is already a module
  of its own with plain parameters.
- Change: `src/server/page-session.ts` with `writePage(runtime, { cwd, title, body, summary, demo,
  language, lacking }): Promise<DemoPage>` and `chooseTags(runtime, cwd, pages): Promise<Map<string,
  PageTags>>`, the prompts and `tagsSchema`/`picked` beside them. `Sharing.page` and
  `Sharing.tagBatch`/`publish` call them.
- Win: about 150 lines leave the class; the prompts become readable and testable on their own.
- Risk: low; `share.test.ts` drives both sessions through `Sharing` with the fake runtime.
- Confidence: high; read which members of `this` the two methods use.

### S4. `site.ts` is two modules: the multi-machine sync and the rendering of the site's pages
- Principle: KISS
- Size: moderate
- Where: `src/server/site.ts:70-950` (manifest, pull, deploy, `siteTarget`), `:952-1333`
  (`pagesHash`, `artifactHeaders`, `versionFiles`, `pageHtml`, `overviewTheme`, `OVERVIEW_STYLE`,
  `overviewHtml`, `notFoundHtml`, `overviewScript`, `feedXml`, `sitemapXml`, `robotsTxt`)
- Now: the second part is pure functions from `Meta` to HTML, XML and text; nothing in it touches
  the manifest or the network. `plugin/skills/theme/lib/preview.ts:21` imports `overviewHtml` and
  `pageHtml` from the module that also deploys.
- Why it matters: 1,333 lines, of which a reader of the sync protocol needs the first 950 and a
  reader of the overview the last 380.
- Change: move lines 952-1333 with `Meta`, `MoreMeta`, `newest` and `firstSentence` to
  `src/server/site-pages.ts`; `site.ts` imports `pageHtml`, `overviewHtml`, `notFoundHtml`,
  `feedXml`, `sitemapXml`, `robotsTxt`, `artifactHeaders` and the file-name constants from it.
- Win: two files with one job each.
- Risk: low; a move. `site.test.ts` and the theme preview import the names.
- Confidence: high.

### S5. Demo-directory readers live in the template module, and the demo module serves files that are no demos
- Principle: KISS
- Size: moderate
- Where: `src/server/demo-page.ts:212-320` (`captionTracks*`, `mp4Head`, `silentVideo*`,
  `videoSize`), `:692-725` (`ARTIFACT_DIR`, `demoFile`, `artifactFiles`); `src/server/demo.ts:10`;
  `src/server/demo.ts:243-390` (`keyed`, `serveAnswerFile`, `sealedHeaders`, `serveSandboxed`,
  `sandboxed`, `serveCardFile`, `framed`, `serveMockFrame`)
- Now: `demo.ts` ("a card's demo ... read and served") imports six readers of a demo's directory
  from `demo-page.ts` ("the page a demo is shared on"). `demoFile`, a path inside a directory by its
  real path, is imported from the template module by `theme.ts:12`, `workspaces.ts:22`,
  `canvas.ts:11` and `artifact-copy.ts:23`, none of which renders a page. `demo.ts` in turn serves
  looked-up answers' files, a card's changed files and the frame of an idea's mock.
- Why it matters: the names of the modules no longer say where things are; `demo-page.ts` imports
  eleven file-system functions to be a template.
- Change: the readers move to `demo.ts` (or `demo-files.ts`, which then also takes `DEMO_FILES`,
  `demoFiles`, `keepDemo`, `videoFacts`); the sandboxed serving moves to
  `src/server/serve-files.ts`; `demo-page.ts` keeps templates and their words.
- Win: three modules whose names hold; the per-file table of `sync-calls.test.ts` gets entries that
  say what they are for.
- Risk: low; moves, plus the table in `sync-calls.test.ts`.
- Confidence: high; importers grepped.

### S6. `SharePage` splits the versions into a first one and `more`, and the site joins them again
- Principle: KISS
- Size: minor
- Where: `src/server/share.ts:39-76`, `:704`, `:715-726`; `src/server/site.ts:731`, `:771-799`
- Now: `Sharing.publish` destructures `[first, ...later]` to build `{ ...first.shown, dir:
  first.dir, more: later.map(...) }`. `siteTarget.publish` at once rebuilds one list, `[{ ...p, sub:
  '' }, ...(p.more ?? []).map(...)]`, and needs `'at' in d && d.at ? d.at : at` (`:794`) to tell the
  two element shapes apart.
- Why it matters: two shapes for one list, with a conversion each way on the only path between them.
- Change: `SharePage.demos: [PageDemo, ...PageDemo[]]`, the page-level fields (`slug`, `pr`,
  `commit`, `language`, `shared`, `tags`, `theme`) beside it. `meta.json` keeps its shape (a stored
  format).
- Win: about 10 lines and the `'at' in d` test.
- Risk: medium only through test churn: `site.test.ts:115` and `personal-site.test.ts:52` build
  pages with a helper that changes once.
- Confidence: high.

### S7. The two site setups repeat the per-host calls and the host's deploy line
- Principle: DRY
- Size: minor
- Where: `src/server/site-setup.ts:99-115` vs `:183-196`; `:149-159` vs `:162-172`; `:60-71` vs
  `:74-84`; `src/server/personal-site.ts:83-91`
- Now: `setupPersonal` and `setupRepo` each spell out `setupCloudflare({ home, name, log, account?,
  token?, x?, wait? })` and `setupGithub({ name, private, log, x?, wait? })` with the same four
  conditional spreads. `setupRepo` then builds `deploy: cloudflareDeploy(project)` or `deploy:
  GITHUB_PAGES + ' ' + project, maxFile: GITHUB_PAGES_MAX`, which `personalDemoSite` builds too.
  `allow` and `approved` are the same ten lines around `allowPrivate` and `shareApproved`.
- Why it matters: how a host is deployed to is written in two files; a third host or a changed
  wrangler line has to be found in both.
- Change: `hostDeploy(host, project): Pick<DemoSite, 'deploy' | 'maxFile'>` in `personal-site.ts`,
  used by `personalDemoSite` and `setupRepo`; a private `atHost(host, { name, private, account,
  token }, log)` in `SiteSetup` that returns `{ url, project, env? }` for either host; one private
  `tick(input, fn)` for `allow` and `approved`.
- Win: about 25 lines; the host variants in one place each.
- Risk: low; `personal-site.test.ts` covers both setups with the `x` stand-in.
- Confidence: high.

### S8. `export` and `exportArtifact` build the same page parts, file wrapper and log line
- Principle: DRY
- Size: minor
- Where: `src/server/share.ts:806-865`, `:867-893`
- Now: both fetch the page text (`this.page`), the slug (`this.stored(id)?.slug ?? slugOf(card)`),
  the language, the `when` line from a file's mtime, `{ title, text, pr, commit, when, tabTitle,
  language, theme }`, then wrap the result as `{ name: slug + '.html' | '.zip', type, data }` and
  log `t.share.exported(...)`.
- Why it matters: a field added to the page's parts (as `theme` and `commit` were) has to be added
  twice.
- Change: a private `exportParts(card, demo, datedBy: string)` returning the shared parts and the
  slug; `export` does the wrapping and the log once, around two helpers that return `{ html }` for
  one file or `{ entries }` for the ZIP.
- Win: about 20 lines.
- Risk: low; `share.test.ts` covers the four exports (video/artifact, ZIP/HTML).
- Confidence: high.

### S9. Two `commandWords`
- Principle: DRY
- Size: minor
- Where: `src/server/share.ts:1366`, `src/server/folder-processes.ts:58-78`
- Now: both split a command line at white space with `"…"` and `'…'` grouping. The regex in
  `share.ts` only groups a quote that starts a word (`--name="a b"` comes out as `--name="a` and
  `b"`); the loop in `folder-processes.ts` groups it anywhere and drops the quotes.
- Why it matters: one name, two behaviours, and the deploy line gets the weaker one.
- Change: `site.ts` and `siteProblem` use `commandWords` of `folder-processes.ts`; the one in
  `share.ts` goes.
- Win: one function; quoted values inside a word work in a deploy line.
- Risk: low. For every line without a quote inside a word the results are the same; the settings'
  tests and `site.test.ts` run deploy lines.
- Confidence: high; both read, the difference checked by hand.

### S10. A second env-file parser and a second `'sites'` in `site-hosts.ts`
- Principle: DRY
- Size: minor
- Where: `src/server/site-hosts.ts:53`, `:60-64`; `src/server/site.ts:71` (`SITES_DIR`), `:157-166`
  (`parseEnv`)
- Now: `cloudflareAccounts` walks `join(home, 'sites')` and reads `KEY=value` lines with its own
  regex for two keys; `parseEnv` reads the same files for the deploy, and `SITES_DIR` names the
  directory. `site-hosts.ts` cannot import them without a cycle (`site.ts` imports `site-hosts.ts`).
- Why it matters: an env file the deploy accepts (a value with a quote the regex does not take, say)
  can be invisible to the account list.
- Change: `parseEnv` and `SITES_DIR` into a leaf module (with S2, `deploy-command.ts` or a small
  `site-files.ts`); `cloudflareAccounts` takes `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
  from `parseEnv`'s result.
- Win: one parser, one name for the directory.
- Risk: low; `personal-site.test.ts` covers the account list.
- Confidence: high.

### S11. Two WebVTT cue parsers
- Principle: DRY
- Size: minor
- Where: `src/server/demo.ts:149-163` (`cues`), `plugin/skills/demo/lib/revoice.ts:39-61` (`Cue`,
  `cuesOf`)
- Now: the same regex for the cue line and the same time arithmetic. `cues` reads the file itself,
  strips tags inline and collapses white space; `cuesOf` takes the text, splits at blank lines and
  strips tags with `cueText`.
- Why it matters: the caption format changed twice in the last weeks (tracks, word times); a third
  change has two readers to follow.
- Change: `cuesOf` moves to `plugin/skills/demo/lib/subtitles.ts`, which `demo-page.ts` imports
  already; `demo.ts` keeps a three-line `cues(dir, file)` that reads the file and maps the text
  through `oneLine` (`src/core/text.ts`).
- Win: about 10 lines and one parser.
- Risk: low; `demo.test.ts` (chapters, `placeIn`) and `revoice.test.ts`.
- Confidence: high.

### S12. The page's head is written three times, each with the rule "a page with a theme has a policy"
- Principle: DRY
- Size: minor
- Where: `src/server/demo-page.ts:542-547` (`pageStart`), `src/server/site.ts:1169-1172`
  (`overviewHtml`), `:1193-1196` (`notFoundHtml`); the closing `${credit(language)}</main>` at
  `demo-page.ts:512`, `:568`, `:657`, `site.ts:1182`, `:1200`; `site-hosts.ts:215-217`
  (`BLANK_PAGE`) vs `demo-page.ts:535` (`UNLISTED_META`)
- Now: each writes `<!doctype html><html lang><head><meta charset>`, the CSP meta `theme ?
  pagePolicy(ON_DISK)`, the viewport, the title,
  `<style>${PAGE_STYLE}…</style>${themeStyle(theme)}</head><body><main>`. `BLANK_PAGE` repeats the
  two meta tags of `UNLISTED_META`.
- Why it matters: the policy for themed pages is a security rule (nothing a theme names may load
  from elsewhere); a fourth page that forgets it is one copy away.
- Change: export `pageHead({ language, title, theme, policy?, style, head? })` from `demo-page.ts`
  (through `<body><main>`); `pageStart`, `overviewHtml` and `notFoundHtml` call it. `BLANK_PAGE`
  uses `UNLISTED_META`.
- Win: about 10 lines; the rule in one place.
- Risk: low; the page functions stay byte-identical if `head` keeps the element order, and the
  overview is outside `pagesHash`.
- Confidence: high.

### S13. `captionTracks` and `silentVideo` exist twice, sync and async
- Principle: DRY
- Size: minor
- Where: `src/server/demo-page.ts:223-233` vs `:236-247`; `:259-271` + `:277` vs `:280-292`
- Now: twins that differ in `readFileSync`/`readFile`, `existsSync`/`stat` and `openSync`/`open`.
  `sync-calls.test.ts:39` records why: the site reads asynchronously, "share.ts's export, demo.ts's
  facts" at once. The sync callers are `share.ts:826`, `:842` (inside `async export`), `demo.ts:68`
  (`demoFiles`) and `demo.ts:104-108` (`videoFacts`).
- Why it matters: the table in `sync-calls.test.ts` is meant to shrink; until it does, each change
  to how tracks are named is made twice.
- Change: step one, `export` calls the async versions (it is async already). Step two, `demoFiles`,
  `videoFacts` and `keepDemo` become async (callers: `site.ts:736`, `workers.ts:1398`, `:4926`,
  `share.ts:359-360`, `scripts/scratch-obeya.ts`), `videoSize` reads through the async head, and the
  sync twins with `mp4Head` go.
- Win: about 30 lines and five of `demo-page.ts`'s synchronous calls in the table.
- Risk: step one low; step two medium, since `Sharing.rebuilt` and the worker's handover become
  async.
- Confidence: high for the duplication; the callers of step two are listed from a grep, their call
  chains not followed to the end.

### S14. `change` forks on a flag, a nullable callback and an empty list
- Principle: KISS
- Size: minor
- Where: `src/server/site.ts:622-710`; calls at `:749-808`, `:814`, `:841-864`, `:867`
- Now: `change(slugs, shared, apply, log, gone, inPlace = false)` runs three kinds of round: pages
  rewritten whole (publish, withdraw), pages rewritten in place (`inPlace`, retag), and no page at
  all (`slugs` empty, `apply` null, repair). `inPlace` switches `checkSite`'s argument (`:638`),
  `setAside`'s mode (`:642`, `:698-710`) and the body of `undo` (`:648-654`); the empty list
  switches `undo` (`:644`) and `expect` (`:670-672`).
- Why it matters: six positional parameters, the last call reading `change([...], shared, fn, log,
  gone, true)`; the backup's two strategies are spread over three places.
- Change: one options object (`change({ slugs, shared, apply, log, gone, inPlace })`), and the
  backup as a pair `{ setAside(slug), restore(slug), drop(slug) }` chosen once per round from
  `inPlace`, so `undo` no longer branches.
- Win: the three conditions on `inPlace` become one; the calls name their arguments.
- Risk: medium; this is the code that keeps other machines' pages online. `site.test.ts` and
  `site-stalls.test.ts` cover publish, withdraw, retag, repair and the undo after a failed deploy.
- Confidence: medium; the shape is clear, the gain modest.

### S15. Optional positional parameters that callers fill with `undefined`
- Principle: KISS
- Size: minor
- Where: `src/server/site.ts:1052` (`pageHtml(site, slug, m, files, timeZone?, unlisted = false,
  theme?)`), calls `:803`, `:858`, `plugin/skills/theme/lib/preview.ts:129`;
  `src/server/demo-page.ts:542` (`pageStart(p, language, policy?, style = '', list = '')`), calls
  `:511`, `:564`, `:644`; `src/server/site-hosts.ts:226` (`githubPagesDeploy(dir, repo, gitDir, x =
  exec, o = {})`), call `src/server/site.ts:585`
- Now: the calls read `pageHtml(site, slug, meta, files, undefined, unlisted, theme)`, `pageStart(p,
  language, undefined, VIDEO_STYLE)`, `githubPagesDeploy(dir, repo, gitDir, undefined, { private
  })`. `timeZone` is passed by `pagesHash` alone.
- Change: the optional ones in an object: `pageHtml(site, slug, m, files, { unlisted, theme,
  timeZone })`, `pageStart(p, language, { policy, style, list })`, `githubPagesDeploy(dir, repo,
  gitDir, { private, x })`.
- Win: no `undefined` placeholders; a new option does not shift the others.
- Risk: low; type-checked.
- Confidence: high.

### S16. Leftovers of pages that came untyped: a field nobody reads and checks the types rule out
- Principle: YAGNI
- Size: minor
- Where: `src/server/share.ts:97-98`, `src/server/site.ts:726` (`ShareTarget.unlisted`);
  `src/server/site.ts:734` (`d.title?.trim()`, `d.text?.trim()`), `:751` (`p.shared ?? []`), `:776`
  (`p.chapters ?? []`), `:777` (`p.pr ?? null`), `:792` (`d.chapters ?? []`), `:937-940`
  (`checkSlug(slug: unknown)`, `typeof slug !== 'string'`)
- Now: `siteTarget` sets `unlisted: true` on the target; nothing reads it (`board.ts:3918` derives
  the card's `unlisted` from the stored share). `SharePage` declares `title`, `text`, `chapters`,
  `pr`, `shared` and `slug` as required, and both callers and both test helpers give them; the `?.`
  and `??` date from the share command that received a page as JSON (rejected 2026-10-15).
- Change: drop `ShareTarget.unlisted` and the spread at `site.ts:726`; drop the `?.`/`??` on
  required fields; `checkSlug(slug: string, …)`. The emptiness checks (`!d.title.trim()`, `!d.dir`)
  and `isPage` stay.
- Win: a dead field and seven defensive operators.
- Risk: low; type-checked. `personal-site.test.ts:115-116` keeps testing "not a slug" through
  `isPage`.
- Confidence: high; grepped `.unlisted` and `unlisted:` in `src`, read both test helpers.

### S17. German defaults that only tests use
- Principle: YAGNI
- Size: minor
- Where: `src/server/demo-page.ts:181` (`language?: PageLanguage`, "German without one"), `:501`,
  `:555`, `:617` (`p.language ?? 'de'`), `:337` (`day(at, language = 'de')`);
  `src/server/share.ts:1350` (`withDemoLink(body, url, kind = 'video', t = MESSAGES.de)`)
- Now: every caller outside tests passes the language (`site.ts:1053-1062`, `share.ts:824-838`,
  `:874-876`, `:772`) and the kind. The defaults are hit by `share.test.ts:1210-1213`, `:1441-1444`
  and `video-player.test.ts`.
- Why it matters: a page function called without a language silently speaks German; the type should
  refuse that.
- Change: `PageParts.language` required, `day(at, language)`, `withDemoLink(body, url, kind, t)`;
  the tests pass `'de'`, `'video'`, `MESSAGES.de`.
- Win: four defaults and three `?? 'de'`.
- Risk: low; type-checked.
- Confidence: high; all callers grepped.

### S18. Idioms repeated inside `Sharing`
- Principle: DRY
- Size: minor
- Where: `src/server/share.ts:196`, `:301`, `:313`, `:354` ("this demo is on the page already");
  `:194-199` vs `:311-315` (the versions a page shows next); `:581`, `:634`, `:667`, `:787` (`[head,
  said].filter(Boolean).join('\n\n')`); `:273`, `:290`, `:1259`, and `:816`, `:872`, `:1135`
  (`this.stored(id) ?? { slug: slugOf(card) }`); `:664` vs `:733` (the chain `s.again ? … : s.retag
  ? … : s.refresh ? …`); `:714` vs `:897` (the repository's theme)
- Now: `share` and `onPage` both compute `now`, `ref`, whether it is on the page, and `next` from
  `beside`; they are equivalent (for a demo that supplements nothing, `beside` on an empty page is
  `[ref]`). The failure line with the deploy's output is assembled four times, the
  share-or-fresh-slug five times, the reason a page goes out is decided twice by the same three
  flags.
- Change: private helpers `shows(s, demo)`, `versionsWith(cardId, now, ref, add)`, `withOutput(head,
  said)`, `shareOf(card)`, and in `publish` one `const why = s.again ? 'again' : s.retag ? 'retag' :
  s.refresh ? 'link' : 'share'` that both messages index.
- Win: about 20 lines; `share` and `onPage` read as the same step with a different author.
- Risk: low; `share.test.ts` covers each path.
- Confidence: high for the repeats; the equivalence of the two `next` computations checked against
  `withSupplemented` (`src/core/types.ts:1011`).

### S19. The CSS tokenizer for themes sits in the artifact-copy module
- Principle: KISS
- Size: minor
- Where: `src/server/artifact-copy.ts:118-420` (`HELD`, `IMAGE_FUNCTIONS`, `DESCRIBING`,
  `SUBSTITUTED`, `strictStyleData`, `closing`, the lexer helpers, `themeData`); header `:1-18`
- Now: half of the file (about 300 of 631 lines) is a CSS Syntax 3 tokenizer whose only entry is
  `themeData`, called by `theme.ts:67` alone. The file's header describes the artifact's copy and
  says nothing of it. It shares `Inlining`, `inside` and `dataUrl` with the artifact code.
- Change: `src/server/css-references.ts` with `Inlining`, `inside`, `dataUrl`, `withStyleData`,
  `strictStyleData` and its helpers, and `themeData`; `artifact-copy.ts` keeps the HTML side
  (`artifactCopy`, `withData`, `srcsetData`, `withModules`, `bundle`, `withFiles`) and imports
  `dataUrl` and `withStyleData`.
- Win: two files of about 300 lines, each described by its header.
- Risk: low; a move. `artifact-copy.test.ts` and `theme.test.ts` cover both sides.
- Confidence: high.

### S20. Four ways to keep text from closing its `<script>` or `<style>`
- Principle: DRY
- Size: minor
- Where: `src/server/demo-page.ts:335` (`inScript`: `</` to `<\/`), `:400` (`themeStyle`: `</style`
  to `<\/style`), `src/server/artifact-copy.ts:503` (a second `inScript`: `</script` to
  `<\/script`), `src/server/site.ts:1210` (`<` to `<` in JSON); also `src/server/owner.ts:102`
- Now: two functions of the same name with different regexes, and two inline variants.
- Why it matters: each is correct for its content today; a reader has to check four regexes to know
  that.
- Change: in `src/core/frame.ts` (which already builds pages for frames): `inScript(js)` (the `</`
  form, valid for JavaScript and for the `text/vtt` blocks), `jsonInScript(value)` (the `<` form)
  and `inStyle(css)`; the five places use them.
- Win: one audited place for a rule that guards against markup injection.
- Risk: low, with one check: `artifact-copy.ts:546` puts bundler output in, where `<\/` inside a
  regex literal or string is the same text to JavaScript.
- Confidence: medium; the regexes compared, the bundled-code case reasoned, not run.

### S21. Small helpers re-implemented locally
- Principle: DRY
- Size: minor
- Where: `plainText`: `src/server/share.ts:1419`, `src/server/tag-proposal.ts:146`, inline
  `src/server/canvas.ts:2897`. Running git: `src/server/site.ts:230`, `:258` (`spawnOutput(['git',
  '-C', repo, …])`, the bare `git`), `src/server/theme.ts:40`, `:82-86` (`Bun.spawn([GIT, …])`
  through a local `output`), `src/server/share.ts:1170` (`gitAsync`). `messageOf` inline:
  `src/server/site-hosts.ts:29`, `:157`, `src/server/demo.ts:92`. `exists`:
  `src/server/site.ts:886`, `src/server/demo-space.ts:91`, inline `src/server/demo-page.ts:245`. The
  sealed page's three headers: `src/server/demo.ts:283-289` (`sealedHeaders`) vs
  `src/server/site.ts:1017-1021` (`artifactHeaders`)
- Now: `plainText` is the same line three times. `site.ts` runs `git` by name where
  `workspaces.ts:82` resolves `GIT` for Windows; `gitName` and `repoMark` are `gitAsync(repo,
  …).catch(…)` written out. `artifactHeaders` writes the policy, `Connection-Allowlist` and
  `X-DNS-Prefetch-Control` that `sealedHeaders(own)` returns.
- Change: `plainText` into `src/core/text.ts`; `gitName`, `repoMark` and `theme.ts`'s `ls-tree`
  through `gitAsync`; `messageOf` at the three places; `artifactHeaders` renders the entries of an
  exported `sealedHeaders(origin)` (mapping the three names to the capitalised form the `_headers`
  file has, so `site.test.ts:408` holds).
- Win: about 20 lines, and git found the same way everywhere on Windows.
- Risk: low; `gitAsync` throws where `output` returned `''`, so each use keeps a `.catch`.
- Confidence: high for the copies; medium for `ls-tree -z` through `gitAsync` (it trims white space,
  which leaves the NUL separators alone).

### S22. Doc comments that sit on the wrong declaration
- Principle: KISS
- Size: minor
- Where: `src/server/share.ts:1194-1195`; `src/server/site.ts:128-131`;
  `src/server/site.ts:1045-1046`; `src/server/board.ts:256`
- Now: `share.ts:1194` ("One of the card's demos a page may show … by its handover, else by its
  directory") describes `cardDemo` at `:1213` but stands above `beside`, stacked on that method's
  own comment. `site.ts:128` ("The page's URL on the site") stands above `siteRoot`'s comment;
  `pageUrl`, which it describes, follows at `:131` with none. `site.ts:1045` opens a doc comment
  with an empty line that lacks its ` *`. In `board.ts:256` the comment of `personal` is fused onto
  the end of the `auto` line.
- Change: move each comment to its declaration.
- Win: four comments that tell the truth about the line below them.
- Risk: none.
- Confidence: high.

## Justified (looks redundant or complex, but has a reason; leave it)
- `src/server/share.ts:405-428` (`convert`) and `src/server/board.ts:275` (`sharedDemos`' fallback),
  `share.ts:686-688`: shapes of shares that existing databases may still hold (until 2026-10-16);
  the conversion adds the handover the fallback cannot know.
- `src/server/artifact-copy.ts:105-116` vs `:139-265`: two rewriters of CSS references. The regex
  one also runs over whole HTML pages (`:499`) and leaves what it does not inline; the tokenizer is
  the theme's guarantee (sharing-demos.md: "read as a browser tokenizes CSS, so no way of writing a
  reference gets past that").
- `src/server/artifact-copy.ts:353-375` vs `:378-401` (`cssString`, `cssUrl`, on the clone list):
  two token kinds with different end rules; one function would need a flag per rule.
- `src/server/site.ts:206-221` (`machine`, `checkWaits`, `by`), `src/server/share.ts:139-141`
  (`personal`, `personalSite`), `src/server/site-setup.ts:23-29` (`repos?`, `user?`, `x`, `wait`),
  `src/server/site-hosts.ts:22` (`Exec`): test seams.
- `src/server/share.ts:1063-1085` (`pass`, `overPages`) and `src/server/site.ts:277-281`
  (`readSites`): caches with a measured reason (a site of some hundred pages held the server up,
  2026-11-05).
- `src/server/site.ts:895-914`, `:943-950` (`fileHash`, `bodyOf`, `sourceHash`): three chunked
  SHA-256 loops over a file, a download and a list of files; a shared helper would save three lines
  each.
- `src/server/site-hosts.ts:79-91` (`setupCloudflare` around `cloudflareIn`): the wrapper owns the
  empty working directory and its removal (2026-10-29: a checkout went up as a Worker).
- `src/server/demo-page.ts:410-422` (`CUES`), `:470-475` (`BLOB`): browser-side copies of parsing
  that a page opened from disk cannot load from anywhere.
- `plugin/skills/demo/lib/director.ts:1004-1090` (`reportPage`, another slice): a fourth page with a
  video and chapters, but the owner's report with native controls and its own look, written by the
  skill without Obeya.
- `src/server/demo-page.ts:22-149` (`PAGE_WORDS`): not UI strings; the pages speak the demo's
  language to people outside Obeya.

## Bugs noticed in passing
- `src/server/share.ts:1366`: a deploy line with a quote inside a word (`--message="a b"`) is split
  at the space and keeps its quotes (see S9).
- `src/server/share.ts:572`: a page of a tagging batch that the owner tagged while the session ran,
  and for which the session gave no answer, is dropped from the run and still gets the error line
  "not shared: no tags" (possible, read from the code, not reproduced).
