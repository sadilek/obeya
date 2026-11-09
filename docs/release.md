# Releasing Obeya

How a version of the app goes out, and the owner's steps it depends on. The builds are described
in [`docs/design/distribution.md`](design/distribution.md) (Builds, App updates).

The Mac apps are signed with a Developer ID and notarised; the Windows installer and the Linux
packages are not signed (Windows: the SignPath Foundation, applied for), and the release lists the
SHA-256 of every file in `SHA256SUMS`.

## A release

Every release takes the site along: the hero video is rendered again from the Obeya being
released, and the site's screenshots are taken again with it. When the owner says "Mach ein
Release", the project skill `.claude/skills/release/SKILL.md` goes through these steps in this
order, on an Obeya card or in a terminal; it adds when to ask the owner and what to look at.
The scripts that talk to GitHub act on the checkout's origin as the account that owns it
(`sadilek` for sadilek/obeya, with its gh login, without switching the account gh has active);
other gh calls go through `bun scripts/gh.ts <gh args…>`, which does the same, since the
machine's active account may lack the admin rights a workflow run or a rerun needs.

1. Where things stand: `bun scripts/release-status.ts` prints the last version tag, the commits
   since then that change what runs (the release's notes will be their subjects), the version to
   propose (the next minor one while the version is 0.x), how far GitHub's `main` is behind, the
   latest release and whether `site-media` is still a pre-release, when the site's video went up
   next to the last commit to `src/ui`, and whether the build's secrets are there. It ends with what
   stands in the way and exits with 1 then.
2. The narration (`scripts/hero-video/narration.ts`), read against the UI being released: a
   sentence that no longer holds is reworded before the render. Every changed sentence costs
   ElevenLabs credits; the others come from the clip cache in the render's `.work/`, so the render
   goes to its default directory `obeya-hero/` in the demo directory (`<demos>`: `~/demos` unless
   the demo settings name another), not a new one. The README's text is read the same way: like
   the site, it names what the release adds that a newcomer should know.
3. The video, rendered whole from the release's code, with real agents whose run is recorded
   (`--record`), about ten minutes (`scripts/hero-video/README.md`), and its stills checked for the
   three failures the README names. A take on a busy machine stutters, so the render measures the
   machine first and does not start when it is short of memory or its cores are nearly all busy,
   unless told to (`--ignore-load`): whether to free the machine or render anyway is the owner's
   call. A correction of the scenes after that renders again with the recording played back
   (`--replay`), in a few minutes; a run that went wrong is recorded anew.
   Then from the same render, in the release's checkout:
   - the site's screenshots, `bun scripts/site-shots.ts`, with the first Tipjar demo the render's
     agent left (`<demos>/tipjar-split-the-bill*`; the newest is its shorter second demo, on the
     comments, which the script passes over; where the agent rendered that second demo over the
     first, Obeya's copy of the first is in the render's scratch home,
     `/tmp/obeya-scratch-4730/home/kept-demos/<card>/<handover>/`, whose `index.html` holds the
     chapter times its copy lacks a `chapters.vtt` for: `--demo` names it, `--at` a moment of it
     where the one its chapters pick shows the change badly; the review card's picture takes the
     render's second demo, on the comma as the decimal point (`<demos>/tipjar-*comma*`, else the
     newest `tipjar-split-the-bill*`), or the one `--review-demo` names), into `site/img/`: the desktop ones and the two of the phone view (`phone.png`, `phone-demo.png`), which the README
     shows too (`canvas.png` and the phone's);
   - the video's poster, `node scripts/hero-video/publish.ts --poster-only`
     (it uploads nothing);
   - a copy of `demo.mp4`, `captions.vtt` with the `captions.<language>.vtt` it names (without
     them the card shows no captions), `chapters.vtt` and `review/` in `<demos>/obeya-v<version>/`,
     so that what goes out in step 8 is the video that was looked at, even if the hero video is
     rendered again meanwhile.
4. The version in `package.json` (the app, its settings and the release take it from there),
   committed with the README, the poster and the screenshots. Landing it restarts a running Obeya
   (`package.json` counts as code).
5. `git push origin main`. The tag's commit has to be on GitHub, and the README and the site
   come from `main`.
6. `git tag v<version> main` and `git push origin v<version>` (`git push` alone pushes no tag).
   The tag goes on the tip of the current `main`, not on the version commit, so a release holds
   everything on `main` when it is tagged, also what landed while it was prepared; a tag set
   earlier moves there. The tag must be the version of `package.json`, else the run makes no
   release (its first check fails at once). The build workflow builds every platform, checks them,
   signs and notarises the Mac apps (Apple answers within a minute or so) and makes a draft release
   with the installers, the updates and their signatures, `SHA256SUMS`, `latest.json` and notes
   from the commits since the tag before. A run takes about ten minutes.
7. The run and the draft: the run of the build workflow for the tag (`bun scripts/gh.ts run list
   --workflow build.yml --branch v<version>`, then `bun scripts/gh.ts run watch <id>`; a job that
   failed on something flaky runs again with `bun scripts/gh.ts run rerun <id> --failed`), then
   `bun scripts/release-status.ts draft v<version>`, which checks that the draft holds every
   installer, update and signature, and a `latest.json` of the version that names every platform,
   and prints the notes. A run that fails on the Macs with HTTP 403 needs the owner to accept
   Apple's agreement (Signing the Mac apps).
8. The video: `HERO_OUT=<demos>/obeya-v<version> node scripts/hero-video/publish.ts` uploads it with
   its captions and chapters and runs the Pages workflow, which publishes the poster and the
   screenshots pushed in step 5 along with it.
9. The owner reads the draft and publishes it as the latest release ("Set as the latest release"
   stays ticked). Publishing reaches every installed app, so that click is the owner's. The README's
   and the site's download links go to the latest release; installed apps
   find it at their next start or within six hours, and offer it in their bar. The notes in
   `latest.json` (what the bar shows on hover) are the generated ones, whatever the release's text
   says after an edit. Afterwards `bun scripts/release-status.ts` names the new version as the
   latest release.

The release `site-media` holds the site's video (`scripts/hero-video/`), not a version: it is a
pre-release, so it never becomes the latest release, and its tag does not count as the tag before.

## The updater's key

Installed apps install only what is signed with Obeya's own key pair (Tauri's updater, made with
`tauri signer generate` on 2026-10-08, without a password).

