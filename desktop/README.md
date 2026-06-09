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
