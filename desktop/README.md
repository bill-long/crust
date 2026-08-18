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

## Rust checks

```sh
cd src-tauri
cargo build
cargo clippy
cargo test
```

## Releasing

`.github/workflows/desktop-release.yml` builds, signs and publishes the Windows
installers. Push a `desktop-v<version>` tag whose version matches
`src-tauri/tauri.conf.json` (the workflow fails the build if they disagree) and
the installers land on a **draft** GitHub Release for you to review and publish.
A manual `workflow_dispatch` run does everything except create the release, so
the pipeline can be exercised without cutting a tag.

## Code signing

The application and both installers are Authenticode-signed with a code signing
certificate from [SSL.com](https://www.ssl.com/), whose private key lives in
SSL.com's **eSigner** cloud HSM. Nothing signing-related has to be installed on
a developer machine, and no hardware token is involved — the key never leaves
the HSM, and CI authenticates to it over the Cloud Signature Consortium API.

Signing is done by [Jsign](https://ebourg.github.io/jsign/), pinned to a version
and SHA-256 in `.github/actions/sign-windows/action.yml`.

### Repository secrets

| Secret                  | What it is                                                      |
| ----------------------- | --------------------------------------------------------------- |
| `ESIGNER_USERNAME`      | SSL.com account username                                          |
| `ESIGNER_PASSWORD`      | SSL.com account password                                          |
| `ESIGNER_CREDENTIAL_ID` | eSigner credential ID (a UUID) identifying the certificate        |
| `ESIGNER_TOTP_SECRET`   | Base64-encoded eSigner TOTP secret, used to derive the OTP        |

The credential ID and the TOTP secret both come from the eSigner section of the
SSL.com customer portal. The TOTP secret must be the **base64** form; if the
portal hands you a base32 string (the kind an authenticator app takes), convert
it before storing the secret.

To discover the credential ID, run Jsign without `--alias` — it fails and lists
the aliases available to the account.

**If the secrets are absent**, both signing jobs are skipped and the pipeline
still produces working but unsigned installers. Forks therefore build without
any extra setup, and so did this repository before the certificate arrived.

### Why the pipeline has six jobs

The signing credentials can sign code as us, and the release token can write to
this repository. Neither may ever share a job with third-party code we execute
(cargo build scripts, pnpm lifecycle scripts). So the work is split:

```
preflight ─┬─> build ──> sign-binary ──> bundle ──> sign-installers ──> release
           │   (deps)     (secrets)     (deps)        (secrets)        (write token)
```

`build` runs `tauri build --no-bundle` and `bundle` runs `tauri bundle` as
separate steps for the same reason: `crust.exe` has to be signed *before* it is
packaged into the `.msi` and the NSIS `.exe`, so the packaging step has to come
after a signing step. The signing jobs check out this repository (for the
composite action) but install no dependencies and run no project code.

For extra hardening the four secrets can be moved into a GitHub Environment with
a deployment branch rule limited to `desktop-v*` tags. The `preflight` job reads
them at repository scope to decide whether signing is configured, so it would
need a repository variable to gate on instead.

### Signing locally

Signing from a workstation uses the same credentials and the same tool:

```sh
# From desktop/, after `pnpm tauri build`
export JSIGN_STOREPASS='<ssl.com-username>|<ssl.com-password>'
export JSIGN_KEYPASS='<base64-totp-secret>'

java -jar jsign.jar \
  --storetype ESIGNER \
  --storepass env:JSIGN_STOREPASS \
  --keypass env:JSIGN_KEYPASS \
  --alias '<credential-id>' \
  --alg SHA-256 \
  --tsaurl http://ts.ssl.com --tsmode RFC3161 \
  --name Crust --url https://github.com/bill-long/crust \
  src-tauri/target/release/bundle/msi/*.msi \
  src-tauri/target/release/bundle/nsis/*-setup.exe
```

Pass every file to a single invocation. eSigner derives a one-time password per
authentication, and separate invocations inside the same 30-second TOTP window
can be rejected for reusing the code.

Note that this signs the installers only — `crust.exe` inside them was already
packaged unsigned. To match what CI produces, sign
`src-tauri/target/release/crust.exe` after `pnpm tauri build --no-bundle`, then
run `pnpm tauri bundle` and sign the two installers as above.

Verify a signed file on Windows with:

```pwsh
signtool verify /pa /v <file>
```

### SmartScreen

Signing removes the "unknown publisher" wording and shows *Bill Long* as the
publisher, but it does not, on its own, stop Microsoft Defender SmartScreen from
warning on a new download. SmartScreen reputation accrues organically per
signing certificate as signed releases are downloaded and run; no certificate
type buys an instant bypass any more.
