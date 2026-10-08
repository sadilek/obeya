# Releasing Obeya

A tag `v<version>` on `main` builds the installers on GitHub's runners and makes a draft release
(`.github/workflows/build.yml`, design: Builds). The Mac apps are signed with a Developer ID and
notarised; the Windows installer and the Linux packages are not signed, and the release lists the
SHA-256 of every file in `SHA256SUMS`. What follows is what the maintainer sets up once, and the
steps of a release.

## Once: the secrets

All of them are repository secrets (Settings → Secrets and variables → Actions → New repository
secret, or `gh secret set <NAME> --repo <owner>/<repo>`, which reads the value from standard
input). A tag fails on the Macs while the Apple secrets are missing.

### Apple: membership and agreement

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
   "Developer ID Application: …" entry → Export → `.p12`, with a password.
3. Secrets:
   - `APPLE_CERTIFICATE`: the `.p12` in base64, `base64 -i obeya.p12 | gh secret set APPLE_CERTIFICATE --repo <owner>/<repo>`
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
   - `APPLE_NOTARY_KEY`: the `.p8`'s contents, `gh secret set APPLE_NOTARY_KEY --repo <owner>/<repo> < AuthKey_XXXXXXXXXX.p8`
   - `APPLE_NOTARY_KEY_ID`: the key ID.
   - `APPLE_NOTARY_ISSUER`: the Issuer ID, for a team key only.
3. Keep the `.p8` somewhere safe (`~/.appstoreconnect/private_keys/` is where Apple's tools look)
   or delete it; Apple does not offer it again, a lost one is revoked and replaced.

### The updater's key

Tauri's updater checks every update against a key pair of the app's own (free, no certificate):

1. `bun x tauri signer generate -w ~/.tauri/obeya.key`, with a password.
2. Secrets: `TAURI_SIGNING_PRIVATE_KEY` with the contents of `~/.tauri/obeya.key`,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with its password.
3. Keep the key: an installed app accepts updates only signed with it.

### Trying the secrets before a release

Actions → Build → Run workflow, with "Sign and notarise the macOS app" ticked: the Macs build as
on a tag (without a release), and the step "The compiled server and the app around it" ends
with Gatekeeper's verdict, `source=Notarized Developer ID`. Notarisation takes a few minutes per
Mac. On a Mac, `bun run build:app` does the same with the certificate in the keychain:

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" \
APPLE_NOTARY_KEY=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8 \
APPLE_NOTARY_KEY_ID=XXXXXXXXXX APPLE_NOTARY_ISSUER=<issuer, team key only> \
bun run build:app
```

## A release

1. Set the version in `package.json` (the app, the settings and `latest.json` take it from
   there), commit it on `main`.
2. Tag and push: `git tag v0.2.0 && git push origin main v0.2.0`. The tag must be the version
   of `package.json`, else the run fails at once.
3. The run (about a quarter of an hour with notarisation) ends with a draft release holding the
   installers under fixed names, the update archives with their `.sig`, `SHA256SUMS` and
   `latest.json`. Try a download, then publish the draft on GitHub (Releases → the draft → Edit
   → Publish release). Only then do the site's and the README's download links and the
   installed apps' updater see it.
4. The first release: remove the line saying that the first release is on its way from
   `README.md` and `site/index.html`.

## Windows and Linux

Not signed. SmartScreen warns about the Windows installer until it has a reputation ("More
info", then "Run anyway"), which the site and the README say; a certificate comes later (SignPath Foundation, free for
open-source projects, once a release with some reputation is out). The release notes
say how to check a download against `SHA256SUMS`.
