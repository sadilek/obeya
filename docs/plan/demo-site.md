# Shared demos on a static site, run by Obeya

> Plan doc for publishing shared demos to a static host from a few declarative lines in a
> repository's adapter, instead of a share command each repository writes and maintains itself.
> Deleted when it ships; durable content moves into [`docs/design.md`](../design.md).

## Goal

A repository that shares demos on a static host names its site in a few declarative lines of its
adapter (`demo.site`). Obeya keeps the site directory, writes the pages and the overview with its
own templates, keeps dates by the demo's own files, and runs the deploy. Several machines can
publish to the same site without taking each other's pages offline. Template changes reach every
site with Obeya itself, instead of a follow-up change in each repository.

## Where it stands

- *Share targets*: `src/server/share.ts` runs one share target per repository: the
  configuration's `share` line, else the adapter's `demo.share` (argv). It calls `publish` with
  the page as JSON on stdin (it carries `language` since 2026-10-07), then `withdraw <slug>` and
  `version`. Calls run one at a time across all canvases (`serial`), in `~/.obeya/share/`, with
  `OBEYA_HOME`, `OBEYA_KIT` and `OBEYA_REPO` set. Without a target, "Teilen" exports a ZIP or an
  HTML file. Since W1 `Sharing` resolves a card's `ShareTarget` (for now only a command, keyed by
  its argv); outdated marks, `checkVersions` and the run that shares many again compare targets by
  that key.
- *The one static-host command* lives in another repository's adapter (`share.ts`, about 375
  lines plus a test). It keeps the site in `$OBEYA_HOME/<name>-share/site/`, one directory per
  slug with the demo's files and a `meta.json` (`kind`, `title`, `text`, `chapters`, `pr`,
  `first`, `at`, `source`). Before deploying it checks the slugs Obeya has as shared and refuses
  if the site lacks any of them. It sets the slug aside and puts it back if the deploy fails. It
  enforces a 25 MiB file limit, writes the overview, and computes `version` as a hash of a sample
  page. Only `wrangler pages deploy`, the credentials file, the URL and the title are its own.
- *Language*: that command ignores `language`. "Geteilt am", "Alle Demos" and the overview are
  hard-coded German.
- *Several machines*: its guard knows only the pages its own Obeya shared. A second machine
  deploying its own directory (a full snapshot) would take the first machine's pages offline.

## Design

### `demo.site` in the adapter

```ts
demo: { site: {
  title: 'Team demos',                     // overview heading, tab titles
  url: 'https://demos.example.dev',        // page URL = url/slug/
  deploy: ['bunx','wrangler@4','pages','deploy','{dir}','--project-name','demos','--branch','main','--commit-dirty=true'],
  env: 'sites/demos/deploy.env',           // relative to Obeya's home, KEY=value lines; optional
  headers: { 'CF-Access-Client-Id': '${ACCESS_ID}', 'CF-Access-Client-Secret': '${ACCESS_SECRET}' }, // for reading the live site; values from env; optional
  maxFile: 25 * 1024 * 1024,               // optional
  language: 'en',                          // the overview's words; default the demo settings' narration language
} }
```

- `{dir}` is replaced by the site directory. The deploy runs like a share command does today:
  from `share/`, with Obeya's Bun for scripts, the env file's values added to its environment,
  and its output going into the card's log.
- **Where things live.** The site sits at `~/.obeya/sites/<key>/`, where the key comes from the
  URL (host and path), so clones and repositories naming the same site share one directory and
  one queue. Credentials stay under Obeya's home only, never in git.
- **Precedence.** The configuration's `share` line, then `demo.site`, then `demo.share`. An
  adapter naming both `site` and `share` is a configuration problem at the repository, shown
  where the configuration shows the others. `demo.share` stays for hosts that need more than
  deploying a directory.
