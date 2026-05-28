import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRtcE2EEContext, type RtcE2EEContext } from "./rtcE2EEBridge";

type Listener = (...args: unknown[]) => void;

// Fake BaseKeyProvider — captures `onSetEncryptionKey` calls so tests
// can assert the key the bridge handed to LiveKit. Real livekit-client
// makes `onSetEncryptionKey` protected; the bridge subclass exposes it
// via `setMatrixKey`, so we just need a class the bridge can extend.
class FakeBaseKeyProvider {
	calls: Array<{
		key: CryptoKey;
		participantIdentity?: string;
		keyIndex?: number;
	}> = [];
	protected onSetEncryptionKey(
		key: CryptoKey,
		participantIdentity?: string,
		keyIndex?: number,
	): void {
		this.calls.push({ key, participantIdentity, keyIndex });
	}
}

const lkMock = {
	BaseKeyProvider: FakeBaseKeyProvider,
} as unknown as typeof import("livekit-client");

const loadLivekit = async (): Promise<typeof import("livekit-client")> =>
	lkMock;

interface FakeSession {
	on: ReturnType<typeof vi.fn>;
	off: ReturnType<typeof vi.fn>;
	emit: (event: string, ...args: unknown[]) => void;
	reemitEncryptionKeys: ReturnType<typeof vi.fn>;
}

const createFakeSession = (): FakeSession => {
	const listeners = new Map<string, Set<Listener>>();
	const session: FakeSession = {
		on: vi.fn((event: string, cb: Listener) => {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(cb);
		}),
		off: vi.fn((event: string, cb: Listener) => {
			listeners.get(event)?.delete(cb);
		}),
		emit: (event: string, ...args: unknown[]) => {
			for (const cb of listeners.get(event) ?? []) cb(...args);
		},
		reemitEncryptionKeys: vi.fn(),
	};
	return session;
};

let importKeySpy: ReturnType<typeof vi.spyOn>;
let workerTerminate: ReturnType<typeof vi.fn>;
let workerCount = 0;

const fakeWorker = (): Worker => {
	// One terminate spy per Worker instance is fine for assertions that
	// only count the most recently created worker; tests needing
	// per-binding granularity should track their own spies via the
	// `createWorkerWithSpy` helper below.
	workerTerminate = vi.fn();
	workerCount++;
	return {
		terminate: workerTerminate,
		postMessage: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
		onerror: null,
		onmessage: null,
		onmessageerror: null,
	} as unknown as Worker;
};

const newCtx = async (): Promise<RtcE2EEContext> =>
	createRtcE2EEContext({ loadLivekit, createWorker: fakeWorker });

const bindKp = (
	ctx: RtcE2EEContext,
): { kp: FakeBaseKeyProvider; release: () => void } => {
	const b = ctx.bindRoom();
	return {
		kp: b.e2eeOptions.keyProvider as unknown as FakeBaseKeyProvider,
		release: b.release,
	};
};

const flush = async (): Promise<void> => {
	// importKey is async; flush a few microtask rounds so the queue's
	// then-chain settles before assertions.
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
	workerCount = 0;
	// Stub crypto.subtle.importKey so the bridge tests don't depend on
	// the host WebCrypto implementation. Returns a sentinel CryptoKey
	// per call so per-event ordering assertions stay distinct.
	importKeySpy = vi
		.spyOn(crypto.subtle, "importKey")
		.mockImplementation(async (...args: unknown[]) => {
			const keyBytes = args[1] as ArrayBuffer;
			// Tag the fake CryptoKey with the input byte to make ordering
			// regressions detectable.
			return {
				__marker: new Uint8Array(keyBytes)[0],
			} as unknown as CryptoKey;
		});
});

afterEach(() => {
	// Restore so a `mockImplementationOnce` queue from one test can't
	// leak into the next — `vi.spyOn` returns the same spy when a method
	// is already spied, and per-test `beforeEach` re-spying does NOT
	// clear pending one-off impls.
	vi.restoreAllMocks();
});

