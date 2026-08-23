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
pnpm tauri dev        # or: pnpm tauri build  -> installer under src-tauri/target
```

`pnpm tauri build` produces the Windows installer
(`Crust_<version>_x64-setup.exe`) under `src-tauri/target/release/bundle/nsis/`.
NSIS is the only bundle target: see the auto-update section for why.

### Debugging an installed build

Release builds have no devtools (`windows_subsystem = "windows"`), but WebView2
honours the Chromium remote-debugging switch, so an installed build can be
inspected from a browser or over the DevTools protocol:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
& "$env:LOCALAPPDATA\Crust\crust.exe"
# then open http://127.0.0.1:9222/json (or edge://inspect) for the page target
```

The variable must be set in the environment the app is launched from, and an
already-running instance has to be closed first - WebView2 refuses to share a
user-data folder between processes started with different switches.

## Service worker

The shell registers the same `sw.js` as the browser build, but not the same
way, because **WebView2 never completes a service-worker update check** for the
origin Tauri's asset protocol serves (`registration.update()` fails with
"An unknown error occurred when fetching the script"; a fresh registration
installs fine). Whatever worker is registered first would control the origin
forever - and a precaching one would keep serving the app shell of the build
that registered it on every launch, against an exe whose hashed assets have
moved on. That is how #481 happened: the stale shell asked for a crypto wasm
the new exe no longer had, got `index.html` back, and Rust crypto never
initialized.

So, in the shell (all in `src/lib/nativeServiceWorker.ts` and `src/sw.ts`):

- the page registers `sw.js?native=1&build=<sha-256 of sw.js>`: a new script
  URL whenever the worker changes, which the browser treats as a new
  registration and does fetch (the digest is computed at runtime from the
  script the exe serves, so nothing build-specific is baked into the web
  bundle and a rebuild of the same sources stays byte-identical);
- in that mode the worker never precaches or serves app assets (the exe does),
  takes over immediately, and keeps only what a page cannot do without a
  worker - authenticated media (MSC3916);
- `src-tauri/src/evict_legacy_sw.js`, attached to every Crust webview as an
  initialization script, unregisters a leftover precaching worker (the
  `workbox-precache` cache is the marker) and reloads once. Nothing in the web
  bundle could do this: under the old worker the page IS the old build.

There is consequently no "App update / Refresh" card in the shell; the Tauri
updater's "Restart" card is the only update UI there.

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
the script logs a skip and exits 0, so contributors can still build installers.
Setting only some of them is treated as a misconfiguration and fails the build.
A `desktop-v*` tag is refused outright when the secrets are absent, and CI re-verifies the finished artifacts - including the `crust.exe`
7-Zip extracts back out of the installer - before anything is uploaded.

Notes:

- The bundler offers 7 files per build; the script declines the NSIS plugins,
  leaving **3 signatures per release build**. Windows does not verify those
  plugins, so signing them buys nothing - and eSigner subscriptions are sold in
  metered tiers, so a signature is not always free. Which tier (or trial) an
  account is on is a billing question, not something this repo should assume.
  (A WiX skip rule is also present but inert, in case an MSI target returns.)
- One of those three is the NSIS uninstaller, which `makensis` (the NSIS
  compiler) builds under a temporary name (`nst*.tmp`) and signs through its
  `!uninstfinalize` hook. It looks like a stray temp file in the build log; it
  is not, and adding a skip rule for it would ship an unsigned `uninstall.exe`.
- No certificate buys an instant SmartScreen pass any more. The warning fades
  as the signature accrues reputation across downloads.
- If signing fails, rerun the build with `--verbose`: the bundler pipes the sign
  command's output and prints it only on success. CI already passes it.
- `Authentication failed with SSL.com` usually means the TOTP secret is in the
  wrong encoding - jsign base64-decodes it, so a base32 key (only `A`-`Z` and
  `2`-`7`) has to be converted first. A repeated `invalid otp` instead points at
  clock drift on the signing machine.

## Auto-update

