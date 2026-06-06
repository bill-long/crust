import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

vi.mock("matrix-js-sdk/lib/crypto-api/recovery-key", () => ({
	decodeRecoveryKey: (raw: string) => {
		if (raw === "bad-format") throw new Error("bad format");
		return new Uint8Array([1, 2, 3]);
	},
}));

type Resolver =
	| ((
			validate?: (key: Uint8Array<ArrayBuffer>) => Promise<boolean>,
	  ) => Promise<Uint8Array<ArrayBuffer> | null>)
	| null;

let registeredResolver: Resolver = null;

vi.mock("../../../client/client", () => ({
	useClient: () => ({
		setRecoveryKeyResolver: (resolver: Resolver) => {
			registeredResolver = resolver;
		},
	}),
}));

import { RecoveryKeyInput } from "./RecoveryKeyInput";

afterEach(() => {
	cleanup();
	registeredResolver = null;
});

function typeAndSubmit(value: string): void {
	const input = screen.getByLabelText("Recovery key") as HTMLInputElement;
	fireEvent.input(input, { target: { value } });
	fireEvent.click(screen.getByText("Unlock"));
}

describe("RecoveryKeyInput", () => {
	it("rejects a well-formed but incorrect key before resolving", async () => {
		render(() => <RecoveryKeyInput />);
		const validate = vi.fn().mockResolvedValue(false);

		let resolved: Uint8Array<ArrayBuffer> | null | undefined;
		const promise = registeredResolver?.(validate).then((k) => {
			resolved = k;
		});
		await Promise.resolve();

		typeAndSubmit("good-key");
		// Allow the async validate + state updates to flush.
		await new Promise((r) => setTimeout(r, 0));

		expect(validate).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("alert").textContent).toContain(
			"Incorrect recovery key",
		);
		// The promise must still be pending — no key handed to the SDK.
		expect(resolved).toBeUndefined();

		// A subsequent correct entry resolves with the decoded bytes.
		validate.mockResolvedValue(true);
		typeAndSubmit("good-key");
		await promise;
		expect(resolved).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("resolves immediately when no validator is supplied", async () => {
		render(() => <RecoveryKeyInput />);
		let resolved: Uint8Array<ArrayBuffer> | null | undefined;
		const promise = registeredResolver?.().then((k) => {
			resolved = k;
		});
		await Promise.resolve();

		typeAndSubmit("good-key");
		await promise;
		expect(resolved).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("shows a format error without invoking the validator", async () => {
		render(() => <RecoveryKeyInput />);
		const validate = vi.fn().mockResolvedValue(true);
		registeredResolver?.(validate);
		await Promise.resolve();

		typeAndSubmit("bad-format");
		await new Promise((r) => setTimeout(r, 0));

		expect(validate).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toContain(
			"Invalid recovery key",
		);
	});

	it("does not resolve a new batch with a superseded batch's validation", async () => {
		render(() => <RecoveryKeyInput />);

		// Batch A: a validator whose resolution we control manually.
		let releaseA: (valid: boolean) => void = () => {};
		const validateA = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					releaseA = resolve;
				}),
		);
		let resolvedA: Uint8Array<ArrayBuffer> | null | undefined;
		registeredResolver?.(validateA).then((k) => {
			resolvedA = k;
		});
		await Promise.resolve();

		typeAndSubmit("good-key");
		await Promise.resolve();
		expect(validateA).toHaveBeenCalledTimes(1);

		// User cancels batch A via the Cancel button (which stays reachable
		// during the check) while its validation is still in flight.
		fireEvent.click(screen.getByText("Cancel"));
		await Promise.resolve();
		expect(resolvedA).toBeNull();

		// Batch B: a fresh SDK request arrives before A's validation settles.
		const validateB = vi.fn().mockResolvedValue(true);
		let resolvedB: Uint8Array<ArrayBuffer> | null | undefined;
		registeredResolver?.(validateB).then((k) => {
			resolvedB = k;
		});
		await Promise.resolve();

		// A's stale validation now resolves true — it must NOT resolve batch B.
		releaseA(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(resolvedB).toBeUndefined();
	});
});
