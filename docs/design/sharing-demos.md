## Sharing demos

A chapter of the [design doc](../design.md), whose header says how it is written.

### Sharing a demo

Every demo, video or HTML artifact, has a compact "Teilen" button at the right end of its own line
(see Earlier demos), on waiting, done and archived cards alike; prototypes are not shared. Once
shared, the line holds the link, "Link kopieren" and "Nicht mehr teilen".

#### Where a demo goes

Where a site takes the demo, "Teilen" publishes it on a page there at once, without a hold; "Nicht
mehr teilen" withdraws it as easily. The site is the repository's own (see Static sites) where this
machine can deploy to it, else the owner's personal one (see The personal site) where the repository
may share there. Without either, it exports a file (see Export without a site). A page stays on the
site it went out on: later versions, a withdrawal and the link to the PR or commit go there, even once the other
site would take a new page. Pages go out one change at a time through one
queue for all canvases, which resumes after a restart. The slug comes from the card's title and id
once and stays, so the link survives republishing. The deploy's output goes into the card's log; a
failure is logged as an error and leaves the card as it was.

The page has a title and two to five sentences for colleagues who have never seen Obeya, which
`ready_for_review` takes with every demo where the repository has a site (`demo.page`); for a demo
without them, a short read-only session writes them from the worker's last summary when the owner
shares, kept with the demo from then on. Whether `ready_for_review` takes and requires the page is
fixed when the worker's session starts: where sharing begins only later (the forge answers after a
restart that the repository is public, a site is set up), the session hands over without one, since
its tools' schema drops a page it does not know.

#### Tags

A site may name a vocabulary of tags (`demo.site.tags`): a few dimensions, each with its values, in
the order the overview shows them (`{"Area": ["Billing", "Reports"], "Audience": ["Admins"]}`). As
the repository's settings, it is the same for everyone who shares on the site. Nobody adds to it:
workers and the reading session choose from it, and the owner picks from it by hand. A page carries
per dimension zero or more of its values; a dimension it has no key for has none chosen yet.

Tags belong to the card's page, not to a version. Each dimension comes from the first that has it:
the owner's choice by hand, the newest demo whose worker gave it, the reading session's. Where the
site has a vocabulary, `ready_for_review` takes `demo.page.tags` with every page and refuses a
dimension left out or a value outside the vocabulary; the demo skill asks the worker for them. A page
going out that lacks a dimension, or holds a value the vocabulary no longer has (struck or renamed),
gets it from the short read-only session that writes missing page texts (in the same session where
it writes the text, else in one of its own from the title and text of the page's versions); it
chooses only those dimensions, kept on the card from then on, so a later worker's tags come before
it and the owner's before both.

The share box shows the page's tags as chips, before sharing and after: × takes one off, „+“ offers
the vocabulary's other values. A change takes effect at once, without a hold: a shared page goes out
again with the same demos (one going out goes out once more after it), and the log says so.

Pages without tags are tagged from the Koordinator's sheet: while pages on a site with a vocabulary
lack tags in a dimension (archived cards' included, their demos at hand), an entry says how many
(„N Seiten ohne Tags“), and „Alle N taggen und teilen“ tags and shares them again in one run through
the queue that shares outdated pages again (one run at a time, with its progress, "Anhalten" and the
failed ones). Its "Ausblenden" puts away only its own result.

#### Several versions on one page

A card has one page under one link, holding the demo versions the owner shared, in order of
handover: the first on top with the page's title and text, each later one below as „Ergänzung vom
16.10., 13:37“ (its handover's time, formatted by Obeya, since ICU joins the parts differently on
macOS and Linux) with its own title, text, chapters and demo. With two or more, a list of them stands
under the title.

The share box is about the version shown in the demo's line. On a version on the page: its link,
"Link kopieren" and "Nicht mehr teilen" (the page goes out again without it; the last one takes the
page down). With earlier demos on the card, a line says which versions the page holds („Auf der
Seite: Demo 1 und 2“). On an earlier version not on the page, "Teilen" adds it in its place by
handover. On the latest, not on the page, the hint „Die geteilte Seite zeigt Demo 1.“ offers „Auf
der Seite ersetzen“ and „Zur Seite dazunehmen“. Which comes first is the worker's word:
`ready_for_review` says of a later demo whether it was recorded afresh (`follows: replaces`) or
supplements the one before (`supplements`), the demo skill asks for it, and a sentence under the
buttons repeats it („Laut Agent ergänzt dieses Video Demo 1.“); without it, replacing comes first.
Nothing goes out without the owner's click.

A supplement never goes on a page without what it supplements: shared on a new page, added, or put
there by an approval, it takes along the demo before it, and that one the demo before it while it
supplements too, back to the first or one recorded afresh, also where those were never shared. Before
a page exists, a line under "Teilen" names them („Kommt mit Demo 1 auf die Seite, die diese Demo laut
Agent ergänzt.“). „Auf der Seite ersetzen“ puts the demo there alone, as the owner chose.

#### A shared artifact

An artifact's page shows the title and text above the artifact in a sandboxed frame that grows to
the artifact's reported height (`postMessage`, at most 30 steps, as an artifact as high as its window
would grow on). „In eigenem Fenster öffnen“ shows the same page with the frame filling the window
(`?alone`). The artifact may open no window: a popup could leave the sandbox or reach any server.

The frame's origin is `null`, and a static site cannot hand out keyed addresses as Obeya does (see
The demo on the card): hosts send no or a wildcard CORS header, a ZIP from disk loads no CORS request,
and behind a login (Cloudflare Access) the frame's requests for files go cross-site without the
login's cookie (Firefox always, Chrome unless `SameSite=None`), so the login answers with its own
page. From disk Chrome loads nothing at all beside a sandboxed page. So the artifact's copy
(`src/server/artifact-copy.ts`, for site and ZIP) loads no file beside its pages: module scripts are
bundled in (CDN and package imports stay imports, comments naming this machine's paths go, a script
that does not bundle stays as it is), the files its pages name (images, `srcset`,
media, classic scripts, stylesheets and their imports, fonts, icons, CSS `url()`s) go in as `data:`
URLs, and the files its scripts may fetch are embedded, `fetch` and `XMLHttpRequest` answering GETs
for them. `<base>`, `#` parts and `srcset` are read as browsers read them. A page grows with its
images and stays under the host's file limit; `data:` URLs stop at 64 MiB a page. A file goes in only
if its real path lies in the artifact's directory, and a module whose bundle took in code from
outside stays unbundled; build macros are off. Otherwise a worker steered by what it read could put
an owner's file into a public page. Still not loading: a Web Worker's script, an `import()` of a
computed path, a font set from a script, and behind a login a file a script names at run time. A
ZIP's page opened from disk lets the frame keep its origin (`file:` has no site to protect).