On launch, and every six hours after, the shell checks
`https://github.com/bill-long/crust/releases/latest/download/latest.json`,
downloads any newer version, and verifies it against the public key in
`tauri.conf.json`. The re-check matters because Crust is built to be left
running: a launch-only check would never see a release published mid-session,
so quitting would install nothing. It keeps checking after something is staged
too, replacing the held bytes, so a newer release does not have to wait for a
second restart; the download is skipped when the newest version is the one
already held. A failed check (offline, DNS not up yet) retries from one minute,
quadrupling up to the six-hour cadence.

The update is then held until the app exits, so a session is never interrupted:
`src/app/UpdatePrompt.tsx` offers Restart, and quitting by any route applies it. The whole mechanism lives in Rust (`stage_update` /
`install_staged_update` in `src-tauri/src/lib.rs`) so the web bundle stays free
of Tauri imports; the app only listens for `crust://update-ready`.

**A quit that applies an update relaunches the app.** That is not a choice this
code makes: the plugin passes the install mode's NSIS arguments, and every mode
that installs unattended includes `/R` (`passive` is `["/P", "/R"]`, `quiet` is
`["/S", "/R"]`), with no per-call way to drop it. The only mode without it,
`basicUi`, passes no arguments and shows the full installer UI instead. So the
choice is a brief progress window followed by a relaunch, or an installer the
user has to click through; this app takes the former.

One consequence of applying on *every* exit: a Windows logoff or shutdown also
fires the exit hook, so the installer is spawned into a session that is tearing
down and may be killed mid-write. The update itself is recoverable - the next
launch re-checks and re-downloads - but a half-written install directory is
not. Diagnostics for that path land in `updater.log` (see `log_update`).

The update artifact is signed by an Ed25519 keypair that has **nothing to do
with Authenticode** - it answers "can this app trust this update", not "does
Windows trust this app". Both are required for a release:

| Secret | Purpose |
| ------ | ------- |
| `TAURI_SIGNING_PRIVATE_KEY` | signs the `-setup.exe.sig` the installed app verifies |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for that key |

Regenerate the pair with `pnpm tauri signer generate -w <path>`, and **give it
a password** - `signer generate` will accept an empty one, but GitHub rejects
empty secret values, and the workflow treats a blank password alongside a set
key as a misconfiguration and fails the build. **Back the private key up.** Its public half is compiled into every build shipped; losing
it means already-installed copies can never accept another update, and every
user would need a manual reinstall.

Notes:

- **Only the NSIS `-setup.exe` is built and shipped.** An MSI would install
  per-machine into Program Files while this NSIS installer is `currentUser`
  (`%LOCALAPPDATA%`), and updates only ever arrive as NSIS - so an MSI user's
  first update lands a second copy, leaving two install directories and two
  uninstall entries
  ([tauri-action#1027](https://github.com/tauri-apps/tauri-action/issues/1027)).
  The MSI's real value is per-machine and managed (GPO/Intune) deployment; with
  no such user today, shipping one installer removes the seam instead of
  documenting it. Re-adding the target is a one-line config change.
- `createUpdaterArtifacts` is **not** in `tauri.conf.json`; it lives in
  `src-tauri/tauri.updater.conf.json`, which CI merges in with `--config`. With
  it enabled the bundler refuses to finish without the private key, which would
  break `pnpm tauri build` for every contributor.
- A local `pnpm tauri build` is a RELEASE build, so it checks the feed like any
  other: once a newer version is published, testing a local build would end with
  the published release installed over it on quit. Set `CRUST_NO_UPDATE=1` in
  the environment you launch the resulting APP from - it is read at app startup,
  not at build time, so setting it on the `pnpm tauri build` command does
  nothing.
- The endpoint follows `releases/latest`, so **publishing the draft release is
  what makes an update live**. A draft is invisible to the updater, which is
  what lets the artifacts be checked first.
- `releases/latest` is **repo-wide**, not desktop-scoped: GitHub resolves it to
  the newest non-draft, non-prerelease release of the whole repository. Nothing
  else publishes releases today (`ci.yml` builds containers), but a future `v*`
  web release - or one made by hand - would become "latest", and the asset
  fetch would 404, silently freezing updates for every installed client. Mark
  any non-desktop release as a prerelease, or move the feed to a dedicated tag.

## Rust checks

```sh
cd src-tauri
cargo build
cargo clippy
cargo test
```
