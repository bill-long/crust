import type { MatrixClient } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { uia401 } from "../../test/uiaFixtures";
import { createUiaDialogFlow, type UiaDialogFlow } from "./uiaDialogFlow";

const PASSWORD_FLOW = [["m.login.password"]];

/**
 * Client stub for the flow underneath: `probe` answers the preflight's
 * empty signing-key upload, and nothing else is reached.
 */
function fakeClient(probe: () => Promise<unknown>): MatrixClient {
	return {
		getUserId: () => "@test:example.com",
		getAuthMetadata: async () => {
			throw new Error("no oauth metadata");
		},
		http: { authedRequest: probe },
	} as unknown as MatrixClient;
}

/**
 * Build a flow inside its own reactive root, handing back the disposer so
 * a test can unmount the "dialog" the way `onCleanup` would.
 */
function withFlow(probe: () => Promise<unknown> = async () => ({})): {
	uia: UiaDialogFlow;
	dispose: () => void;
} {
	let uia!: UiaDialogFlow;
	const dispose = createRoot((d) => {
		uia = createUiaDialogFlow(fakeClient(probe));
		return d;
	});
	return { uia, dispose };
}

/** Resolve once the flow is showing a prompt (or fail the test). */
async function awaitPrompt(uia: UiaDialogFlow): Promise<void> {
	for (let i = 0; i < 50 && !uia.flow.prompt(); i++) {
		await Promise.resolve();
	}
	expect(uia.flow.prompt()).toBeTruthy();
}

describe("createUiaDialogFlow outcomes", () => {
	it("reports a completed operation as ok, carrying its value", async () => {
		const { uia, dispose } = withFlow();
		const done = await uia.run(async () => "revoked");
		expect(done).toEqual({ status: "ok", value: "revoked" });
		dispose();
	});

	it("reports a thrown failure as failed, with the error intact", async () => {
		const { uia, dispose } = withFlow();
		const boom = new Error("server said no");
		const done = await uia.run(async () => {
			throw boom;
		});
		expect(done).toEqual({ status: "failed", error: boom });
		dispose();
	});

	it("reports a cancelled identity prompt as cancelled, not as a failure", async () => {
		const { uia, dispose } = withFlow(async () => {
			throw uia401("s", PASSWORD_FLOW);
		});
		const done = uia.preflight();
		await awaitPrompt(uia);
		uia.flow.cancel();
		expect(await done).toEqual({ status: "cancelled" });
		dispose();
	});

	it("refuses to run both halves at once rather than losing the phase", async () => {
		const { uia, dispose } = withFlow();
		let finish!: () => void;
		const running = uia.run(() => new Promise<void>((r) => (finish = r)));
		// Overlapping them would let the first to settle clear the shared
		// phase while the other is still in flight, and dismiss would then
		// close over a live destructive operation. Fail loudly instead.
		await expect(uia.preflight()).rejects.toThrow(/already in flight/);
		finish();
		expect(await running).toEqual({ status: "ok", value: undefined });
		dispose();
	});

	it("reports a preflight the server answered without a challenge as ok", async () => {
		const { uia, dispose } = withFlow();
		expect(await uia.preflight()).toEqual({ status: "ok", value: undefined });
		dispose();
	});
});

describe("createUiaDialogFlow disposal", () => {
	it("is not disposed while the dialog is mounted", () => {
		const { uia, dispose } = withFlow();
		expect(uia.disposed()).toBe(false);
		dispose();
	});

	it("aborts a pending prompt on unmount so the operation settles", async () => {
		const { uia, dispose } = withFlow(async () => {
			throw uia401("s", PASSWORD_FLOW);
		});
		const done = uia.preflight();
		await awaitPrompt(uia);
		dispose();
		// The whole point: an operation suspended on a prompt nobody can
		// answer any more must settle rather than hang forever.
		expect(await done).toEqual({ status: "cancelled" });
		expect(uia.disposed()).toBe(true);
	});

	it("still reports a failure that lands after unmount", async () => {
		const { uia, dispose } = withFlow();
		const boom = new Error("late");
		let reject!: (e: unknown) => void;
		const done = uia.run(() => new Promise((_, r) => (reject = r)));
		dispose();
		reject(boom);
		// The dialog is gone, but its cleanup obligations (dropping a stale
		// secret-storage cache) still depend on knowing this failed.
		expect(await done).toEqual({ status: "failed", error: boom });
		expect(uia.disposed()).toBe(true);
	});
});

describe("createUiaDialogFlow dismiss", () => {
	it("closes when nothing is in flight", () => {
		const { uia, dispose } = withFlow();
		const close = vi.fn();
		uia.dismiss(close);
		expect(close).toHaveBeenCalledOnce();
		dispose();
	});

	it("cancels a pending prompt and leaves the dialog open", async () => {
		const { uia, dispose } = withFlow(async () => {
			throw uia401("s", PASSWORD_FLOW);
		});
		const done = uia.preflight();
		await awaitPrompt(uia);
		const close = vi.fn();
		uia.dismiss(close);
		// The dialog stays: the cancel surfaces as an outcome, and each
		// dialog decides for itself whether that steps back or closes.
		expect(close).not.toHaveBeenCalled();
		expect(await done).toEqual({ status: "cancelled" });
		dispose();
	});

	it("closes out of a hung preflight probe, aborting it", async () => {
		// A probe that only answers once the test says so - standing in for
		// the server that never replies and would otherwise trap the user.
		let challenge!: () => void;
		const { uia, dispose } = withFlow(
			() =>
				new Promise((_, reject) => {
					challenge = () => reject(uia401("s", PASSWORD_FLOW));
				}),
		);
		const done = uia.preflight();
		await Promise.resolve();
		const close = vi.fn();
		uia.dismiss(close);
		expect(close).toHaveBeenCalledOnce();

		// Closing must also ABORT the flow, not just leave the probe
		// running: when the challenge finally lands, its prompt has nobody
		// to answer it, so it must reject rather than raise a prompt into a
		// dialog that is gone.
		challenge();
		expect(await done).toEqual({ status: "cancelled" });
		expect(uia.flow.prompt()).toBeNull();
		dispose();
	});

	it("refuses to close while the operation is in flight", async () => {
		const { uia, dispose } = withFlow();
		let finish!: () => void;
		const done = uia.run(() => new Promise<void>((r) => (finish = r)));
		const close = vi.fn();
		uia.dismiss(close);
		expect(close).not.toHaveBeenCalled();
		finish();
		await done;
		dispose();
	});

	it("closes again once the operation has settled", async () => {
		const { uia, dispose } = withFlow();
		await uia.run(async () => {
			throw new Error("failed");
		});
		const close = vi.fn();
		uia.dismiss(close);
		// The phase is cleared in a `finally`, so a settled operation never
		// leaves the dialog undismissable - the drift #545 was fixing.
		expect(close).toHaveBeenCalledOnce();
		dispose();
	});
});