- The public key is in `app/tauri.conf.json` (`plugins.updater.pubkey`); every app carries it.
- The private key is `~/.tauri/obeya.key` on the owner's Mac. Keep a copy in a password manager:
  without it no update reaches the apps that are installed, which would then have to install the
  next version by hand.
- The build workflow signs with the repository secret `TAURI_SIGNING_PRIVATE_KEY`, the file's
  content (`gh secret set TAURI_SIGNING_PRIVATE_KEY --repo sadilek/obeya < ~/.tauri/obeya.key`),
  read on tags only. Without it a release has no updates and `latest.json` names no platform.

A key that is lost or got out is replaced by a new pair whose public key goes into
`app/tauri.conf.json`; apps installed before still trust the old one, so the release with the
new key has to be installed by hand once (say so in its notes).

## Signing the Mac apps

The build signs and notarises them with four repository secrets, five with a team key (Settings →
Secrets and variables → Actions, or `gh secret set <NAME> --repo sadilek/obeya`, which reads the
value from standard input). A tag fails on the Macs while one is missing.

### Membership and agreement

The Developer ID needs a membership in the Apple Developer Program (99 USD a year). Apple's API
refuses notarisation ("A required agreement is missing or has expired", HTTP 403) until the
account holder has accepted the newest Program License Agreement: it shows as a banner on
<https://developer.apple.com/account> and in App Store Connect under Business. Apple renews it
now and then, and a release fails the same way until it is accepted again.

### The Developer ID Application certificate

1. Make it, if the keychain has none (`security find-identity -v -p codesigning` lists a
   "Developer ID Application: …"): in Xcode, Settings → Accounts → the team → Manage
   Certificates → + → Developer ID Application (only the account holder may), or on
   <https://developer.apple.com/account/resources/certificates> with a certificate signing
   request from Keychain Access (Certificate Assistant → Request a Certificate from a Certificate
   Authority, saved to disk).
2. Export it with its private key: Keychain Access → login → My Certificates → the
   "Developer ID Application: …" entry → Export → `.p12`, with a password. The `.p12` format is
   offered only for the certificate with its private key (the entry under My Certificates, the
   key folded under it); under Certificates it is greyed out. Exported from the key's row instead,
   the file holds the key without the certificate, and the build fails with "failed to resolve
   signing identity". `openssl pkcs12 -info -noout -in obeya.p12` lists what the file holds: a
   "Certificate bag" and a "Shrouded Keybag".
3. Secrets:
   - `APPLE_CERTIFICATE`: the `.p12` in base64, `base64 -i obeya.p12 | gh secret set APPLE_CERTIFICATE --repo sadilek/obeya`
   - `APPLE_CERTIFICATE_PASSWORD`: the export's password.