describe("rtcE2EEBridge", () => {
	it("bindRoom returns fresh keyProvider+worker per binding", async () => {
		const ctx = await newCtx();
		const b1 = ctx.bindRoom();
		const b2 = ctx.bindRoom();
		expect(b1.e2eeOptions.keyProvider).toBeInstanceOf(FakeBaseKeyProvider);
		expect(b2.e2eeOptions.keyProvider).toBeInstanceOf(FakeBaseKeyProvider);
		expect(b1.e2eeOptions.keyProvider).not.toBe(b2.e2eeOptions.keyProvider);
		expect(b1.e2eeOptions.worker).not.toBe(b2.e2eeOptions.worker);
		expect(workerCount).toBe(2);
		b1.release();
		b2.release();
		ctx.dispose();
	});

	it("attach subscribes to EncryptionKeyChanged and detach unsubscribes", async () => {
		const ctx = await newCtx();
		const session = createFakeSession();
		const detach = ctx.attach(session as never, () => true);
		expect(session.on).toHaveBeenCalledWith(
			MatrixRTCSessionEvent.EncryptionKeyChanged,
			expect.any(Function),
		);
		detach();
		expect(session.off).toHaveBeenCalledWith(
			MatrixRTCSessionEvent.EncryptionKeyChanged,
			expect.any(Function),
		);
		ctx.dispose();
	});

	it("EncryptionKeyChanged drives onSetEncryptionKey with the right identity and index", async () => {
		const ctx = await newCtx();
		const session = createFakeSession();
		ctx.attach(session as never, () => true);
		const { kp } = bindKp(ctx);
		const keyBytes = new Uint8Array([42, 1, 2, 3]);
		session.emit(
			MatrixRTCSessionEvent.EncryptionKeyChanged,
			keyBytes,
			7,
			{},
			"backend-id-1",
		);
		await flush();
		expect(kp.calls).toHaveLength(1);
		expect(kp.calls[0].participantIdentity).toBe("backend-id-1");
		expect(kp.calls[0].keyIndex).toBe(7);
		// importKey was called with the key bytes copied into a fresh buffer.
		expect(importKeySpy).toHaveBeenCalledWith(
			"raw",
			expect.any(ArrayBuffer),
			"HKDF",
			false,
			["deriveBits", "deriveKey"],
		);
		ctx.dispose();
	});

	it("serialises key processing so out-of-order importKey resolutions don't reorder keys", async () => {
		// Make importKey resolve in REVERSE order: first call gets a
		// long delay, second call resolves immediately. Without the
		// promise queue, the keyProvider would see index 5 then 4.
		let resolve1: ((k: CryptoKey) => void) | undefined;
		importKeySpy.mockReset();
		importKeySpy.mockImplementationOnce(
			() =>
				new Promise<CryptoKey>((res) => {
					resolve1 = res as (k: CryptoKey) => void;
				}),
		);
		importKeySpy.mockImplementationOnce(
			async () => ({ __marker: 2 }) as unknown as CryptoKey,
		);

		const ctx = await newCtx();
		const session = createFakeSession();
		ctx.attach(session as never, () => true);
		const { kp } = bindKp(ctx);
		session.emit(
			MatrixRTCSessionEvent.EncryptionKeyChanged,
			new Uint8Array([1]),
			4,
			{},
			"id",
		);
		session.emit(
			MatrixRTCSessionEvent.EncryptionKeyChanged,
			new Uint8Array([2]),
			5,
			{},
			"id",
		);
		await flush();
		// Index 5 must NOT have been delivered before index 4.
		expect(kp.calls).toHaveLength(0);
		resolve1?.({ __marker: 1 } as unknown as CryptoKey);
		await flush();
		await flush();
		await flush();
		expect(kp.calls.map((c) => c.keyIndex)).toEqual([4, 5]);
		ctx.dispose();
	});

	it("late EncryptionKeyChanged after isLive flips false bails before onSetEncryptionKey", async () => {
		const ctx = await newCtx();
		const session = createFakeSession();
		let live = true;
		ctx.attach(session as never, () => live);
		const { kp } = bindKp(ctx);
		// Block the first importKey so we can flip `live` mid-await.
		let resolveImport: ((k: CryptoKey) => void) | undefined;
		importKeySpy.mockReset();
		importKeySpy.mockImplementationOnce(
			() =>
				new Promise<CryptoKey>((res) => {
					resolveImport = res as (k: CryptoKey) => void;
				}),
		);
		session.emit(
			MatrixRTCSessionEvent.EncryptionKeyChanged,
			new Uint8Array([9]),
			1,
			{},
			"id",
		);
		// Flip live false while the importKey await is in flight.
		live = false;
		resolveImport?.({ __marker: 9 } as unknown as CryptoKey);
		await flush();
		expect(kp.calls).toHaveLength(0);
		ctx.dispose();
	});

	it("dispose() bumps epoch so in-flight key tasks bail and terminates active bindings' workers", async () => {
		const ctx = await newCtx();
		const session = createFakeSession();
		ctx.attach(session as never, () => true);
		const { kp } = bindKp(ctx);
		// `bindKp` was the last fakeWorker() call → workerTerminate
		// captures THAT binding's worker spy.
		const lastWorkerTerminate = workerTerminate;
		let resolveImport: ((k: CryptoKey) => void) | undefined;
		importKeySpy.mockReset();
		importKeySpy.mockImplementationOnce(
			() =>
				new Promise<CryptoKey>((res) => {
					resolveImport = res as (k: CryptoKey) => void;
				}),
		);
		session.emit(
			MatrixRTCSessionEvent.EncryptionKeyChanged,
			new Uint8Array([1]),
			0,
			{},
			"id",
		);
		ctx.dispose();
		expect(lastWorkerTerminate).toHaveBeenCalledTimes(1);
		// In-flight import resolves AFTER dispose — must not pump key.
		resolveImport?.({ __marker: 1 } as unknown as CryptoKey);
		await flush();
		expect(kp.calls).toHaveLength(0);
	});

	it("dispose is idempotent", async () => {
		const ctx = await newCtx();
		const b = ctx.bindRoom();
		ctx.dispose();
		ctx.dispose();
		expect(workerTerminate).toHaveBeenCalledTimes(1);
		// release() on a binding the bridge already released is a no-op.
		b.release();
		expect(workerTerminate).toHaveBeenCalledTimes(1);
	});

	it("reemit forwards to session.reemitEncryptionKeys", async () => {
		const ctx = await newCtx();
		const session = createFakeSession();
		ctx.reemit(session as never);
		expect(session.reemitEncryptionKeys).toHaveBeenCalledTimes(1);
		ctx.dispose();
	});

	it("reemit after dispose is a no-op", async () => {
		const ctx = await newCtx();
		ctx.dispose();
		const session = createFakeSession();
		ctx.reemit(session as never);
		expect(session.reemitEncryptionKeys).not.toHaveBeenCalled();
	});

	it("re-attaching detaches the previous listener and invalidates its in-flight imports", async () => {
		const ctx = await newCtx();
		const session1 = createFakeSession();
		const session2 = createFakeSession();
		ctx.attach(session1 as never, () => true);
		const { kp } = bindKp(ctx);
		let resolveImport: ((k: CryptoKey) => void) | undefined;
		importKeySpy.mockReset();
		importKeySpy.mockImplementationOnce(
			() =>
				new Promise<CryptoKey>((res) => {
					resolveImport = res as (k: CryptoKey) => void;
				}),
		);
		session1.emit(
			MatrixRTCSessionEvent.EncryptionKeyChanged,
			new Uint8Array([1]),
			0,
			{},
			"id",
		);
		ctx.attach(session2 as never, () => true);
		// session1's in-flight key resolves AFTER re-attach — must not
		// pump into the keyProvider (would be a key from the wrong call).
		resolveImport?.({ __marker: 1 } as unknown as CryptoKey);
		await flush();
		expect(kp.calls).toHaveLength(0);
		expect(session1.off).toHaveBeenCalled();
		ctx.dispose();
	});

	it("bindRoom replays cached keys into a fresh binding (focus-change reconnect)", async () => {
		const ctx = await newCtx();
		const session = createFakeSession();
		ctx.attach(session as never, () => true);
		// First binding receives the key live.
		const b1 = ctx.bindRoom();
		const kp1 = b1.e2eeOptions.keyProvider as unknown as FakeBaseKeyProvider;
		session.emit(
			MatrixRTCSessionEvent.EncryptionKeyChanged,
			new Uint8Array([7]),
			3,
			{},
			"id-A",
		);
		await flush();
		expect(kp1.calls).toHaveLength(1);
		expect(kp1.calls[0].keyIndex).toBe(3);
		// Simulate focus-change reconnect: release old, bind new.
		b1.release();
		const b2 = ctx.bindRoom();
		const kp2 = b2.e2eeOptions.keyProvider as unknown as FakeBaseKeyProvider;
		// The new binding must observe the cached key WITHOUT a fresh
		// EncryptionKeyChanged event (the SDK only re-emits on rotation).
		expect(kp2.calls).toHaveLength(1);
		expect(kp2.calls[0].participantIdentity).toBe("id-A");
		expect(kp2.calls[0].keyIndex).toBe(3);
		b2.release();
		ctx.dispose();
	});

	it("binding.release is idempotent and terminates that binding's worker exactly once", async () => {
		const ctx = await newCtx();
		ctx.bindRoom();
		const terminate1 = workerTerminate;
		const b2 = ctx.bindRoom();
		const terminate2 = workerTerminate;
		expect(terminate1).not.toBe(terminate2);
		b2.release();
		b2.release();
		expect(terminate2).toHaveBeenCalledTimes(1);
		ctx.dispose();
		// dispose() releases the still-acquired b1 as safety net.
		expect(terminate1).toHaveBeenCalledTimes(1);
	});

	it("new cached keys only pump into the most recently acquired binding", async () => {
		const ctx = await newCtx();
		const session = createFakeSession();
		ctx.attach(session as never, () => true);
		const b1 = ctx.bindRoom();
		const kp1 = b1.e2eeOptions.keyProvider as unknown as FakeBaseKeyProvider;
		const b2 = ctx.bindRoom();
		const kp2 = b2.e2eeOptions.keyProvider as unknown as FakeBaseKeyProvider;
		session.emit(
			MatrixRTCSessionEvent.EncryptionKeyChanged,
			new Uint8Array([42]),
			1,
			{},
			"id",
		);
		await flush();
		expect(kp1.calls).toHaveLength(0);
		expect(kp2.calls.map((c) => c.keyIndex)).toEqual([1]);
		b1.release();
		b2.release();
		ctx.dispose();
	});
});