A shared page sends nothing to the internet, under the rule of a worker's page inside Obeya (see The
demo on the card): each HTML page of the copy starts with that CSP as a meta tag (own files, inline,
`data:`, `blob:`), naming its files by `'self'` and the site's address (for Safari), in a ZIP by
`file:`; a single-file export carries it through `srcdoc`. The page around allows its frame only its
own files, so the artifact cannot navigate elsewhere, and turns DNS prefetching off. Where the host
reads `_headers` (Cloudflare Pages, Netlify), Obeya writes one: the artifact's files get the CSP, the
sandbox (opened directly, a file does not run in the site's origin) and `Connection-Allowlist:
(response-origin)` against `preconnect` and WebRTC (Chrome 152 on). Elsewhere, and in Firefox and
Safari, those two stay open (no meta tag carries the header, no engine heeds `webrtc 'block'`), as
does an SVG with scripts opened in the frame; under `file:` the artifact may load any file of the
disk.

#### Outdated pages

What changes on the pages is written down as it changes (`PAGE_CHANGES` in
`src/core/page-changes.ts`): each change a viewer sees, with the kinds of page it shows on (video,
artifact, both) and its words. A share keeps the newest change at publishing; later changes that show
on its versions' kinds make it outdated. Its card lists them with their days, beside "Erneut
teilen" (same versions, same link) and "Nicht mehr teilen"; the latest demo not yet on the page
brings them with replacing or adding. A change that shows nowhere gets no entry. A test pins a hash
of sample pages (both languages, both kinds, several versions) and fails once they differ, asking to
add an entry where a viewer sees it and to take the new hash. A change that shows only on pages with
tags (the chips under the title) marks no page: none published before it had tags, and those get it
with their tags (see Tags). A new site title shows with the next
publish without marking pages. A page whose demo files are gone (demos get deleted to free space) is
neither offered nor counted.

Many at once go from the Koordinator's sheet: while pages are outdated, an entry says how many
(„N geteilte Demos sind veraltet“, archived cards' included), lists the changes with their days and
how many pages lack each, and shares again the newest 20 (or 10, 50, 100, all). They go through the
same queue as the share kept them (a newer demo on the card still waits for the owner), a share the
owner starts slipping in between. The entry shows progress and the failed ones with their cards;
"Anhalten" stops after the current page; "Ausblenden" hides the entry until a newer change outdates
pages. The run survives a restart; a page shared again on its own, withdrawn or deleted meanwhile
drops out of it. It is not counted on the Koordinator button: each card offers "Erneut teilen", and
nothing is lost by leaving them.

A page is outdated by its repository's theme too (see A repository's theme): the share keeps the
theme's hash, and once the repository's current one differs (a new theme, a changed one, one taken
away), the card lists „Theme geändert“ without a day beside the page changes, and the Koordinator's
entry counts its pages with them. „Ausblenden“ hides them until that repository's theme changes
again.

A page published again with the same video keeps its date („Geteilt am“), so the overview keeps its
order; a new video dates it anew.

#### What the worker hears of its page

The card's worker hears what became of its demo's page since it last heard of it: the owner shared
it (going online, then online with its address, or showing an earlier demo than its latest),
sharing failed, or the owner stopped sharing it. The news comes with its next message or tool step,
before the owner's words that follow it, and starts no turn of its own. Online, it also says where
Obeya links the page once the work lands (the commit's trailer or the PR's description, see below;
the PR's comment on a review card), so a worker asked whether the link reaches git answers from
fact. What a message tells of the page anyway (approval into a PR, the landing) counts as heard.

#### The page and the pull request

A demo shared before approval goes into the worker's approval message with "link it in the
description". Once a PR exists and the page is out, in either order, Obeya adds to the PR description
(unless it already contains the URL) a line `Demo-Video: <url> <!-- obeya:demo -->` (`Demo-Seite:`
for an artifact; „Demo video:“/„Demo page:“ in English), replacing its own earlier line by the
marker. A page shared before the PR existed is republished with the PR's link, as it showed then; a PR
reported while the page is going out gets a second round after it. A failure goes into the card's log; the page stays shared. Withdrawing leaves the line. A review card's pull request is the contributor's: its
description stays as it is, and once the owner approved, the page's link goes into a comment on it
instead (`Demo-Video: <url>` in the demo's language), once per page. Either way the card's
conversation shows a line that the link is on the PR, with the comment's or the PR's address: the
agent only knows Obeya will put it there, and the owner should not have to look on the forge.

#### The page and the landing

The message telling a worker its work landed, its PR merged, or its work closed without a change
names the demo's page: its URL once it is online, or that the page shows an earlier demo. A page
still going out says Obeya will send the address: the session stays past the end of the turn, and
once the deploy that puts the latest demo on the page finishes (not one still under way before it)
Obeya sends the URL, or the failure's reason with "ask the owner for a link". A worker that closes
its card as needing no PR hears the same in the tool's result. If the deploy finished while Obeya was down, the worker hears where the page stands at the
end of its next turn. Without a demo site, or with the demo not shared, the message says so and
tells the worker to ask the owner before pointing anyone to the demo, so an issue is not closed
without a link (CLAUDE.md asks workers to link the demo when they close one). The URL is known
before the deploy (the trailer uses it), but a link given then would point to a page that is not
there yet, or never will be if the deploy fails (decided 2026-10-26).

#### Publishing on approval

A site may publish every approved demo by itself (`demo.site.publish: "approved"`, a choice in
Konfiguration); Obeya's own repository does, onto `demos.obeya.si`. There, until approval, the
latest demo not on the page has a checkbox „Mit der Freigabe teilen“ (ticked) beside the button,
which then reads „Jetzt teilen“. Unticked, approving shares nothing and the log says so. The choice
stays with the card and takes effect at once.

A repository that shares on the personal site does the same once the owner ticks it for that, a
choice of the owner's that stays on this machine, not in the repository's settings (colleagues share
on their own personal sites): Konfiguration → Demos lists, under the personal site, the repositories
of the canvases that share there, each with „Mit der Freigabe teilen“ (one whose site publishes on
approval ticked and fixed, „laut seinen Einstellungen“). Until it is ticked, its cards show the same
checkbox unticked where the ticked one would be; ticking it there ticks the repository. A page that
went out on the repository's own site stays out of it. The connection code does not carry the ticks,
and connecting again keeps them.

On approval, before landing, the latest demo goes on the page as the owner's click would: a new page,
or beside the versions where its worker said it supplements (with what it supplements, see Several
versions on one page), else in their place, after any share
still going out; a log line says so. It goes through the queue, so landing does not wait; a failed
deploy is logged and the card keeps "Teilen". The same holds for approved PR work, work closed
without a change, and a held approval landed by the worker's next handover (the newer demo goes).

Where a repository lands on `main` directly, the landing commit of a card with a page names it in a
git trailer, `Demo-Video: <url>` (`Demo-Page:` for an artifact), beside the closing trailers. The URL
comes from the fixed slug, so the trailer is there before the deploy finishes. Obeya amends the
rebased branch's last commit (`--no-verify`, author kept), skips a trailer already there, and lands a
commit it cannot amend without one. A publish that succeeds for a landing that then fails leaves a
public page for work not on `main`; accepted, since the next handover lands it.

#### The page and the commit

Work that lands on `main` without a pull request (landing on `main`, or pushed there directly) is
linked from its page the way a PR is: „Commit ansehen“ („View commit“) where the PR's link would be,
or „Commits ansehen“ („View commits“) over the comparison of several commits. The address is built
from the checkout's `origin`, `<web address of the repository>/commit/<sha>` or
`/compare/<before>...<last>` (GitHub's, Forgejo's and Gitea's path; GitLab puts it below `/-/`); an
`origin` that is a path gives no link. The page goes out on approval before the commit exists, so
once the work landed Obeya publishes it again as it is with the link, or gives a share still going
out a second round, as for a PR opened late; the log says „Die geteilte Seite verlinkt jetzt den
Commit auf main“. A card with a PR links the PR only. Where `main` is pushed later than it lands, the
link answers once it is pushed; accepted, since nothing else names the commit before.

#### Export without a site

Without a site, "Teilen" exports the page (`GET …/cards/<id>/export?as=zip|html`): a ZIP with a
folder named by the slug, the video, poster and captions beside `index.html`, or one HTML file with
the video in base64, played from a blob so it seeks, for videos up to 15 MiB so it still goes by mail
(the button says so otherwise). An artifact goes into the ZIP under `artifact/`, or into one HTML file
as `srcdoc` only when `index.html` is its only file. Nothing leaves Obeya, so an export is not held;
the log names the file. It packs the version shown, one per file. Captions go in as cues in a script,
since Chrome loads no `<track>` from disk. The ZIP is stored uncompressed.

The page is the site's, without the overview link. Its own words are in the demo's language (the one
its `index.html` names, else the demo settings' narration language, else German). Its video waits
under a big play button; a click anywhere on it but the controls starts it. No autoplay: browsers
play sound only after a click on the page, and the owner did not want it muted.

Every page and every overview ends in „Aufgenommen mit Obeya“ ("Recorded with Obeya") linking
https://obeya.si, without a setting to turn it off; `?alone` leaves it out.

#### A repository's theme

A repository gives its shared pages a look of its own with one file, `.obeya/theme.css`, without a
setting or anything in Obeya's UI: Obeya manages nothing of it. Like the settings, it is read from
the default branch, not from a card's branch. Every page of the repository carries it, on its own
site and on the personal site alike, and so does an export (ZIP and HTML file); the overview and the
feed of a repository's site carry the theme of the repository publishing, as with the site's title,
while the overview of a listed personal site keeps Obeya's look, as it belongs to no repository. An
artifact in its frame stays untouched.

The file goes into the page's head after Obeya's own style, so its rules win. Files it names with
`url()` or `@import` (a logo, a font, another stylesheet, which may name more in turn) go in as
`data:` URLs where their real path lies inside `.obeya/` (a link to a file elsewhere does not
count); every other reference, a file elsewhere or an address on the internet, is dropped, and a
page with a theme carries the policy of a shared artifact's page, so nothing it names loads from
another server. Without the file, pages are byte for byte what they are without the feature.

What a theme styles is the pages' markup, which is its interface and changes only on purpose:

- the colour variables on `:root`: `--bg`, `--card`, `--ink`, `--muted`, `--line`, `--chip`,
  `--accent`, set for light and dark (`prefers-color-scheme`), which a theme may set apart too;
- a page: `main` around everything, `.top` (the link to all demos), `h1`, `.when` (who shared it
  when), `.tags` with `.tag` chips, `.text` with its paragraphs, `.grid` with `.player` (the `video`
  and its `.start` button) and the chapters as `ol` of buttons, `.pr` (the link to the change),
  `.links`, `.artifact` (the frame), `.credit` (the closing line); several versions on one page add
  `.sections` and `section.addendum` with its `h2` and `h3`;
- the overview: `h1`, `.when`, `.filter` with the search field and `.dim` rows of `.chip` buttons,
  `.bar` with the count and `.copy-all`, `ul.demos` whose entries are links holding `b` (the
  title), `span` (the line under it) and `i` with `em` tags, each with a `.copy` button.

A logo goes in as a `background-image` on an element there or a `::before`. „Aufgenommen mit Obeya“
stays in the markup of every page; a theme may hide it.

#### Static sites

A static host takes the site as a directory, deployed whole with each change. Obeya keeps it under its
home, refuses before deploying a file over the host's limit and a directory lacking a page Obeya has
as shared, and restores it when a deploy fails. Some hosts serve no byte ranges (Cloudflare Pages),
so the page asks for a range first and, getting the whole file, plays the video from memory, as a
browser cannot seek in it otherwise.

`demo.site` in the repository's settings (once trusted, see Trusting a repository's commands):

- `title`: the overview's heading and the pages' tab titles; `url`: pages at `url/<slug>/`;
- `deploy`: a command line, `{dir}` for the site's directory;
- `env` (optional): a `KEY=value` file under Obeya's home with the deploy's credentials; a path
  outside the home is refused, and `${KEY}` comes from that file only, so a repository's settings
  cannot send the machine's secrets anywhere;
- `headers`: for reading the live site behind a login; `maxFile`: the host's file limit (25 MiB
  default); `publish`: see Publishing on approval; `tags`: the vocabulary (see Tags), which
  Konfiguration writes as a line per dimension (`Area: Billing, Reports`).

The overview is in `demo.language`, else the narration language. Konfiguration has a field for each.
A site counts once it has a title, an http(s) URL and a deploy command; an unusable one (incomplete,
deploy program missing) is a problem shown at the repository.

The deploy runs in `share/` under Obeya's home with `OBEYA_HOME` and `OBEYA_REPO` set, not in the
checkout, where leftovers (wrangler's cache) would keep a pool workspace from being leased. Its words
are split at spaces outside quotes; programs and scripts are found in the repository; `.ts` and `.js`
run with Obeya's Bun, so the line works on Windows. Any host that takes a directory fits: Cloudflare
Pages, Netlify, Vercel, `aws s3 sync`, `rsync`, a Pages branch, a script.

The site lives in `sites/<key>/` under Obeya's home, the key from the URL's host and path, shared by
all repositories naming it. `site/` holds a directory per page (demo files, `index.html`,
`meta.json`: kind, title, text, chapters, PR (or without one the commit: its address, and whether it is a comparison over several), first shared, last changed, a hash of the demo's own
files, language, who shared it, its tags, the hash of the repository's theme it carries, and under `more` the later versions, their files in `2/`, `3/` …),
the overview, dated by each page's newest version, and an Atom feed (`feed.xml`, linked from the
overview as „Feed abonnieren“ and by `<link rel="alternate">`) with one entry per page in the overview's order (title,
first sentence as summary, the whole text as content, the page's address as link and id, the
overview's date, the page's language, who shared it as author), written together and so equally
current. A page keeps its date while its demo's own files stay the same.

Each page names who shared it („Geteilt von Ada Lovelace am 20. Oktober 2026“), and the overview
after the date, as colleagues publish to one site from their own Obeya: git's `user.name` in the
card's repository, left out where none is set.

A page's tags stand as chips under the line saying who shared it, each linking the overview filtered
by it (`../?Area=Billing`), and in the feed as `<category term="Billing" label="Area: Billing"/>`. The
overview starts with a search over the pages' titles and texts and, where the site has a
vocabulary, a row of chips per dimension (the values some page has): any chip of a dimension, and
every dimension with one chosen. The filter stands in the URL (`?Area=Billing&Area=Reports&q=pdf`),
so a filtered list can be passed on. Each entry shows its tags and, on hover (always on a touch
screen), an icon copying the page's URL. Above the list, „N von M“ and „Links kopieren“: the pages
shown as a list of titles and URLs, put on the clipboard as `text/html` (links in a mail or a
document) and as Markdown (`- [Title](URL)`) in `text/plain`, as text alone where the browser lacks
`ClipboardItem`. It all runs in an inline script; the site stays static.

A machine without the site's `env` file shares on the personal site where it may, else exports, with
a line naming the missing file; once placed, it counts when the owner comes back. A site without `env` deploys with the machine's own login.

#### Setting up a repository's site

Where a repository has no site, its settings offer „Demo-Seite einrichten …“, and the site's fields
(title, URL, deploy command, env file and the rest) only behind „Anderer Hoster, von Hand eingetragen
…“: the personal site has no such fields, as Obeya sets it up itself, and a repository's site needs
them only for a host Obeya does not set up. The owner picks the host (GitHub first, then Cloudflare,
as for the personal site), Obeya creates the site there in the background (the dialog shows its last line, a login in the
browser may take minutes) and fills in `demo.site`, which „Speichern“ then takes over. Such a site is
listed, like any repository's. Cloudflare Pages: a project `<repository>-demos` (with a suffix where
the name is taken), through wrangler in the account of a site this machine deploys to already, as the
owner picks it („wie bei demos.example.dev“, each account once; its credentials go into the new site's
env file), or with the machine's own `wrangler login`, which opens the browser. The choice is shown,
since a machine may deploy to sites of several accounts, a work account among them. wrangler runs in an
empty directory of its own and creates a Pages project with `--force`: without it, wrangler 4.15x
hands `pages project create` on to Workers, which made a Worker of the directory it ran in
(2026-10-29, Obeya's checkout). A new project's address resolves only once something is deployed
there, so the setup deploys a blank page and waits up to about two minutes for the address to answer;
before that, the first share could not read the site and would refuse. GitHub Pages: a public repository `<repository>-demos` under gh's account, with Pages
turned on for its `main`, and the built-in deploy as the deploy line.

GitHub Pages takes no directory upload, so Obeya builds its deploy in: a deploy line
`obeya:github-pages <owner>/<repository>` commits the site's directory as a single commit without
history and force-pushes it to the repository's `main`, so videos do not pile up in it. git runs with
gh's token in its environment (an `http.extraheader`), never on the command line; in a repository
made afresh for each deploy, with nothing of the machine's git configuration that could leave files
out or stop the commit (ignores, hooks, signing); `.nojekyll` keeps Jekyll from dropping files. It
runs as programs with their arguments, so it works on Windows and Linux. GitHub takes files up to 100
MiB and sites up to about 1 GB; its build takes a minute or so, so the check after a deploy waits
about two minutes.

#### The personal site

The owner's personal site is one per person, in Obeya's home (`personal-site.json`: host, address,
the host's project, the manifest's secret directory, the env file, the private repositories ticked,
the repositories ticked to share with the approval),
not in any repository: the site is a repository's setting, but credentials belong to a person. It
takes every repository without a site of its own, and every one whose site this machine lacks the
credentials for: a contributor's Obeya on Obeya's own repository shares there, and the PR gets the
link as any page's (see The page and the pull request).

A public repository shares there at once; its forge says whether it is public (gh, the Forgejo API).
Obeya keeps the forge's last answer across restarts and starts from it until the forge answers
again, so workers resumed in that time get the tools and brief of a repository that shares; a
question that fails leaves the last answer standing.
A private one, or one whose forge cannot tell (no remote, a folder), shares there only once the owner
ticks it: the export box on its cards says the repository is private and offers „Demos dieses
Repositorys auf meiner persönlichen Seite teilen“, and the configuration lists the private
repositories of the canvases (and those ticked) with a checkbox each, ticked or not, to change it
there too. A repository whose site publishes on approval does so on the personal site too; one
without a site the owner may tick for it on the personal site (see Publishing on approval).

Where the personal site lives decides whether it is listed, without a setting of its own: on
Cloudflare Pages and from a private GitHub repository it is unlisted; from a public GitHub repository,
whose files anyone can list, it is listed like a repository's site (overview, feed, a page at
`<slug>/`, the manifest at the root), and a random part in its addresses would hide nothing. A
repository's site is listed, always. Unlisted means:

- no overview, no feed, no tag links on the pages, no link to the site's root;
- a page lies at `<token>/<slug>/`: the slug for reading, the token (16 letters and digits, about 82
  bits) for not guessing; it is drawn once per card, on its first share there, and kept through a
  withdrawal, so sharing again gives the same link;
- the root, and the answer to every address the site lacks (`404.html`, which Cloudflare and GitHub
  Pages serve), are a blank page, so neither the root nor the level above a page lists anything;
- the manifest lies in a secret directory (`<secret>/obeya-site.json`, about 128 bits) that only the
  owner's machines know: at the root it would list every page;
- every page says `noindex, nofollow` and `no-referrer` in meta tags (GitHub Pages sends no headers
  of the site's), and `_headers` sends `X-Robots-Tag` and `Referrer-Policy` for every file where the
  host reads it, so a click on „Aufgenommen mit Obeya“ does not pass the address on. No `robots.txt`:
  a `Disallow` keeps search engines from reading the `noindex`, so a link found in a public PR could
  still show as a bare address.

Unlisted is not protected: whoever has a link can pass it on (and a link in a public PR is found by
the forge's search). The setup says the first in one sentence; for real protection a project's site
stays behind a login (Cloudflare Access).

Konfiguration → Demos sets it up („Persönliche Demo-Seite“, the host to choose, „Einrichten“), and a
card's export box, while there is none, offers „Persönliche Demo-Seite einrichten“, which opens it
there. The switcher offers, in this order, each with a line under it:

- „GitHub, öffentliches Repository“ („Geht mit jedem GitHub-Konto.“): a public repository
  `obeya-demos` (a number where the name is taken; an existing one is never reused) under gh's
  account, with Pages turned on, deployed by the built-in deploy. First, since anyone's demo
  repository seen by chance makes Obeya known; what public means for finding the demos goes unsaid,
  as it is plain.
- „GitHub, privates Repository“ („Braucht GitHub Pro.“): the same in a private repository, unlisted.
  Obeya creates it with `--private`, checks GitHub's answer on its visibility before anything goes
  in, and again before every deploy (a repository made public since, or one named by a connection
  code, would show every page's token), and stops otherwise. An account on the free plan is refused
  before anything is created, and a refusal when Pages is turned on gives GitHub's reason (the
  repository stays, private); both offer Cloudflare instead.
- „Cloudflare“ (free account, unlisted): a project `obeya-<user name>` (a suffix where taken), as
  for a repository's site; its address is the one Cloudflare names (`…pages.dev`). Besides the
  account of a site this machine deploys to and the machine's own login, „anderes Konto: API-Token“
  takes another account's token (with „Cloudflare Pages: Bearbeiten“; its account's id where the
  token covers several) into the new site's env file, so the login other sites deploy with stays.

The setup runs in the background and shows its last line. The sentence that unlisted is not
protected shows only for the two unlisted hosts.

Another machine of the owner's joins with a connection code: „Verbindungscode kopieren“ (under
„Weitere Rechner“, with a line saying where to paste it) on one gives
`obeya-site:` and the site, its secret directory and the env file's values, base64url-encoded;
„Mit vorhandener Seite verbinden“ on the other (with a line beside it saying where the code comes
from) takes it and writes them under its home. Without
credentials in it (a site deploying with the machine's own login), the other machine deploys with its
own `wrangler login` or `gh auth login`. Its first share pulls the pages from the live site as any
machine's does (see Several machines on one site). „Von diesem Rechner entfernen“ asks once more: the
pages and the project stay, and only a connected machine can withdraw them.

#### Several machines on one site

Each deploy replaces the whole site, so a machine must pull before it pushes. The site carries
`obeya-site.json`: every page with its metadata, files with size and hash, a revision and the
writing machine; withdrawn pages stay as tombstones so a stale machine does not revive them. Only the
machine whose card a page is changes it.

Before every publish or withdrawal Obeya reads the live manifest (with `headers`), downloads missing
or newer pages (a new machine's first share fetches all, logging every 25 pages), drops withdrawn
ones, keeps pages the live site lacks, writes, and deploys. Redirects within the site are followed
(Cloudflare Pages redirects `…/index.html` to `…/`); one elsewhere is a login. Just before deploying
it rereads the manifest and starts over if another machine deployed. After deploying it polls for
about 30 s (if the site never shows it, the deploy counts, with a log line saying so); another
deployment that dropped the change makes it redo once, a second fails the share.

A deployment racing past this check still takes a page offline (no compare-and-swap on a static
host): the once-a-minute check when the owner comes back redeploys pages the live site lacks or has
older, with a line on their cards. An unreadable manifest refuses the deploy; a 404 is the first
deploy; a manifest answered with the host's fallback page (HTTP 200) counts as missing. A page
another machine withdrew loses its link here, with a line naming the machine.

### Decisions

- **Sharing belongs to a demo version; one page per card holds the shared versions, oldest on top**
  (owner, 2026-10-16): a later demo often only corrects a detail and is read after what it corrects.
  Rejected: replacing the page with each demo, newest first, one player with a version switcher (a
  colleague might never find the other), a page per version (several links for one change).
- **A supplement takes along what it supplements** (owner, 2026-10-28): a page showing only a
  short correction leaves colleagues without the change it corrects; approval had published a card's
  second demo alone, its first never shared. Rejected: always every demo of the card (one recorded
  afresh would sit beside the one it replaces).
- **"Teilen" sits on the demo's own line** (2026-10-14). Rejected: a full-width button under the
  chapters, out of sight under many chapters or a tall artifact.
- **A shared artifact's pages load no file beside them** (2026-10-16, 2026-10-20): behind Cloudflare
  Access the frame's requests lack the login's cookie (Firefox showed only alt texts), and from disk
  nothing loads in CORS mode. Rejected: `allow-same-origin` (the artifact's scripts could read the
  whole site with the viewer's cookie), and the page around fetching files for the frame (fails from
  disk; markup lacks images until a script inserts them).
- **A page of work landed without a PR links its commit** (owner, 2026-10-30): a repository that
  commits to `main` directly has no PR to link back to, but its commit is as good a source. Several
  commits get the comparison over them, since the last alone shows only part of the change.
  Rejected: holding the approval's publish until the landing, to deploy once; the second deploy
  is the one a late PR already takes.
- **HTML artifacts are shared too** (2026-10-05): an analysis with charts is background for a pull
  request as much as a video.
- **A worker hears of its page with its next step, not in a turn of its own** (2026-10-29): it
  had answered the owner that its demo lay only on this machine minutes after they shared it.
  Nothing waits on the news, so a turn for it would cost the owner time and tokens; heard late, it
  is still there when the worker next speaks.
- **Sharing takes effect at once** (2026-10-02). Rejected: an 8 s hold with "Doch nicht";
  withdrawing is as easy.
- **Sharing on approval on the personal site is the owner's choice per repository** (owner,
  2026-10-29): the site is theirs, so their colleagues need not follow it. Rejected: the repository's
  settings (it would go for everyone who works in it), one choice for the whole personal site.
- **On approval, sharing only when „Mit der Freigabe teilen“ stays ticked** (2026-10-20), with
  „Jetzt teilen“ beside it, so a demo can go to colleagues for review before approval. Rejected:
  approval always sharing.
- **Deploys run in `share/` under Obeya's home** (2026-10-05): run in the checkout, wrangler's cache
  blocked the pool workspace from being leased.
- **A repository's theme is a file in it, `.obeya/theme.css`, not settings** (owner, 2026-11-01):
  a stylesheet gives full freedom (colours, fonts, spacing, a logo), and Obeya manages nothing of
  it. Rejected: single colour fields in the settings (too narrow), a `theme.html` with pieces of
  markup (it would need insertion points and scripts, a risk without a gain), and a theme UI in
  Obeya. The markup the pages have is its interface from then on.
- **A page is outdated by a change written down for its viewers** (2026-10-16). Rejected: a hash of
  the pages' bytes, which marked pages outdated without saying what changed, also where nothing
  showed, so the owner could not judge whether resharing 70 pages was worth it.
- **Each outdated page is updated on its own card** (2026-10-05). Rejected: rewriting every page on
  each share, unseen and slow with hundreds.
- **A shared page speaks the demo's language** (2026-10-07).
- **The overview's language is the repository's `demo.language`** (2026-10-19). Rejected: a
  `language` of the site's own, a second setting for one need; a file that still has it is read
  without it, and the configuration flags it.
- **Static sites are built in from a few settings, and the demo site is the only place "Teilen"
  publishes to** (2026-10-09, 2026-10-15). Rejected: a kit library for per-repository share scripts
  (a script per repository), hosting providers in the core (one deploy line covers them all), a
  share command receiving each page as JSON (unused once sites existed; two unconnected settings for
  one thing). Hosts that cannot take a whole directory are unsupported; a `deploy` script may upload
  only what changed.
- **A page names who shared it by git's `user.name`** (2026-10-20). Rejected: a name setting in
  Obeya (one more field for a name agents already commit under) and the host name (a computer, not a
  person).
- **The credit line has no setting**: settings stay few; a static credit line is common practice.
- **Pages are tagged from a fixed vocabulary in the repository's settings; the worker tags at
  handover, a session fills gaps, the owner corrects on the card** (owner, 2026-10-28): with a
  hundred pages and more the overview needs a filter, and the worker knows the change best, at no
  extra cost. Rejected: a session tagging at every share (a session per approval, knowing less than
  the worker), tagging by hand only (too much with over 100 pages; it stays the way to correct), tags
  the AI makes up (a filter with near-duplicates).
- **Links are copied one by one and as the filtered list** (owner, 2026-10-28): a demo goes to one
  person, or several on one topic into a mail, release notes or to a customer.
- **A personal site per person, beside the repositories' sites** (owner, 2026-10-28): the site is a
  repository's setting, but credentials are a person's, so a contributor (or a second project without
  a site) had only an export. Rejected: an Obeya service to share on (`share.obeya.si`), now or
  later (costs, moderation, duties of a host; Cloudflare or GitHub Pages leave a contributor one step
  of a few minutes).
- **The personal site is unlisted, also for public repositories, where its host allows** (owner,
  2026-10-28): an overview of all projects is another kind of public than links one would have to
  collect, and an unlisted page can go to one recipient. Rejected: a setting for listed or unlisted
  (the host decides it).
- **A private repository shares on the personal site only once ticked** (owner, 2026-10-28), so
  nothing of a private project goes out unasked; one whose forge cannot tell counts as private.
- **A handover asks for the page only where the session's tools take one** (2026-10-29): a session
  resumed after a restart got its tools before the forge said the repository was public, so the
  page the worker sent was dropped and every handover refused for lacking it. Rejected: the page in
  every repository's tools (workers without a site would write pages nobody reads).
- **A repository is as public as its forge said last, until it answers again** (2026-10-29): after
  every restart a public repository counted as private until the forge answered, so its resumed
  workers wrote no page. Rejected: resuming its workers only after the answer (a slow or unreachable
  forge would hold them up). A repository made private since shares as public for those seconds.
- **Three hosts for the personal site: a public GitHub repository first, a private one, Cloudflare**
  (owner, 2026-10-29): it works without GitHub Pro, and public demo repositories make Obeya known.
  A public repository's site is listed, without random parts (they would hide nothing). Rejected
  (2026-10-28, then reversed): GitHub only from a private repository.
- **The setup's warning names no forge's search** (owner, 2026-10-29): a link in a public PR is
  found whatever the host, and a repository need not be on GitHub.
- **No `robots.txt` on the unlisted site** (2026-10-28): its `Disallow` hides the `noindex` from
  search engines, which may then list a linked address without its content.
- **Several machines pull before they push** (2026-10-09). Rejected: refusing deploys while the live
  site has pages missing here (leaves copying by hand), and a shared storage folder or bucket as the
  source (pushes the problem onto each user's setup).
