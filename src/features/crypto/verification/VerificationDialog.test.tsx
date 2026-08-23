import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { RecoveryKeyCancelledError } from "../../../client/recoveryKeyCancelled";
import type { VerificationHandle, VerificationState } from "./useVerification";
import { VerificationDialog } from "./VerificationDialog";

function makeHandle(initial: VerificationState = "idle") {
	const [state, setState] = createSignal<VerificationState>(initial);
	const handle = {
		state,
		emoji: () => undefined,
		error: () => "",
		isSelfVerification: () => true,
		otherUserId: () => "",
		requestSelfVerification: vi.fn(async () => {
			setState("requested");
		}),
		requestDeviceVerification: vi.fn(async () => {}),
		acceptIncoming: vi.fn(),
		confirmSas: vi.fn(async () => {}),
		rejectSas: vi.fn(),
		cancel: vi.fn(),
		reset: vi.fn(),
		setState,
	};
	return handle as unknown as VerificationHandle & typeof handle;
}

afterEach(() => {
	cleanup();
});

describe("VerificationDialog self-verification entry", () => {
	it("opens on a choice between another session and the recovery key when idle", () => {
		const handle = makeHandle();
		render(() => (
			<VerificationDialog
				verification={handle}
				onClose={() => {}}
				verifyWithRecoveryKey={async () => {}}
			/>
		));
		expect(screen.getByText("Verify this session")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Verify with another session" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Use recovery key" }),
		).toBeTruthy();
	});

	it("hides the recovery-key option when the caller does not offer it", () => {
		render(() => (
			<VerificationDialog verification={makeHandle()} onClose={() => {}} />
		));
		expect(
			screen.queryByRole("button", { name: "Use recovery key" }),
		).toBeNull();
	});

	it("starts the SAS request from the choice", () => {
		const handle = makeHandle();
		render(() => (
			<VerificationDialog
				verification={handle}
				onClose={() => {}}
				verifyWithRecoveryKey={async () => {}}
			/>
		));
		fireEvent.click(
			screen.getByRole("button", { name: "Verify with another session" }),
		);
		expect(handle.requestSelfVerification).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Waiting for the other device")).toBeTruthy();
	});

	it("runs the recovery-key route and reports completion", async () => {
		let resolve: () => void = () => {};
		const run = vi.fn(
			() =>
				new Promise<void>((r) => {
					resolve = r;
				}),
		);
		render(() => (
			<VerificationDialog
				verification={makeHandle()}
				onClose={() => {}}
				verifyWithRecoveryKey={run}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Use recovery key" }));
		expect(run).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Verifying with your recovery key")).toBeTruthy();
		resolve();
		expect(await screen.findByText("Verification complete")).toBeTruthy();
	});

	it("returns to the choice when the recovery-key prompt is dismissed", async () => {
		render(() => (
			<VerificationDialog
				verification={makeHandle()}
				onClose={() => {}}
				verifyWithRecoveryKey={async () => {
					throw new RecoveryKeyCancelledError();
				}}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Use recovery key" }));
		expect(
			await screen.findByRole("button", { name: "Use recovery key" }),
		).toBeTruthy();
		expect(screen.queryByText("Verification failed")).toBeNull();
	});

	it("shows a real recovery-key failure with a retry", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		render(() => (
			<VerificationDialog
				verification={makeHandle()}
				onClose={() => {}}
				verifyWithRecoveryKey={async () => {
					throw new Error("importCrossSigningKeys failed to import the keys");
				}}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Use recovery key" }));
		expect(await screen.findByText("Verification failed")).toBeTruthy();
		expect(
			screen.getByText("importCrossSigningKeys failed to import the keys"),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(
			screen.getByRole("button", { name: "Use recovery key" }),
		).toBeTruthy();
		consoleError.mockRestore();
	});

	it("lets an incoming SAS accepted mid-recovery take over the view", () => {
		// The other session can start verifying this one while the recovery
		// prompt is open; the toast binds the handle, and the emoji must show
		// rather than stay hidden behind the recovery spinner.
		const handle = makeHandle();
		render(() => (
			<VerificationDialog
				verification={handle}
				onClose={() => {}}
				verifyWithRecoveryKey={() => new Promise(() => {})}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Use recovery key" }));
		expect(screen.getByText("Verifying with your recovery key")).toBeTruthy();
		handle.setState("sas-showing");
		expect(screen.getByText("Compare emoji")).toBeTruthy();
		expect(screen.queryByText("Verifying with your recovery key")).toBeNull();
	});

	it("still closes a finished SAS that took over mid-recovery", () => {
		// The recovery import may be stuck behind an unanswered prompt; the
		// SAS that completed in the meantime must not be held hostage by it.
		const handle = makeHandle();
		const onClose = vi.fn();
		render(() => (
			<VerificationDialog
				verification={handle}
				onClose={onClose}
				verifyWithRecoveryKey={() => new Promise(() => {})}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Use recovery key" }));
		handle.setState("done");
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(handle.reset).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("does not close, nor cancel the SAS handle, while the recovery route is in flight", () => {
		const handle = makeHandle();
		const onClose = vi.fn();
		render(() => (
			<VerificationDialog
				verification={handle}
				onClose={onClose}
				verifyWithRecoveryKey={() => new Promise(() => {})}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Use recovery key" }));
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
		expect(handle.cancel).not.toHaveBeenCalled();
	});
});
