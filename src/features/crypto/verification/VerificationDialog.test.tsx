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

/** Bytes standing in for VerificationRequest.generateQRCode(). */
const QR_BYTES = new Uint8ClampedArray(
	Array.from({ length: 120 }, (_, i) => (i * 37 + 128) % 256),
);

function makeHandle(initial: VerificationState = "idle") {
	const [state, setState] = createSignal<VerificationState>(initial);
	const [qrBytes, setQrBytes] = createSignal<Uint8ClampedArray | undefined>(
		undefined,
	);
	const handle = {
		state,
		emoji: () => undefined,
		qrBytes,
		error: () => "",
		isSelfVerification: () => true,
		otherUserId: () => "",
		requestSelfVerification: vi.fn(async () => {
			setState("requested");
		}),
		requestDeviceVerification: vi.fn(async () => {}),
		acceptIncoming: vi.fn(),
		startSas: vi.fn(async () => {}),
		confirmSas: vi.fn(async () => {}),
		rejectSas: vi.fn(),
		confirmQr: vi.fn(),
		rejectQr: vi.fn(),
		cancel: vi.fn(),
		reset: vi.fn(),
		setState,
		setQrBytes,
	};
	return handle as unknown as VerificationHandle & typeof handle;
}

/** Put the handle in the state where our QR code is on screen. */
function showingQr() {
	const handle = makeHandle();
	handle.setQrBytes(QR_BYTES);
	handle.setState("qr-showing");
	return handle;
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

describe("VerificationDialog QR views (#452)", () => {
	it("renders the QR code with an accessible name", () => {
		render(() => (
			<VerificationDialog verification={showingQr()} onClose={() => {}} />
		));
		const code = screen.getByRole("img", { name: "Verification QR code" });
		// A path with dark modules, not an empty frame.
		expect(code.querySelector("path")?.getAttribute("d")).toBeTruthy();
	});

	it("offers emoji as the way out of a code that cannot be scanned", () => {
		const handle = showingQr();
		render(() => (
			<VerificationDialog verification={handle} onClose={() => {}} />
		));
		fireEvent.click(
			screen.getByRole("button", { name: "Can't scan? Compare emoji" }),
		);
		expect(handle.startSas).toHaveBeenCalledTimes(1);
	});

	it("confirms the other side's scan", () => {
		const handle = makeHandle("qr-reciprocate");
		render(() => (
			<VerificationDialog verification={handle} onClose={() => {}} />
		));
		fireEvent.click(screen.getByRole("button", { name: "Yes" }));
		expect(handle.confirmQr).toHaveBeenCalledTimes(1);
	});

	it("rejects the other side's scan", () => {
		const handle = makeHandle("qr-reciprocate");
		render(() => (
			<VerificationDialog verification={handle} onClose={() => {}} />
		));
		fireEvent.click(screen.getByRole("button", { name: "No" }));
		expect(handle.rejectQr).toHaveBeenCalledTimes(1);
	});

	it("does not tell the user to accept a request they already accepted", () => {
		// `ready` means both sides are in; the dialog is picking a method.
		const handle = makeHandle("ready");
		render(() => (
			<VerificationDialog verification={handle} onClose={() => {}} />
		));
		expect(screen.getByText("Setting up verification")).toBeTruthy();
		expect(screen.queryByText(/accept the verification request/i)).toBeNull();
	});

	it("offers a way out while waiting on the other side to finish", () => {
		// Confirming a scan is fire-and-forget, so a lost `done` would
		// otherwise strand the user on this spinner with no exit.
		const handle = makeHandle("qr-confirmed");
		render(() => (
			<VerificationDialog verification={handle} onClose={() => {}} />
		));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(handle.cancel).toHaveBeenCalledTimes(1);
	});

	it("cancels rather than closing while a code is on screen", () => {
		const handle = showingQr();
		const onClose = vi.fn();
		render(() => (
			<VerificationDialog verification={handle} onClose={onClose} />
		));
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(handle.cancel).toHaveBeenCalledTimes(1);
		expect(onClose).not.toHaveBeenCalled();
	});
});
