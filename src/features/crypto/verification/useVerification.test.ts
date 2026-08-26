import { waitFor } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { VerificationPhase } from "matrix-js-sdk/lib/crypto-api";
import type {
	ShowQrCodeCallbacks,
	ShowSasCallbacks,
} from "matrix-js-sdk/lib/crypto-api/verification";
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVerification, type VerificationHandle } from "./useVerification";

// biome-ignore lint/complexity/noBannedTypes: minimal event-emitter stand-in
type Listener = Function;

/** Bare stand-in for the SDK's TypedEventEmitter: on / off / emit only. */
class FakeEmitter {
	private listeners = new Map<string, Set<Listener>>();

	on(event: string, fn: Listener): this {
		const set = this.listeners.get(event) ?? new Set();
		set.add(fn);
		this.listeners.set(event, set);
		return this;
	}

	off(event: string, fn: Listener): this {
		this.listeners.get(event)?.delete(fn);
		return this;
	}

	emit(event: string, ...args: unknown[]): void {
		for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
	}
}

class FakeVerifier extends FakeEmitter {
	verify = vi.fn(() => new Promise<void>(() => {}));
	cancel = vi.fn();
	getReciprocateQrCodeCallbacks = vi.fn((): ShowQrCodeCallbacks | null => null);
	getShowSasCallbacks = vi.fn((): ShowSasCallbacks | null => null);
}

const QR_BYTES = new Uint8ClampedArray([1, 2, 3, 200]);

class FakeRequest extends FakeEmitter {
	phase: VerificationPhase = VerificationPhase.Requested;
	isSelfVerification = true;
	otherUserId = "@alice:example.com";
	/** The verifier the SDK would have built for an incoming `start`. */
	incomingVerifier: FakeVerifier | null = null;
	sasVerifier = new FakeVerifier();

	otherPartySupportsMethod = vi.fn(() => true);
	generateQRCode = vi.fn(
		async (): Promise<Uint8ClampedArray | undefined> => QR_BYTES,
	);
	startVerification = vi.fn(async () => this.sasVerifier);
	accept = vi.fn(async () => {});
	cancel = vi.fn(async () => {});

	get pending(): boolean {
		return (
			this.phase !== VerificationPhase.Done &&
			this.phase !== VerificationPhase.Cancelled
		);
	}

	get verifier(): FakeVerifier | undefined {
		return this.phase === VerificationPhase.Started
			? (this.incomingVerifier ?? this.sasVerifier)
			: undefined;
	}

	/** Move to `phase` and fire the change event, as the SDK does. */
	transition(phase: VerificationPhase): void {
		this.phase = phase;
		this.emit("change");
	}
}

function makeClient(request: FakeRequest): MatrixClient {
	return {
		getCrypto: () => ({
			requestOwnUserVerification: async () => request,
			requestDeviceVerification: async () => request,
		}),
		getUserId: () => "@alice:example.com",
	} as unknown as MatrixClient;
}

const disposers: Array<() => void> = [];

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.restoreAllMocks();
});

/** Start a self-verification and leave the request in the Requested phase. */
async function startVerification(): Promise<{
	handle: VerificationHandle;
	request: FakeRequest;
}> {
	const request = new FakeRequest();
	const handle = createRoot((dispose) => {
		disposers.push(dispose);
		return useVerification(makeClient(request));
	});
	await handle.requestSelfVerification();
	return { handle, request };
}

