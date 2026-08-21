# Crust desktop shell

A [Tauri 2](https://tauri.app/) shell (Windows-first) that wraps the Crust PWA as
a native desktop app. It adds two things the browser can't do:

- **Native call overlay** — a transparent, chromeless, always-on-top second
  window (the app's `/overlay` route) that can be made click-through to float
  over a borderless/windowed-fullscreen game. See `src-tauri/src/lib.rs`.
- **Global push-to-talk / mute hotkey** — a low-level keyboard hook that works
  even while another app is focused. Because an in-process `WH_KEYBOARD_LL` hook
  is blind while WebView2 is focused, the hook runs in a sidecar process (the
  same binary re-launched with `--mic-hotkey-helper`). See
  `src-tauri/src/mic_hotkey.rs`.

The shell bundles the built web app (`frontendDist: "../../dist"`), so build the
web app first.

## Global hotkeys

| Shortcut       | Action                                            |
| -------------- | ------------------------------------------------- |
| `Ctrl+Shift+O` | Toggle overlay click-through (mouse to the game)  |
| `Ctrl+Shift+L` | Close the overlay window                          |
| `Ctrl+Shift+Q` | Quit                                              |

The push-to-talk / mute key itself is configured in the web app's settings.

## Develop

From the repo root, build the web app, then run the shell from `desktop/`:

```sh
pnpm build            # repo root: produces dist/
cd desktop
pnpm tauri dev        # or: pnpm tauri build  -> installers under src-tauri/target
```

`pnpm tauri build` produces the Windows installers
(`Crust_<version>_x64_en-US.msi` and `Crust_<version>_x64-setup.exe`) under
`src-tauri/target/release/bundle/`.

## Code signing

Release builds are Authenticode-signed with an SSL.com certificate held in the
**eSigner** cloud HSM. The bundler runs `src-tauri/scripts/sign-windows.mjs` for
every artifact (`bundle > windows > signCommand`), and the script drives
[jsign](https://ebourg.github.io/jsign/) against eSigner's API - only the file
hash leaves the machine, and the file is signed and RFC 3161 timestamped in
place.

Signing needs five environment variables; `.github/workflows/desktop-release.yml`
supplies the four credentials from secrets of the same name held in the
**`windows-signing`** GitHub environment, and downloads and checksums
`JSIGN_JAR` per run:

| Variable                | Where it comes from                                                  |
| ----------------------- | -------------------------------------------------------------------- |
| `ESIGNER_USERNAME`      | SSL.com account username                                              |
| `ESIGNER_PASSWORD`      | SSL.com account password                                              |
| `ESIGNER_CREDENTIAL_ID` | eSigner signing credential (certificate) UUID, from the SSL.com portal |
| `ESIGNER_TOTP_SECRET`   | base64 TOTP secret saved when eSigner automation was enabled          |
| `JSIGN_JAR`             | path to a `jsign-<version>.jar`                                       |

eSigner authenticates with the SSL.com **account login**, not a signing-scoped
token - that is how every eSigner client works (CodeSignTool, eSigner CKA,
jsign), and an IV/OV certificate cannot be shared with a separate CI user. Three
controls narrow what those secrets are worth, and a release should keep all
three:

1. They live in the `windows-signing` environment, which requires a reviewer to
   approve each run and only permits `main` and `desktop-v*` tags. A job blocked
   by that ref policy fails outright, so this workflow no longer builds from
   arbitrary branches - build locally to test those.
2. The signing credential has an enable/disable toggle on SSL.com's **Signing
   Credentials** page. Leave it disabled between releases; it stops signing
   without revoking the certificate or rotating the account password.
3. Keep 2FA on the SSL.com account, so the password alone cannot reach the
   portal.

**Local builds are unsigned by design.** With none of the four credentials set
the script logs a skip and exits 0, so contributors can still build installers. Setting only some of them is treated as a misconfiguration and
fails the build. A `desktop-v*` tag is refused outright when the secrets are
absent, and CI re-verifies the finished artifacts - including the `crust.exe`
extracted back out of the MSI - before anything is uploaded.

Notes:

- eSigner subscriptions meter signatures (entry tiers allow 20/month). The
  bundler offers 11 files per build; the script declines the WiX build-time
  extensions and the NSIS plugins, leaving **5 signatures per release build**.
- One of those five is the NSIS uninstaller, which makensis builds under a
  temporary name (`nst*.tmp`) and signs through its `!uninstfinalize` hook. It
  looks like a stray temp file in the build log; it is not, and adding a skip
  rule for it would ship an unsigned `uninstall.exe`.
- No certificate buys an instant SmartScreen pass any more. The warning fades
  as the signature accrues reputation across downloads.
- If signing fails, rerun the build with `--verbose`: the bundler pipes the sign
  command's output and prints it only on success. CI already passes it.
- `Authentication failed with SSL.com` usually means the TOTP secret is in the
  wrong encoding - jsign base64-decodes it, so a base32 key (only `A`-`Z` and
  `2`-`7`) has to be converted first. A repeated `invalid otp` instead points at
  clock drift on the signing machine.

## Auto-update

On launch the shell checks
`https://github.com/bill-long/crust/releases/latest/download/latest.json`,
downloads any newer version, and verifies it against the public key in
`tauri.conf.json`. It then holds the update until the app exits, so a session is
never interrupted: `src/app/UpdatePrompt.tsx` offers Restart, and quitting by any
route applies it. The whole mechanism lives in Rust (`stage_update` /
`install_staged_update` in `src-tauri/src/lib.rs`) so the web bundle stays free
of Tauri imports; the app only listens for `crust://update-ready`.

The update artifact is signed by an Ed25519 keypair that has **nothing to do
with Authenticode** - it answers "can this app trust this update", not "does
Windows trust this app". Both are required for a release:

| Secret | Purpose |
| ------ | ------- |
| `TAURI_SIGNING_PRIVATE_KEY` | signs the `-setup.exe.sig` the installed app verifies |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for that key |

Regenerate the pair with `pnpm tauri signer generate -w <path>`. **Back the
private key up.** Its public half is compiled into every build shipped; losing
it means already-installed copies can never accept another update, and every
user would need a manual reinstall.

Notes:

- Updates are delivered through the **NSIS** `-setup.exe`, not the `.msi`. That
  matches where the ecosystem landed; pointing the manifest at the MSI is
  tauri-action's legacy default and updates an NSIS-installed app with an MSI,
  leaving two uninstall entries
  ([tauri-action#1027](https://github.com/tauri-apps/tauri-action/issues/1027)).
  Someone who installs the `.msi` by hand hits that same seam on first update.
- `createUpdaterArtifacts` is **not** in `tauri.conf.json`; it lives in
  `src-tauri/tauri.updater.conf.json`, which CI merges in with `--config`. With
  it enabled the bundler refuses to finish without the private key, which would
  break `pnpm tauri build` for every contributor.
- The endpoint follows `releases/latest`, so **publishing the draft release is
  what makes an update live**. A draft is invisible to the updater, which is
  what lets the artifacts be checked first.

## Rust checks

```sh
cd src-tauri
cargo build
cargo clippy
cargo test
```
