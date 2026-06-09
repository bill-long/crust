// Global push-to-talk / push-to-mute hotkey for the desktop shell, implemented
// as an OBSERVE-ONLY low-level keyboard hook (WH_KEYBOARD_LL via `rdev`) running
// in a SEPARATE SIDECAR PROCESS.
//
// Why a sidecar: an in-process low-level keyboard hook is BLIND while Crust's own
// WebView2 window is focused — Chromium/WebView2 routes keyboard input through
// its sandboxed render process, so the host-process hook callback never fires for
// keys typed into the focused app. (Verified with both `rdev` and a hand-rolled
// raw Win32 hook: empty capture while Crust-focused, full capture while another
// app is focused; a separate process captures everything regardless of focus.)
// Running the hook in its own process sidesteps that entirely and gives a SINGLE
// authoritative input path in every focus state — no fragile focus hand-off
// between an OS hook and a DOM listener.
//
// The sidecar is the SAME binary re-launched with `--mic-hotkey-helper` (see
// `run_helper`); `current_exe()` is the spawn path in both `tauri dev` and a
// packaged app, so there is no second artifact to bundle or locate.
//
// IPC is line-delimited text over the child's stdio:
//   parent -> child stdin : `none`  (clear the combo), or
//                           `combo <ctrl> <shift> <alt> <meta> <code|->`
//                           (each modifier is 1/0; `code` is a web
//                           KeyboardEvent.code, `-` means modifier-only).
//   child -> parent stdout: `true` / `false` on each held-state change, plus a
//                           snapshot after every combo update.
// The parent forwards each `held` line as a Tauri `mic-hotkey` event (payload =
// bool) to the web, which maps held -> mute. The child exits on stdin EOF, so it
// can't outlive the parent and leak a global hook (Rust keeps the parent's pipe
// write-end non-inheritable, so no other child process can hold it open).

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

/// The PTT/PTM combo mirrored from web settings. Field names/semantics match the
/// web `MicHotkey` (KeyboardEvent.code + modifier booleans; `code: None` is a
/// modifier-only combo).
#[derive(Deserialize, Clone, Default, Debug, PartialEq)]
pub struct MicHotkey {
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub meta: bool,
    #[serde(default)]
    pub code: Option<String>,
}

/// Parent-side handle to one running sidecar: its `Child` (to reap it), its
/// piped stdin (to forward combo updates), a `generation` that uniquely
/// identifies this child (so a stale reader thread can't reap a newer helper
/// after a respawn — an ABA guard), and `started_at` (to avoid respawn storms
/// if a helper dies immediately on launch).
struct Helper {
    child: Child,
    stdin: ChildStdin,
    generation: u64,
    started_at: Instant,
}

/// Parent-side sidecar bookkeeping behind a single lock.
struct Inner {
    helper: Option<Helper>,
    /// The most recent combo the web asked for, so a reader thread can respawn
    /// the helper after an abnormal death without waiting for a settings change.
    last_combo: Option<MicHotkey>,
    next_generation: u64,
}

fn state() -> &'static Mutex<Inner> {
    static STATE: OnceLock<Mutex<Inner>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(Inner {
            helper: None,
            last_combo: None,
            next_generation: 0,
        })
    })
}

/// Don't auto-respawn a helper that died almost immediately (e.g. the hook
/// failed to install) — that would spin spawning processes. A later settings
/// change can still retry.
const MIN_HEALTHY_UPTIME: Duration = Duration::from_secs(2);

