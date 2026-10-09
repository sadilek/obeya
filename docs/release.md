# Releasing Obeya

How a version of the app goes out, and the owner's steps it depends on. The builds are described
in `docs/design.md` (Builds, App updates).

The Mac apps are signed with a Developer ID and notarised; the Windows installer and the Linux
packages are not signed, and the release lists the SHA-256 of every file in `SHA256SUMS`.

## A release

1. Set the version in `package.json` (the app, its settings and the release take it from there),
   commit it on `main`.
2. Tag the commit `v<version>` and push the tag. The tag must be the version of `package.json`,
   else the run fails at once. The build workflow builds every platform, checks them, signs and
   notarises the Mac apps (a few minutes more per Mac) and makes a draft release with the
   installers, the updates and their signatures, `SHA256SUMS`, `latest.json` and notes from the
   commits since the tag before.
3. Read the draft and publish it. The README's and the site's download links go to the newest
   published release; installed apps find it at their next start or within six hours, and offer
   it in their bar. The notes in `latest.json` (what the bar shows on hover) are the generated
   ones, whatever the release's text says after an edit.
4. The first release: remove the line saying that the first release is on its way from
   `README.md` and `site/index.html`.

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

The build signs and notarises them with four repository secrets (five with a team key) (Settings → Secrets and variables
→ Actions, or `gh secret set <NAME> --repo sadilek/obeya`, which reads the value from standard
input). A tag fails on the Macs while one is missing.

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
   key folded under it); under Certificates it is greyed out.
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

Actions → Build → Run workflow, with "Sign and notarise the macOS app" ticked (or `gh workflow run
build.yml --repo sadilek/obeya --ref main -f sign=true`): the Macs build as on a tag (without a
release), and the step "The compiled server and the app around it" ends
with Gatekeeper's verdict, `source=Notarized Developer ID`. Notarisation takes a few minutes per
Mac. On a Mac, `bun run build:app` does the same with the certificate in the keychain:

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" \
APPLE_NOTARY_KEY=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8 \
APPLE_NOTARY_KEY_ID=XXXXXXXXXX APPLE_NOTARY_ISSUER=<issuer, team key only> \
bun run build:app
```

## Windows and Linux

Not signed. SmartScreen warns about the Windows installer until it has a reputation ("More
info", then "Run anyway"), which the site and the README say; a certificate comes later
(SignPath Foundation, free for open-source projects, once a release with some reputation is
out). The release notes say how to check a download against `SHA256SUMS`.
