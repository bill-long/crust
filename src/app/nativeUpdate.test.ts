import { afterEach, describe, expect, it, vi } from "vitest";
import { endActiveCall } from "../features/room/call/rtc/endCall";
import { clearNotices } from "../stores/notices";
import { withPathname } from "../test/withPathname";
import {
	_resetNativeUpdateForTests,
	dismissFailedInstall,
	dismissNativeUpdate,
	failedInstallDismissError,
	failedInstallVersion,
	pendingUpdateVersion,
	restartError,
	restartForUpdate,
	restartingForUpdate,
	watchNativeUpdates,
} from "./nativeUpdate";

type Handler = (payload: unknown) => void;

/**
 * Stand in for the Tauri internals `listenTauri`/`invokeTauri` reach for, and
 * capture the handler registered for an event so a test can fire it.
 */
function installTauri(
	staged: string | null = null,
	// Runs inside the staged-version query, so a test can hold it open and act
	// while it is in flight.
	onQuery?: () => Promise<void>,
	failedInstall: string | null = null,
): {
	invoke: ReturnType<typeof vi.fn>;
	fire: (event: string, payload: unknown) => void;
} {
	const handlers = new Map<string, Handler>();
	let nextCallbackId = 0;
	const callbacks = new Map<number, Handler>();

	const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === "plugin:event|listen") {
			const { event, handler } = args as { event: string; handler: number };
			const cb = callbacks.get(handler);
			if (cb) handlers.set(event, cb);
			return 1;
		}
		if (cmd === "pending_update_version") {
			if (onQuery) await onQuery();
			return staged;
		}
		if (cmd === "pending_update_install_failure") return failedInstall;
		return undefined;
	});

	(window as { isTauri?: boolean }).isTauri = true;
	(
		window as {
			__TAURI_INTERNALS__?: unknown;
		}
	).__TAURI_INTERNALS__ = {
		invoke,
		transformCallback: (cb: Handler) => {
			nextCallbackId += 1;
			callbacks.set(nextCallbackId, cb);
			return nextCallbackId;
		},
	};

	return {
		invoke,
		fire: (event, payload) => handlers.get(event)?.({ payload }),
	};
}

vi.mock("../features/room/call/rtc/endCall", () => ({
	endActiveCall: vi.fn(async () => {}),
}));