describe("useVerification method selection (#452)", () => {
	it("shows a QR code when the other side can scan one", async () => {
		const { handle, request } = await startVerification();
		request.transition(VerificationPhase.Ready);

		await waitFor(() => expect(handle.state()).toBe("qr-showing"));
		expect(handle.qrBytes()).toBe(QR_BYTES);
		// The QR route must not also kick off an emoji exchange.
		expect(request.startVerification).not.toHaveBeenCalled();
	});

	it("falls back to emoji when the other side cannot scan", async () => {
		const { handle, request } = await startVerification();
		request.otherPartySupportsMethod.mockReturnValue(false);
		request.transition(VerificationPhase.Ready);

		await waitFor(() => expect(request.startVerification).toHaveBeenCalled());
		expect(request.generateQRCode).not.toHaveBeenCalled();
		expect(handle.state()).toBe("ready");
		expect(handle.qrBytes()).toBeUndefined();
	});

	it("falls back to emoji when the SDK cannot build a code", async () => {
		const { handle, request } = await startVerification();
		// Documented undefined: cross-signing keys are not available locally.
		request.generateQRCode.mockResolvedValue(undefined);
		request.transition(VerificationPhase.Ready);

		await waitFor(() => expect(request.startVerification).toHaveBeenCalled());
		expect(handle.state()).toBe("ready");
	});

	it("falls back to emoji when generating the code throws", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { handle, request } = await startVerification();
		request.generateQRCode.mockRejectedValue(
			new Error("generateQRCode(): other device is unknown"),
		);
		request.transition(VerificationPhase.Ready);

		await waitFor(() => expect(request.startVerification).toHaveBeenCalled());
		expect(handle.state()).toBe("ready");
	});

	it("keeps the QR code up when the Ready phase re-fires", async () => {
		const { handle, request } = await startVerification();
		request.transition(VerificationPhase.Ready);
		await waitFor(() => expect(handle.state()).toBe("qr-showing"));

		// Generating the code is itself a change event, and the SDK keeps
		// reporting Ready until a method starts. Re-running the choice would
		// blank the code the user is trying to scan.
		request.transition(VerificationPhase.Ready);
		await Promise.resolve();

		expect(handle.state()).toBe("qr-showing");
		expect(request.generateQRCode).toHaveBeenCalledTimes(1);
	});

	it("switches to emoji on request while the code is up", async () => {
		const { handle, request } = await startVerification();
		request.transition(VerificationPhase.Ready);
		await waitFor(() => expect(handle.state()).toBe("qr-showing"));

		await handle.startSas();

		expect(request.startVerification).toHaveBeenCalledWith("m.sas.v1");
		expect(handle.qrBytes()).toBeUndefined();
		expect(request.sasVerifier.verify).toHaveBeenCalled();
	});
});

