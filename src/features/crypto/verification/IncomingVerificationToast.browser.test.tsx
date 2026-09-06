import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import {
	CryptoEvent,
	VerificationPhase,
	type VerificationRequest,
} from "matrix-js-sdk/lib/crypto-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { Modal } from "../../../components/Modal";
import { setCryptoTriggerElement } from "../../../stores/cryptoActions";
import "../../../styles/global.css";
import { IncomingVerificationToast } from "./IncomingVerificationToast";

afterEach(() => {
	cleanup();
	setCryptoTriggerElement(null);
});

describe("IncomingVerificationToast above a modal", () => {
	it.each(["Accept", "Decline"])("keeps %s interactive", async (action) => {
		let receive!: (request: VerificationRequest) => void;
		const client = {
			on: (event: string, listener: typeof receive) => {
				if (event === CryptoEvent.VerificationRequestReceived)
					receive = listener;
			},
			removeListener: vi.fn(),
		} as unknown as MatrixClient;
		const cancel = vi.fn(async () => {});
		const request = {
			phase: VerificationPhase.Requested,
			pending: true,
			accepting: false,
			declining: false,
			on: vi.fn(),
			removeListener: vi.fn(),
			cancel,
		} as unknown as VerificationRequest;
		const accept = vi.fn();
		const close = vi.fn();
		render(() => (
			<>
				<Modal open onClose={close} label="Existing crypto flow">
					<button type="button">Existing action</button>
				</Modal>
				<IncomingVerificationToast client={client} onAccept={accept} />
			</>
		));
		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByText("Existing action"));
		receive(request);
		const button = screen.getByRole("button", { name: action });
		expect(getComputedStyle(button).pointerEvents).toBe("auto");
		button.focus();
		expect(document.activeElement).toBe(button);
		await userEvent.click(button);
		expect(screen.queryByText("Verification request")).toBeNull();
		if (action === "Accept") expect(accept).toHaveBeenCalledWith(request);
		else expect(cancel).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();
	});
});