describe("nativeUpdate", () => {
	afterEach(() => {
		(window as { isTauri?: boolean }).isTauri = undefined;
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
			undefined;
		_resetNativeUpdateForTests();
		vi.restoreAllMocks();
		// restoreAllMocks leaves a vi.mock() factory's call history intact, so
		// without this a later test sees earlier tests' calls.
		vi.clearAllMocks();
	});

	it("surfaces the version from a staged-update event", async () => {
		const { fire } = installTauri();
		await watchNativeUpdates();
		expect(pendingUpdateVersion()).toBeNull();

		fire("crust://update-ready", "0.1.1");
		expect(pendingUpdateVersion()).toBe("0.1.1");
	});

	it("dismissing clears the prompt without cancelling the update", async () => {
		const { fire, invoke } = installTauri();
		await watchNativeUpdates();
		fire("crust://update-ready", "0.1.1");

		dismissNativeUpdate();

		expect(pendingUpdateVersion()).toBeNull();
		// Dismissal is display-only: nothing is sent to the shell, so the staged
		// update still installs when the app exits.
		expect(invoke).not.toHaveBeenCalledWith(
			"restart_for_update",
			expect.anything(),
		);
	});

	it("restarting asks the shell to exit, which applies the update", async () => {
		const { invoke } = installTauri();
		await restartForUpdate();
		expect(invoke).toHaveBeenCalledWith("restart_for_update", undefined);
	});

	it("does nothing outside the native shell", async () => {
		// No isTauri, no internals: a plain browser tab.
		const unlisten = await watchNativeUpdates();
		await restartForUpdate();
		expect(pendingUpdateVersion()).toBeNull();
		expect(() => unlisten()).not.toThrow();
	});
	it("picks up an update staged before the webview mounted", async () => {
		// The shell checks during startup, so the download can finish before any
		// listener exists and the event is dropped; the mount-time query is the
		// only thing that surfaces it.
		installTauri("0.2.0");
		await watchNativeUpdates();
		expect(pendingUpdateVersion()).toBe("0.2.0");
	});

	it("surfaces and acknowledges an install attempt left on the old version", async () => {
		const { invoke } = installTauri(null, undefined, "0.2.4");

		await watchNativeUpdates();
		expect(failedInstallVersion()).toBe("0.2.4");

		dismissFailedInstall();
		expect(failedInstallVersion()).toBeNull();
		expect(invoke).toHaveBeenCalledWith(
			"dismiss_update_install_failure",
			undefined,
		);
	});

	it("restores the warning if its persisted marker cannot be cleared", async () => {
		const { invoke } = installTauri(null, undefined, "0.2.4");
		await watchNativeUpdates();
		invoke.mockRejectedValueOnce(new Error("read-only data directory"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		dismissFailedInstall();
		expect(failedInstallVersion()).toBeNull();
		await vi.waitFor(() => expect(failedInstallVersion()).toBe("0.2.4"));
		expect(failedInstallDismissError()).toMatch(/Couldn't dismiss/);
	});

	it("does not let a stale dismissal failure replace a newer warning", async () => {
		const { invoke } = installTauri(null, undefined, "0.2.4");
		await watchNativeUpdates();
		let rejectDismiss = (): void => {};
		const heldDismiss = new Promise<void>((_resolve, reject) => {
			rejectDismiss = () => reject(new Error("marker stayed locked"));
		});
		invoke.mockImplementation(async (cmd: string) => {
			if (cmd === "plugin:event|listen") return 1;
			if (cmd === "pending_update_version") return null;
			if (cmd === "pending_update_install_failure") return "0.2.5";
			if (cmd === "dismiss_update_install_failure") return heldDismiss;
			return undefined;
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		dismissFailedInstall();
		await watchNativeUpdates();
		expect(failedInstallVersion()).toBe("0.2.5");
		rejectDismiss();

		await vi.waitFor(() =>
			expect(console.error).toHaveBeenCalledWith(
				"dismissFailedInstall could not clear the install marker",
				expect.any(Error),
			),
		);
		expect(failedInstallVersion()).toBe("0.2.5");
		expect(failedInstallDismissError()).toBeNull();
	});

	it("does not let a late catch-up query overwrite a newer version", async () => {
		// The query answers for the state at the moment it was SENT. The shell's
		// re-check loop can stage a newer build and emit while it is in flight, and
		// applying the older answer would put a version on the card that is not the
		// one about to install.
		let queryStarted = (): void => {};
		const started = new Promise<void>((resolve) => {
			queryStarted = resolve;
		});
		let releaseQuery = (): void => {};
		const held = new Promise<void>((resolve) => {
			releaseQuery = resolve;
		});
		const { fire } = installTauri("0.1.1", async () => {
			queryStarted();
			await held;
		});

		const watching = watchNativeUpdates();
		// Parked inside the query, which means the listener is already registered.
		await started;
		fire("crust://update-ready", "0.1.2");
		expect(pendingUpdateVersion()).toBe("0.1.2");

		releaseQuery();
		await watching;
		expect(pendingUpdateVersion()).toBe("0.1.2");
	});

	it("stays silent in the overlay window", async () => {
		const { fire, invoke } = installTauri("0.2.0");
		let watched: Promise<unknown> | undefined;
		withPathname("/overlay", () => {
			watched = watchNativeUpdates();
		});
		await watched;
		fire("crust://update-ready", "0.2.0");
		// The overlay is a transparent click-through window over a game; a card
		// there would be undismissable at best.
		expect(pendingUpdateVersion()).toBeNull();
		expect(invoke).not.toHaveBeenCalled();
	});

	it("survives a failed subscription without an unhandled rejection", async () => {
		(window as { isTauri?: boolean }).isTauri = true;
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
			invoke: vi.fn().mockRejectedValue(new Error("ipc denied")),
			transformCallback: () => 1,
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		const unlisten = await watchNativeUpdates();
		expect(pendingUpdateVersion()).toBeNull();
		expect(() => unlisten()).not.toThrow();
	});
	it("keeps a working listener when the staged-version query fails", async () => {
		(window as { isTauri?: boolean }).isTauri = true;
		const invoke = vi.fn(async (cmd: string) => {
			if (cmd === "plugin:event|listen") return 1;
			if (cmd === "pending_update_version") throw new Error("boom");
			return undefined;
		});
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
			invoke,
			transformCallback: () => 1,
		};
		vi.spyOn(console, "error").mockImplementation(() => {});

		const unlisten = await watchNativeUpdates();

		// The listener is the primary channel and still covers anything staged
		// later this session, so a failed catch-up query must not tear it down.
		expect(invoke).not.toHaveBeenCalledWith(
			"plugin:event|unlisten",
			expect.anything(),
		);
		// And it is not leaked either: the caller gets the real unsubscribe.
		unlisten();
		expect(invoke).toHaveBeenCalledWith(
			"plugin:event|unlisten",
			expect.objectContaining({ event: "crust://update-ready" }),
		);
	});
	it("surfaces a failed restart on the card itself", async () => {
		// Not through a toast: NoticeToasts renders inside SyncGate, behind the
		// auth guard, while the card renders at the App root - so on the login
		// screen a notice would go nowhere while the card is on screen.
		(window as { isTauri?: boolean }).isTauri = true;
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
			invoke: vi.fn().mockRejectedValue(new Error("exit refused")),
			transformCallback: () => 1,
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		clearNotices();

		await restartForUpdate();

		expect(restartError()).toMatch(/Couldn't restart/);
		expect(restartingForUpdate()).toBe(false);
	});

	it("reports a missing IPC without dropping the user out of a call", async () => {
		// isTauri true but no internals - a state this shell has been in before.
		(window as { isTauri?: boolean }).isTauri = true;
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
			undefined;
		vi.spyOn(console, "error").mockImplementation(() => {});

		await restartForUpdate();

		expect(restartError()).toMatch(/Couldn't restart/);
		// Tearing the call down first would have cost the call for nothing.
		expect(vi.mocked(endActiveCall)).not.toHaveBeenCalled();
	});
	it("ends an active call before quitting, so the withdrawal lands", async () => {
		// Quitting kills the process: a call still joined at that moment leaves
		// other participants seeing this user until the membership expires, the
		// same failure logout was fixed for in #474.
		const { invoke } = installTauri();
		const order: string[] = [];
		vi.mocked(endActiveCall).mockImplementation(async () => {
			order.push("endActiveCall");
		});
		invoke.mockImplementation(async (cmd: string) => {
			order.push(cmd);
			return undefined;
		});

		await restartForUpdate();

		expect(order).toEqual(["endActiveCall", "restart_for_update"]);
	});

	it("refuses a second restart while one is in flight", async () => {
		// Ending a call can take up to endCall's 10s cap, during which the card
		// stays on screen; a second click would start another teardown and
		// another quit.
		const { invoke } = installTauri();
		let release: (() => void) | undefined;
		vi.mocked(endActiveCall).mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		const first = restartForUpdate();
		expect(restartingForUpdate()).toBe(true);
		await restartForUpdate();
		expect(invoke).not.toHaveBeenCalledWith("restart_for_update", undefined);

		release?.();
		await first;
		expect(invoke).toHaveBeenCalledWith("restart_for_update", undefined);
		expect(
			invoke.mock.calls.filter((c) => c[0] === "restart_for_update"),
		).toHaveLength(1);
	});
});