/// Map a web `KeyboardEvent.code` to an rdev key. Returns `None` for codes we
/// don't handle (the combo simply won't match — callers pick a supported key).
fn code_to_key(code: &str) -> Option<rdev::Key> {
    use rdev::Key::*;
    Some(match code {
        "KeyA" => KeyA,
        "KeyB" => KeyB,
        "KeyC" => KeyC,
        "KeyD" => KeyD,
        "KeyE" => KeyE,
        "KeyF" => KeyF,
        "KeyG" => KeyG,
        "KeyH" => KeyH,
        "KeyI" => KeyI,
        "KeyJ" => KeyJ,
        "KeyK" => KeyK,
        "KeyL" => KeyL,
        "KeyM" => KeyM,
        "KeyN" => KeyN,
        "KeyO" => KeyO,
        "KeyP" => KeyP,
        "KeyQ" => KeyQ,
        "KeyR" => KeyR,
        "KeyS" => KeyS,
        "KeyT" => KeyT,
        "KeyU" => KeyU,
        "KeyV" => KeyV,
        "KeyW" => KeyW,
        "KeyX" => KeyX,
        "KeyY" => KeyY,
        "KeyZ" => KeyZ,
        "Digit1" => Num1,
        "Digit2" => Num2,
        "Digit3" => Num3,
        "Digit4" => Num4,
        "Digit5" => Num5,
        "Digit6" => Num6,
        "Digit7" => Num7,
        "Digit8" => Num8,
        "Digit9" => Num9,
        "Digit0" => Num0,
        "F1" => F1,
        "F2" => F2,
        "F3" => F3,
        "F4" => F4,
        "F5" => F5,
        "F6" => F6,
        "F7" => F7,
        "F8" => F8,
        "F9" => F9,
        "F10" => F10,
        "F11" => F11,
        "F12" => F12,
        "Space" => Space,
        "Tab" => Tab,
        "Escape" => Escape,
        "Enter" => Return,
        "Backspace" => Backspace,
        "Delete" => Delete,
        "Insert" => Insert,
        "Home" => Home,
        "End" => End,
        "PageUp" => PageUp,
        "PageDown" => PageDown,
        "ArrowUp" => UpArrow,
        "ArrowDown" => DownArrow,
        "ArrowLeft" => LeftArrow,
        "ArrowRight" => RightArrow,
        "CapsLock" => CapsLock,
        "Minus" => Minus,
        "Equal" => Equal,
        "BracketLeft" => LeftBracket,
        "BracketRight" => RightBracket,
        "Semicolon" => SemiColon,
        "Quote" => Quote,
        "Backquote" => BackQuote,
        "Backslash" => BackSlash,
        "Comma" => Comma,
        "Period" => Dot,
        "Slash" => Slash,
        "Numpad0" => Kp0,
        "Numpad1" => Kp1,
        "Numpad2" => Kp2,
        "Numpad3" => Kp3,
        "Numpad4" => Kp4,
        "Numpad5" => Kp5,
        "Numpad6" => Kp6,
        "Numpad7" => Kp7,
        "Numpad8" => Kp8,
        "Numpad9" => Kp9,
        "NumpadAdd" => KpPlus,
        "NumpadSubtract" => KpMinus,
        "NumpadMultiply" => KpMultiply,
        "NumpadDivide" => KpDivide,
        "NumpadDecimal" => KpDelete,
        "IntlBackslash" => IntlBackslash,
        "PrintScreen" => PrintScreen,
        "ScrollLock" => ScrollLock,
        "Pause" => Pause,
        "NumLock" => NumLock,
        // TODO: the web picker (HotkeyCaptureButton) can bind ANY
        // KeyboardEvent.code, but some can't be honored on desktop, so binding
        // one is silently dead. Either teach the picker to reject codes this
        // table can't support, or share one supported-key list across web+Rust.
        // Unsupported here:
        //  - keys rdev 0.5 has no variant for: media keys, ContextMenu/Menu,
        //    IntlRo, IntlYen, Fn.
        //  - "NumpadEnter": on Windows rdev reports the numpad Enter as `Return`
        //    (its KP_RETURN scancode is disabled), so it's indistinguishable
        //    from the main Enter — we can't map it without also hijacking Enter.
        _ => return None,
    })
}