- **Without credentials.** A site whose `env` file is missing on this machine is no target here:
  "Teilen" exports as today, with one line under the buttons naming the missing file
  ("Publishing to demos.example.dev needs `sites/demos/deploy.env` on this machine."). A site
  without `env` always publishes (its deploy uses the machine's own login).
- **Code.** A new `src/server/site.ts` holds the generic part, moved from the existing command
  and made language-aware per page: each page's words in the demo's language, the overview's in
  the site's `language`. `Sharing` gets a target abstraction (a command, or a site) in place of
  `commandFor`, with a key of its own for outdated marks and the run that shares many again. The
  version is computed in-process from Obeya's templates plus the site's title and URL. The
  configuration sheet shows "Site: <url>" where it shows the share command today.
- **Versions.** `version` and "Erneut teilen" keep working as now: pages are brought up to date
  on purpose, card by card or many at once from the Koordinator's sheet. Once a site switches
  over, all its pages show as outdated once (their words become language-aware); one run from
  the Koordinator's sheet clears it.
- **Moving over.** Obeya reads the existing `meta.json` format as its own. The old directory
  moves to `sites/<key>/` by hand, one `mv` named in that repository's adapter change. Links and
  dates stay.

### Several machines: pull before push

- The site carries a manifest, `obeya-site.json` at its root. It lists every page: slug, its
  `meta.json`, its files with size and hash, a revision, and which machine wrote it. Withdrawn
  pages stay listed as a tombstone with their date, so a machine that still has the files does
  not undo a withdrawal.
- Before every publish or withdraw, Obeya fetches the live manifest (with `headers`, since the
  site may sit behind a login). It downloads pages that are missing locally or newer remotely,
  removes pages withdrawn remotely, then writes its own page, the merged overview and the
  manifest, and deploys.
- After the deploy it fetches the manifest again. If another machine's deploy came in between and
  its own page is missing, it repeats the round once, then reports a failure in the card's log.
- If the manifest cannot be read (network, login), Obeya refuses to deploy and says why:
  deploying blind could take pages offline. The one exception is a site that has none yet (404
  at its URL), which counts as the first deploy.
- Slugs contain the card's id, so two machines never write the same slug.
- A page another machine withdrew: the card here notices at the next manifest fetch (any share on
  that site, or the once-a-minute check when the owner comes back). It loses its link, with a log
  line saying the page was withdrawn on another machine.
- The existing guard (refuse if the site lacks pages this Obeya has as shared) stays as the last
  check after the merge.

### Variants considered

- **A, declarative `demo.site` run by Obeya** (chosen).
- B, a kit library the repository's own script calls. Dropped: it still leaves a script to
  maintain in every repository.
- C, built-in hosting providers. Dropped: it puts provider code in the core, and the deploy line
  covers them.
- Guard: **pull before push** (chosen). Refuse-only, which checks the manifest and refuses when
  pages are missing locally, was dropped: the owner could do nothing about it but copy files by
  hand. A shared storage directory (a synced folder or bucket as the site's source) was dropped:
  it pushes the problem onto every user's setup.

### Order

W1 to W3 in order, each landing on its own: W1 changes no behaviour, W2 makes a site work on one
machine, W3 makes it safe on several. W4 follows W2 at the earliest and W3 before a second
machine publishes to the site.

## Workstreams

- [x] **W1:** Share targets instead of share commands. `Sharing` resolves a card's target (for
  now only a command) where it calls `commandFor` today, and outdated marks, `checkVersions` and
  the run that shares many again key pages by the target's key instead of the command's argv.
  Stored shares and their version marks carry over unchanged, so nothing shows as outdated after
  the update. No behaviour change; the existing share tests pass as they are, plus one that a
  restart with stored shares and a running reshare leaves marks and the run as they were.
- [ ] **W2:** `demo.site` on one machine. `demo.site` in the adapter type
  (`src/adapters/types.ts`) and its precedence (configuration `share`, then `site`, then `share`;
  both in one adapter is a configuration problem). `src/server/site.ts` as a second kind of
  target: the site directory under `sites/<key>/`, one directory per slug with the demo's files
  and `meta.json` (the existing format, read as is), pages and overview from Obeya's templates in
  each page's language and the site's, dates kept by the demo's own files, the file limit, the
  guard against a site lacking pages Obeya has as shared, the slug set aside and put back when the
  deploy fails, the deploy line with `{dir}` and the env file's values, the version computed in
  process. A missing env file makes the card export with the line naming the file (strings in
  `src/ui/strings.ts`). The configuration sheet shows "Site: <url>". Tests ported from the
  existing command's test, against a deploy line that copies the directory. `docs/design.md`
  describes `demo.site` beside share commands.
- [ ] **W3:** Pull before push. The manifest `obeya-site.json` (pages with files, sizes, hashes,
  revision, machine; tombstones for withdrawn pages), fetched with `headers` before every publish
  or withdraw, the merge (download what is missing or newer, remove what was withdrawn), the
  check after the deploy with one more round, the refusal when the manifest cannot be read (a 404
  for the whole site counts as the first deploy), and a card losing its link when another machine
  withdrew its page. Tests against a local HTTP server standing in for the host, with two site
  directories as two machines. `docs/design.md` updated.
- [ ] **W4:** Switch the first site over. Done in the repository whose adapter has the static-host
  command, on its own canvas: its `share.ts` and test give way to the `demo.site` lines, its site
  directory moves to `sites/<key>/` with the one `mv` its change names, and the read token for the
  site's login (an Access service token, say) goes into the env file of each publishing machine.
  Then one run from the Koordinator's sheet brings its pages up to date. This workstream's card
  here proposes that card (`propose_card`) with the exact lines; nothing lands in this repository
  but the ticked box.

## Risks

- **Re-keying (W1).** Stored shares, outdated marks and the run that shares many again find
  their command by its argv today; a slip there marks every page outdated or drops pages from a
  running reshare.
- **A new machine's first share** downloads the whole site, videos included, since every deploy
  is a full snapshot. With hundreds of pages that is a long first share; its progress goes into
  the card's log.
- **Caches and propagation.** The host or a CDN may serve a stale manifest right after a deploy;
  the fetches ask for no cache, and the check after the deploy may need to wait for the new
  deployment to answer.
- **Two deploys at the same moment.** The check after the deploy catches a page lost to a
  concurrent deploy and repeats once; two machines sharing again many pages at once could still
  fail a round, which shows in the card's log and leaves the card as it was.

## Open questions

- None. The setup the owner does once is a read token for a site behind a login (for example an
  Access service token) in the env file of each publishing machine.
