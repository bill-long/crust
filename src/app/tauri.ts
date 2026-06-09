/**
 * Minimal accessor for Tauri's `invoke` when running inside the desktop shell.
 *
 * Tauri always injects `window.__TAURI_INTERNALS__.invoke` into the webviews it
 * controls (independent of `withGlobalTauri`); `window.__TAURI__.core.invoke` is
 * the higher-level alias that only exists when `withGlobalTauri` is enabled. We
 * reach these globals rather than adding the `@tauri-apps/api` package as a web
 * dependency — the web build must stay free of Tauri imports, keeping the
 * desktop integration to a single thin seam.
 *
 * All callers must gate on `isNativeShell()` first; `invokeTauri` resolves to
 * `undefined` (rather than throwing) when the global is absent so a stray call
 * in a plain browser is a harmless no-op.
 */

type InvokeFn = (
	cmd: string,
	args?: Record<string, unknown>,
) => Promise<unknown>;

type TransformCallbackFn = (
	cb: (payload: unknown) => void,
	once?: boolean,
) => number;

function getInternals(): {
	invoke?: InvokeFn;
	transformCallback?: TransformCallbackFn;
} | null {
	const i = (
		window as {
			__TAURI_INTERNALS__?: {
				invoke?: InvokeFn;
				transformCallback?: TransformCallbackFn;
			};
		}
	).__TAURI_INTERNALS__;
	return i ?? null;
}

function getInvoke(): InvokeFn | null {
	const internals = getInternals()?.invoke;
	if (typeof internals === "function") return internals;
	const core = (window as { __TAURI__?: { core?: { invoke?: InvokeFn } } })
		.__TAURI__?.core?.invoke;
	return typeof core === "function" ? core : null;
}

/** Invoke a Tauri command, or resolve `undefined` when not in the native shell. */
export async function invokeTauri<T = unknown>(
	cmd: string,
	args?: Record<string, unknown>,
): Promise<T | undefined> {
	const invoke = getInvoke();
	if (!invoke) return undefined;
	return (await invoke(cmd, args)) as T;
}

/** Unsubscribe a Tauri event listener. */
export type UnlistenTauri = () => void;

/**
 * Subscribe to a Tauri event emitted from Rust (e.g. `app.emit`). Resolves to an
 * unsubscribe function. Resolves to a no-op unlisten in a plain browser, so
 * callers can use it unguarded after an `isNativeShell()` check.
 *
 * Implemented against `window.__TAURI_INTERNALS__` (always injected) via the
 * core event plugin, rather than the higher-level `window.__TAURI__.event` —
 * the latter only exists with `withGlobalTauri` and has proven unreliable in
 * this shell (its `core.invoke` alias was absent), so we use the same low-level
 * seam as `invokeTauri`.
 */
export async function listenTauri<T>(
	event: string,
	handler: (payload: T) => void,
): Promise<UnlistenTauri> {
	const internals = getInternals();
	const invoke = internals?.invoke;
	const transformCallback = internals?.transformCallback;
	if (typeof invoke !== "function" || typeof transformCallback !== "function") {
		return () => {};
	}
	// Mirrors @tauri-apps/api/event: register a callback id, then ask the core
	// event plugin to route `event` (from any window) to it. The IPC delivers a
	// full event object; we forward only the payload.
	const handlerId = transformCallback((raw: unknown) => {
		handler((raw as { payload: T }).payload);
	});
	const eventId = (await invoke("plugin:event|listen", {
		event,
		target: { kind: "Any" },
		handler: handlerId,
	})) as number;
	return () => {
		void invoke("plugin:event|unlisten", { event, eventId });
	};
}