describe("useVerification reciprocation (#452)", () => {
	/** Drive to the point where the other side has scanned our code. */
	async function reachReciprocate(): Promise<{
		handle: VerificationHandle;
		request: FakeRequest;
		verifier: FakeVerifier;
		callbacks: ShowQrCodeCallbacks;
	}> {
		const { handle, request } = await startVerification();
		request.transition(VerificationPhase.Ready);
		await waitFor(() => expect(handle.state()).toBe("qr-showing"));

		const verifier = new FakeVerifier();
		const callbacks = { confirm: vi.fn(), cancel: vi.fn() };
		verifier.verify.mockImplementation(() => {
			verifier.emit("show_reciprocate_qr", callbacks);
			return new Promise<void>(() => {});
		});
		request.incomingVerifier = verifier;
		request.transition(VerificationPhase.Started);

		await waitFor(() => expect(handle.state()).toBe("qr-reciprocate"));
		return { handle, request, verifier, callbacks };
	}

	it("prompts to confirm once the other side has scanned", async () => {
		const { handle, verifier } = await reachReciprocate();
		expect(verifier.verify).toHaveBeenCalled();
		// The code is gone from the UI once it has served its purpose.
		expect(handle.qrBytes()).toBeUndefined();
	});

	it("confirming tells the SDK and waits for the other side", async () => {
		const { handle, callbacks } = await reachReciprocate();
		handle.confirmQr();

		expect(callbacks.confirm).toHaveBeenCalled();
		expect(handle.state()).toBe("qr-confirmed");
	});

	it("completes when the other side reports done", async () => {
		const { handle, request } = await reachReciprocate();
		handle.confirmQr();
		request.transition(VerificationPhase.Done);

		expect(handle.state()).toBe("done");
	});

	it("prompts even when the SDK never emits the reciprocate event", async () => {
		// A rust QR verifier emits ShowReciprocateQr only from inside
		// verify(), and only if its callbacks are already populated. The
		// verifier and the request register separate rust change callbacks,
		// so the request's can land first and verify() emits nothing - with
		// no later event to make up for it.
		const { handle, request } = await startVerification();
		request.transition(VerificationPhase.Ready);
		await waitFor(() => expect(handle.state()).toBe("qr-showing"));

		const verifier = new FakeVerifier();
		const callbacks = { confirm: vi.fn(), cancel: vi.fn() };
		verifier.getReciprocateQrCodeCallbacks.mockReturnValue(callbacks);
		request.incomingVerifier = verifier;
		request.transition(VerificationPhase.Started);

		await waitFor(() => expect(handle.state()).toBe("qr-reciprocate"));
		handle.confirmQr();
		expect(callbacks.confirm).toHaveBeenCalled();
	});

	it("shows the emoji when the SDK never emits the SAS event", async () => {
		const { handle, request } = await startVerification();
		request.otherPartySupportsMethod.mockReturnValue(false);
		request.transition(VerificationPhase.Ready);
		await waitFor(() => expect(request.startVerification).toHaveBeenCalled());

		request.sasVerifier.getShowSasCallbacks.mockReturnValue({
			sas: { emoji: [["A", "a"]] },
			confirm: vi.fn(async () => {}),
			mismatch: vi.fn(),
			cancel: vi.fn(),
		} as never);
		request.transition(VerificationPhase.Started);

		await waitFor(() => expect(handle.state()).toBe("sas-showing"));
	});

	it("never leaves a spent code under an instruction to scan it", async () => {
		// The QR view has no empty state, so clearing the bytes without
		// leaving qr-showing blanks a 256px box under the "Scan this code"
		// heading - a dead end and a layout shift.
		const { handle, request } = await startVerification();
		request.transition(VerificationPhase.Ready);
		await waitFor(() => expect(handle.state()).toBe("qr-showing"));

		// A verifier holding nothing yet: the SDK has started a method but
		// has not told us which.
		request.incomingVerifier = new FakeVerifier();
		request.transition(VerificationPhase.Started);

		expect(handle.state()).not.toBe("qr-showing");
		expect(handle.qrBytes()).toBeUndefined();
	});

	it("rejecting cancels the verification", async () => {
		const { handle, callbacks } = await reachReciprocate();
		handle.rejectQr();

		expect(callbacks.cancel).toHaveBeenCalled();
		expect(handle.state()).toBe("cancelled");
	});

	it("takes down the confirm prompt when the SDK swaps the verifier under it", async () => {
		const { handle, request, callbacks } = await reachReciprocate();

		// The SDK replaces the QR verifier with a SAS one after the scan.
		// ShowSas is several round-trips away, so this verifier holds
		// nothing yet - and the confirm prompt must not survive the wait:
		// its Yes calls callbacks that went with the old verifier, and its
		// No would cancel the emoji exchange that is now the live flow.
		request.incomingVerifier = new FakeVerifier();
		request.transition(VerificationPhase.Started);

		expect(handle.state()).not.toBe("qr-reciprocate");
		handle.confirmQr();
		expect(callbacks.confirm).not.toHaveBeenCalled();
	});

	it("binds a verifier the other side started for emoji instead", async () => {
		const { handle, request } = await startVerification();
		request.transition(VerificationPhase.Ready);
		await waitFor(() => expect(handle.state()).toBe("qr-showing"));

		// They ignored the code and picked emoji: the SDK swaps our QR
		// verifier for a SAS one, and nothing we called drives it.
		const verifier = new FakeVerifier();
		const sas = {
			sas: { emoji: [["A", "a"]] },
			confirm: vi.fn(async () => {}),
			mismatch: vi.fn(),
			cancel: vi.fn(),
		};
		verifier.verify.mockImplementation(() => {
			verifier.emit("show_sas", sas);
			return new Promise<void>(() => {});
		});
		request.incomingVerifier = verifier;
		request.transition(VerificationPhase.Started);

		await waitFor(() => expect(handle.state()).toBe("sas-showing"));
		expect(handle.emoji()).toEqual([["A", "a"]]);
		expect(handle.qrBytes()).toBeUndefined();
	});
	it("ignores the code if a method started while it was being generated", async () => {
		const { handle, request } = await startVerification();
		// Hold the code back so the other side gets in first. Without the
		// post-await guard the resolved bytes would replace the emoji view
		// the other side just put up.
		let release: (bytes: Uint8ClampedArray | undefined) => void = () => {};
		request.generateQRCode.mockReturnValue(
			new Promise<Uint8ClampedArray | undefined>((resolve) => {
				release = resolve;
			}),
		);
		request.transition(VerificationPhase.Ready);
		await waitFor(() => expect(request.generateQRCode).toHaveBeenCalled());

		const verifier = new FakeVerifier();
		const sas = {
			sas: { emoji: [["A", "a"]] },
			confirm: vi.fn(async () => {}),
			mismatch: vi.fn(),
			cancel: vi.fn(),
		};
		verifier.verify.mockImplementation(() => {
			verifier.emit("show_sas", sas);
			return new Promise<void>(() => {});
		});
		request.incomingVerifier = verifier;
		request.transition(VerificationPhase.Started);
		await waitFor(() => expect(handle.state()).toBe("sas-showing"));

		release(QR_BYTES);
		await Promise.resolve();
		await Promise.resolve();

		expect(handle.state()).toBe("sas-showing");
		expect(handle.qrBytes()).toBeUndefined();
	});
});