fn combo_is_held(c: &MicHotkey, pressed: &HashSet<rdev::Key>) -> bool {
    use rdev::Key::*;
    if c.ctrl && !(pressed.contains(&ControlLeft) || pressed.contains(&ControlRight)) {
        return false;
    }
    if c.shift && !(pressed.contains(&ShiftLeft) || pressed.contains(&ShiftRight)) {
        return false;
    }
    // rdev reports right Alt as `AltGr`; treat either side as "alt".
    if c.alt && !(pressed.contains(&Alt) || pressed.contains(&AltGr)) {
        return false;
    }
    if c.meta && !(pressed.contains(&MetaLeft) || pressed.contains(&MetaRight)) {
        return false;
    }
    match c.code.as_deref() {
        // Modifier-only combo: held once at least one stored modifier is down
        // (the modifier checks above already confirmed the required ones).
        None => c.ctrl || c.shift || c.alt || c.meta,
        Some(code) => match code_to_key(code) {
            Some(k) => pressed.contains(&k),
            None => false,
        },
    }
}

// ---------------------------------------------------------------------------
// IPC line format (parent <-> sidecar)
// ---------------------------------------------------------------------------

/// Encode a combo for the child's stdin. `None` -> `none`; otherwise
/// `combo <ctrl> <shift> <alt> <meta> <code|->`. Web `KeyboardEvent.code`
/// tokens never contain spaces, and a real code is never `-`, so the line is
/// unambiguous.
fn encode_combo(hotkey: &Option<MicHotkey>) -> String {
    match hotkey {
        None => "none".to_string(),
        Some(c) => format!(
            "combo {} {} {} {} {}",
            c.ctrl as u8,
            c.shift as u8,
            c.alt as u8,
            c.meta as u8,
            c.code.as_deref().unwrap_or("-"),
        ),
    }
}

/// Decode a stdin line in the child. `Err(())` for a malformed line so the
/// caller can keep the previous combo rather than silently clearing it.
fn decode_combo(line: &str) -> Result<Option<MicHotkey>, ()> {
    let line = line.trim();
    if line == "none" {
        return Ok(None);
    }
    let mut parts = line.split(' ');
    if parts.next() != Some("combo") {
        return Err(());
    }
    let mut flag = || match parts.next() {
        Some("1") => Ok(true),
        Some("0") => Ok(false),
        _ => Err(()),
    };
    let ctrl = flag()?;
    let shift = flag()?;
    let alt = flag()?;
    let meta = flag()?;
    let code = match parts.next() {
        Some("-") => None,
        Some(c) if !c.is_empty() => Some(c.to_string()),
        _ => return Err(()),
    };
    if parts.next().is_some() {
        return Err(()); // trailing garbage
    }
    Ok(Some(MicHotkey {
        ctrl,
        shift,
        alt,
        meta,
        code,
    }))
}

// ---------------------------------------------------------------------------
// Sidecar process (`--mic-hotkey-helper`)
// ---------------------------------------------------------------------------

/// The sidecar's keyboard state, behind a single lock so that mutating it,
/// computing the resulting held value, and enqueueing that value to the writer
/// all happen atomically and in order.
struct HelperState {
    combo: Option<MicHotkey>,
    pressed: HashSet<rdev::Key>,
}

impl HelperState {
    fn held(&self) -> bool {
        match &self.combo {
            None => false,
            Some(c) => combo_is_held(c, &self.pressed),
        }
    }
}

/// A held value to emit to stdout, carrying the value computed at enqueue time
/// (NOT recomputed later) so a fast press+release can't be coalesced into a
/// single sample and a stale value can't overwrite a newer one.
enum Emit {
    /// A key event: print only if the value changed from the last emit.
    Transition(bool),
    /// A combo (re)bind: print unconditionally, so the web gets an explicit
    /// value even when it didn't change.
    Snapshot(bool),
}