4. Delete the `.p12` file. The certificate is valid for five years; apps signed and notarised
   before it expires keep opening (the signature carries a timestamp). A new one goes into the
   two secrets the same way (`security find-certificate -c "Developer ID Application" -p | openssl x509 -noout -enddate`
   says when it ends).

### The App Store Connect API key, for notarisation

1. On <https://appstoreconnect.apple.com/access/integrations/api>: a team key (Team Keys → +,
   access "Developer"), or an individual key (Individual Keys, for the account's own user).
   Download the `.p8` (Apple offers it once) and note its key ID; for a team key also the Issuer
   ID above the list.
2. Secrets:
   - `APPLE_NOTARY_KEY`: the `.p8`'s contents, `gh secret set APPLE_NOTARY_KEY --repo sadilek/obeya < AuthKey_XXXXXXXXXX.p8`
   - `APPLE_NOTARY_KEY_ID`: the key ID.
   - `APPLE_NOTARY_ISSUER`: the Issuer ID, for a team key only.
3. Keep the `.p8` somewhere safe (`~/.appstoreconnect/private_keys/` is where Apple's tools look)
   or delete it; Apple does not offer it again, a lost one is revoked and replaced.

### Trying it before a release

Actions → Build → Run workflow, with "Sign and notarise the macOS app" ticked (or `bun scripts/gh.ts
workflow run build.yml --ref main -f sign=true`): the Macs build as on a tag (without a release),
and the step "The compiled server and the app around it" ends with Gatekeeper's verdict,
`source=Notarized Developer ID`. On a Mac, `bun run build:app` does the same with the certificate
in the keychain:

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" \
APPLE_NOTARY_KEY=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8 \
APPLE_NOTARY_KEY_ID=XXXXXXXXXX APPLE_NOTARY_ISSUER=<issuer, team key only> \
bun run build:app
```

## Windows and Linux

Not signed. SmartScreen warns about the Windows installer until it has a reputation ("More
info", then "Run anyway"), which the site and the README say. The release notes say how to check a
download against `SHA256SUMS`.

### The SignPath Foundation

The Windows certificate is to come from the SignPath Foundation: free for open-source projects,
issued in the Foundation's name, the key in SignPath's HSM, each release signed from a GitHub
Actions build after an approver has approved its signing request. Applied for after v0.5.0
(2026-10-19). Its conditions (<https://signpath.org/terms>) as they bear on Obeya:

- **Every component under an OSI licence, nothing proprietary.** The server (`obeya.exe` in the
  installer) has Anthropic's Claude Agent SDK compiled into it, whose licence is "© Anthropic PBC.
  All rights reserved"; Claude Code itself is not shipped. The application says so up front. If
  SignPath declines because of it, Obeya takes a certificate of its own (below); dropping the SDK
  to qualify was rejected (`docs/design/distribution.md`, Decisions).
- **Reputation** for downloadable programs: SignPath's judgement, without a threshold. At the
  application: the repository two weeks old, 7 stars, a handful of downloads per release.
- **A code signing policy** on the home page and the download and release pages, under that
  name: `site/code-signing/index.html` (obeya.si/code-signing/), linked from the site's download
  section and footer, the README's download section and the notes of every release
  (`build.yml`). It has the sentence SignPath prescribes ("Free code signing provided by
  SignPath.io, certificate by SignPath Foundation"), the team's roles and the privacy statement:
  what Obeya connects to and when. It says the Windows installer is not signed until the
  application is accepted; that sentence goes once a signed release is out.
- **Multi-factor authentication** for every team member, on GitHub and on SignPath.
- **Signed are only our own builds**, made from the repository by GitHub Actions; product name and
  version are set on every signed file and enforced by SignPath's artifact configuration.

After an acceptance: SignPath creates an account for the applicant (turn on MFA there), then the
build workflow submits the unsigned installer and the programs in it through SignPath's GitHub
action (`signpath/github-action-submit-signing-request`) and waits for the approved, signed
result, before the updater's signature is made over it. `obeya.exe` carries Bun's metadata unless
`bun build --compile` sets its own (`--windows-title`, `--windows-version` …). The sentence on the
policy page, the site, the README and the release notes about the unsigned installer go.

If SignPath declines: a certificate in the owner's name. Microsoft's Artifact Signing ($10 a month)
takes individuals only in the US and Canada (2026); Certum's "Open Source Code Signing" in its
SimplySign cloud costs €49 a year, shows "Open Source Developer, Daniel Sadilek", and asks for a
code from its phone app for every signing session, which makes signing in GitHub Actions awkward;
CAs with CI signing cost about €200–500 a year. SmartScreen's reputation has to grow with any new
certificate.