describe("useVerification teardown (#452)", () => {
	it("survives the dropped verifier failing when the SDK swaps QR for emoji", async () => {
		const { handle, request } = await startVerification();
		request.transition(VerificationPhase.Ready);
		await waitFor(() => expect(handle.state()).toBe("qr-showing"));

		// A QR verifier whose verify() we can reject on demand. That
		// rejection is how an abandoned rust verification reports itself:
		// the rust verifiers never emit VerifierEvent.Cancel, they reject
		// the promise verify() returned.
		const qrVerifier = new FakeVerifier();
		const callbacks = { confirm: vi.fn(), cancel: vi.fn() };
		let failQr: (e: Error) => void = () => {};
		qrVerifier.verify.mockImplementation(() => {
			qrVerifier.emit("show_reciprocate_qr", callbacks);
			return new Promise<void>((_resolve, reject) => {
				failQr = reject;
			});
		});
		request.incomingVerifier = qrVerifier;
		request.transition(VerificationPhase.Started);
		await waitFor(() => expect(handle.state()).toBe("qr-reciprocate"));

		// Both sides raced: the SDK replaces the QR verifier with a SAS one
		// and cancels the abandoned QR verification.
		const sasVerifier = new FakeVerifier();
		const sas = {
			sas: { emoji: [["A", "a"]] },
			confirm: vi.fn(async () => {}),
			mismatch: vi.fn(),
			cancel: vi.fn(),
		};
		sasVerifier.verify.mockImplementation(() => {
			sasVerifier.emit("show_sas", sas);
			return new Promise<void>(() => {});
		});
		request.incomingVerifier = sasVerifier;
		request.transition(VerificationPhase.Started);
		await waitFor(() => expect(handle.state()).toBe("sas-showing"));

		failQr(new Error("Cancelled by us with code m.user"));
		await Promise.resolve();
		await Promise.resolve();

		// The emoji exchange the user is looking at must survive the
		// abandoned QR verification's failure.
		expect(handle.state()).toBe("sas-showing");
	});

	it("stops listening to a verifier it dropped", async () => {
		const { handle, request } = await startVerification();
		request.transition(VerificationPhase.Ready);
		await waitFor(() => expect(handle.state()).toBe("qr-showing"));

		const verifier = new FakeVerifier();
		request.incomingVerifier = verifier;
		request.transition(VerificationPhase.Started);
		handle.cancel();

		expect(handle.state()).toBe("cancelled");
		verifier.emit("show_sas", {
			sas: { emoji: [["A", "a"]] },
			confirm: vi.fn(),
			mismatch: vi.fn(),
			cancel: vi.fn(),
		});
		verifier.emit("show_reciprocate_qr", { confirm: vi.fn(), cancel: vi.fn() });
		expect(handle.state()).toBe("cancelled");
	});

	it("clears the code when the request is reset", async () => {
		const { handle, request } = await startVerification();
		request.transition(VerificationPhase.Ready);
		await waitFor(() => expect(handle.qrBytes()).toBe(QR_BYTES));

		handle.reset();

		expect(handle.state()).toBe("idle");
		expect(handle.qrBytes()).toBeUndefined();
	});
});