/// Sidecar entry point (the process launched with `--mic-hotkey-helper`). Never
/// returns: a hook thread records key state, a SINGLE writer thread owns stdout,
/// and the stdin command loop applies combo updates. Each held value is computed
/// UNDER the state lock and enqueued in that same critical section, so the order
/// the writer prints matches the order key state actually changed — no dropped
/// taps and no stale overwrite. The writer prints OUTSIDE the lock, so a blocked
/// stdout pipe can never stall the low-level hook callback. Exits on stdin EOF.
pub fn run_helper() -> ! {
    // `'static` for the lifetime of the process (it runs until `exit`); leaking
    // lets the hook thread borrow it without Arc churn.
    let st: &'static Mutex<HelperState> = Box::leak(Box::new(Mutex::new(HelperState {
        combo: None,
        pressed: HashSet::new(),
    })));
    let (tx, rx) = mpsc::channel::<Emit>();

    // Sole stdout writer. Prints enqueued values in order, deduping unchanged
    // transitions; never touches the state lock, so it can't stall the hook.
    std::thread::spawn(move || {
        let mut last = false;
        for emit in rx {
            let (now, force) = match emit {
                Emit::Transition(v) => (v, false),
                Emit::Snapshot(v) => (v, true),
            };
            let changed = now != last;
            last = now;
            if changed || force {
                println!("{now}");
                let _ = std::io::stdout().flush();
            }
        }
    });

    // Hook thread: record every key up/down, compute the held value, and enqueue
    // it — all under the state lock so the channel order reflects event order.
    let hook_tx = tx.clone();
    std::thread::spawn(move || {
        let callback = move |event: rdev::Event| {
            let mut g = st.lock().unwrap();
            match event.event_type {
                rdev::EventType::KeyPress(key) => {
                    g.pressed.insert(key);
                }
                rdev::EventType::KeyRelease(key) => {
                    g.pressed.remove(&key);
                }
                _ => return,
            }
            let now = g.held();
            let _ = hook_tx.send(Emit::Transition(now));
        };
        // `rdev::listen` blocks forever on success; any return means the hook is
        // gone, so the helper is useless — exit and let the parent respawn.
        let _ = rdev::listen(callback);
        std::process::exit(1);
    });

    // Command loop: apply combo updates from the parent. Each update emits a
    // SNAPSHOT so the web always has an explicit, current value right after
    // (re)binding — no reliance on a prior transition.
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        match decode_combo(&line) {
            Ok(parsed) => {
                let mut g = st.lock().unwrap();
                g.combo = parsed;
                let now = g.held();
                let _ = tx.send(Emit::Snapshot(now));
            }
            // Keep the previous combo on a malformed line rather than clearing
            // it (a clear would silently disable the hotkey on a protocol bug).
            Err(()) => eprintln!("[mic-hotkey-helper] ignoring malformed line: {line:?}"),
        }
    }
    // stdin EOF: the parent closed the pipe (it exited or died). Stop so we
    // don't linger with a global keyboard hook installed.
    std::process::exit(0);
}

// ---------------------------------------------------------------------------
// Parent side (main app)
// ---------------------------------------------------------------------------

/// Drain the sidecar's stdout, forwarding each `held` line to the web as a
/// `mic-hotkey` event. Owns failure detection: on EOF the child has died, so —
/// ONLY if this is still the current helper (generation match, so a stale reader
/// can't clobber a newer respawn) — reap it, optionally auto-respawn (if a combo
/// is still bound and the child ran long enough to look healthy), and otherwise
/// emit a final `held=false` so a key down at death can't stick the mic.
fn spawn_reader(app: AppHandle, stdout: std::process::ChildStdout, generation: u64) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let held = l.trim() == "true";
                    let _ = app.emit("mic-hotkey", held);
                }
                Err(_) => break,
            }
        }

        let mut guard = state().lock().unwrap();
        // Superseded: a newer helper (or a clear) already replaced us. Do
        // nothing — that owner is responsible for its own lifecycle.
        if guard.helper.as_ref().map(|h| h.generation) != Some(generation) {
            return;
        }
        let dead = guard.helper.take().expect("current helper present");
        // Auto-respawn (once) if a combo is still bound and this child looked
        // healthy. Done under the lock so a concurrent `set_mic_hotkey` can't
        // race us into a double-spawn.
        let mut respawned = false;
        if dead.started_at.elapsed() >= MIN_HEALTHY_UPTIME {
            if let Some(combo) = guard.last_combo.clone() {
                respawned = spawn_and_bind(&app, &mut guard, &Some(combo));
            }
        }
        drop(guard);

        // Reap outside the lock; the child already exited so this won't block.
        let mut dead = dead;
        let _ = dead.child.wait();
        // If we respawned, the fresh helper will emit its own snapshot; don't
        // also force a stale `false` that could briefly un-key the mic.
        if !respawned {
            let _ = app.emit("mic-hotkey", false);
        }
    });
}

/// Spawn the sidecar (this same binary, re-launched with `--mic-hotkey-helper`)
/// for `generation` and start its stdout reader.
fn spawn_helper(app: &AppHandle, generation: u64) -> std::io::Result<Helper> {
    let exe = std::env::current_exe()?;
    let mut child = Command::new(exe)
        .arg("--mic-hotkey-helper")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("child stdin missing"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("child stdout missing"))?;
    spawn_reader(app.clone(), stdout, generation);
    Ok(Helper {
        child,
        stdin,
        generation,
        started_at: Instant::now(),
    })
}

/// Spawn a helper with the next generation, store it in `guard`, and send it
/// `combo`. Returns whether the combo was delivered. The caller must hold the
/// state lock (passed as `guard`).
fn spawn_and_bind(app: &AppHandle, guard: &mut Inner, combo: &Option<MicHotkey>) -> bool {
    let generation = guard.next_generation;
    guard.next_generation += 1;
    match spawn_helper(app, generation) {
        Ok(mut helper) => {
            let sent = writeln!(helper.stdin, "{}", encode_combo(combo))
                .and_then(|()| helper.stdin.flush())
                .is_ok();
            guard.helper = Some(helper);
            sent
        }
        Err(e) => {
            eprintln!("[crust] failed to spawn mic-hotkey helper: {e}");
            false
        }
    }
}

/// Mirror the web's current PTT/PTM combo to the sidecar. `None` (voice-activity
/// or unbound) clears it. The sidecar is spawned lazily on the first bound combo
/// and persists for the app's lifetime (it exits when this process closes its
/// stdin). Spawn + handle storage + the stdin write all happen under one lock so
/// concurrent calls can't race on a half-initialized helper.
#[tauri::command]
pub fn set_mic_hotkey(app: AppHandle, hotkey: Option<MicHotkey>) {
    let mut guard = state().lock().unwrap();
    guard.last_combo = hotkey.clone();

    // Nothing to do if we're clearing and the helper was never started.
    if hotkey.is_none() && guard.helper.is_none() {
        return;
    }

    if guard.helper.is_none() {
        if !spawn_and_bind(&app, &mut guard, &hotkey) {
            let _ = app.emit("mic-hotkey", false);
        }
        return;
    }

    // Helper already running: forward the combo over its stdin.
    let line = encode_combo(&hotkey);
    let helper = guard.helper.as_mut().expect("helper present");
    if writeln!(helper.stdin, "{line}")
        .and_then(|()| helper.stdin.flush())
        .is_err()
    {
        // Broken pipe: the child died between spawn and this write. Reap it and
        // respawn once for this combo (the dead child's reader will no-op via
        // its generation check, so there's no double cleanup).
        if let Some(mut dead) = guard.helper.take() {
            let _ = dead.child.kill();
            let _ = dead.child.wait();
        }
        if hotkey.is_some() {
            if !spawn_and_bind(&app, &mut guard, &hotkey) {
                let _ = app.emit("mic-hotkey", false);
            }
        } else {
            let _ = app.emit("mic-hotkey", false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rdev::Key;

    #[test]
    fn maps_common_codes() {
        assert_eq!(code_to_key("KeyM"), Some(Key::KeyM));
        assert_eq!(code_to_key("Digit0"), Some(Key::Num0));
        assert_eq!(code_to_key("F8"), Some(Key::F8));
        assert_eq!(code_to_key("Space"), Some(Key::Space));
        assert_eq!(code_to_key("Numpad5"), Some(Key::Kp5));
    }

    #[test]
    fn maps_extended_codes() {
        assert_eq!(code_to_key("NumpadAdd"), Some(Key::KpPlus));
        assert_eq!(code_to_key("NumpadDecimal"), Some(Key::KpDelete));
        assert_eq!(code_to_key("PrintScreen"), Some(Key::PrintScreen));
        assert_eq!(code_to_key("ScrollLock"), Some(Key::ScrollLock));
        assert_eq!(code_to_key("Pause"), Some(Key::Pause));
        assert_eq!(code_to_key("NumLock"), Some(Key::NumLock));
        assert_eq!(code_to_key("IntlBackslash"), Some(Key::IntlBackslash));
        // Numpad Enter is indistinguishable from Return via rdev on Windows, so
        // it is intentionally NOT mapped (would otherwise hijack main Enter).
        assert_eq!(code_to_key("NumpadEnter"), None);
    }

    #[test]
    fn unmapped_code_is_none() {
        assert_eq!(code_to_key("MediaPlayPause"), None);
        assert_eq!(code_to_key(""), None);
    }

    #[test]
    fn main_key_combo_held_only_when_pressed() {
        let c = MicHotkey {
            code: Some("KeyM".into()),
            ..Default::default()
        };
        let mut pressed = HashSet::new();
        assert!(!combo_is_held(&c, &pressed));
        pressed.insert(Key::KeyM);
        assert!(combo_is_held(&c, &pressed));
    }

    #[test]
    fn modifier_plus_key_requires_both() {
        let c = MicHotkey {
            ctrl: true,
            code: Some("KeyM".into()),
            ..Default::default()
        };
        let mut pressed = HashSet::new();
        pressed.insert(Key::KeyM);
        assert!(!combo_is_held(&c, &pressed)); // missing ctrl
        pressed.insert(Key::ControlRight);
        assert!(combo_is_held(&c, &pressed)); // either ctrl side counts
    }

    #[test]
    fn modifier_only_combo() {
        let c = MicHotkey {
            alt: true,
            code: None,
            ..Default::default()
        };
        let mut pressed = HashSet::new();
        assert!(!combo_is_held(&c, &pressed));
        // rdev reports right Alt as AltGr; it must still count as "alt".
        pressed.insert(Key::AltGr);
        assert!(combo_is_held(&c, &pressed));
    }

    fn decoded(line: &str) -> MicHotkey {
        decode_combo(line)
            .expect("valid line")
            .expect("not a clear")
    }

    #[test]
    fn encode_decode_round_trips_key_combo() {
        let c = Some(MicHotkey {
            ctrl: true,
            shift: false,
            alt: true,
            meta: false,
            code: Some("KeyM".into()),
        });
        assert_eq!(encode_combo(&c), "combo 1 0 1 0 KeyM");
        let back = decoded("combo 1 0 1 0 KeyM");
        assert!(back.ctrl && !back.shift && back.alt && !back.meta);
        assert_eq!(back.code.as_deref(), Some("KeyM"));
    }

    #[test]
    fn encode_decode_round_trips_modifier_only() {
        let c = Some(MicHotkey {
            alt: true,
            code: None,
            ..Default::default()
        });
        assert_eq!(encode_combo(&c), "combo 0 0 1 0 -");
        let back = decoded("combo 0 0 1 0 -");
        assert!(back.alt);
        assert_eq!(back.code, None);
    }

    #[test]
    fn encode_decode_none_clears() {
        assert_eq!(encode_combo(&None), "none");
        assert_eq!(decode_combo("none"), Ok(None));
        assert_eq!(decode_combo("  none  "), Ok(None));
    }

    #[test]
    fn decode_rejects_malformed_lines() {
        assert_eq!(decode_combo("bogus"), Err(()));
        assert_eq!(decode_combo("combo 1 0 1 KeyM"), Err(())); // too few fields
        assert_eq!(decode_combo("combo 1 0 1 0 KeyM extra"), Err(())); // trailing garbage
        assert_eq!(decode_combo("combo 2 0 0 0 KeyM"), Err(())); // bad bool
        assert_eq!(decode_combo(""), Err(()));
    }
}
