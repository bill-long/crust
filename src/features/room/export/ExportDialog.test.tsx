import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requiredAt } from "../testAssertions";
import { ExportDialog } from "./ExportDialog";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const exportRoom = vi.fn();
vi.mock("./exportRoom", () => ({
	exportRoom: (...args: unknown[]) => exportRoom(...args),
}));

const saveBlobToDisk = vi.fn();
vi.mock("../../../lib/saveBlob", () => ({
	saveBlobToDisk: (...args: unknown[]) => saveBlobToDisk(...args),
}));

const client = {
	getRoom: () => ({
		roomId: "!r:hs",
		hasEncryptionStateEvent: () => false,
	}),
} as unknown as MatrixClient;

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function setup(): { onClose: ReturnType<typeof vi.fn> } {
	const onClose = vi.fn();
	render(() => (
		<ExportDialog client={client} roomId="!r:hs" onClose={onClose} />
	));
	return { onClose };
}

describe("ExportDialog", () => {
	it("exports the default last-100 range and saves the result", async () => {
		exportRoom.mockResolvedValue({ blob: new Blob(["x"]), filename: "f.html" });
		const { onClose } = setup();
		fireEvent.click(screen.getByRole("button", { name: "Export" }));
		await waitFor(() => expect(exportRoom).toHaveBeenCalled());
		expect(
			requiredAt(exportRoom.mock.calls, 0, "export call")[2],
		).toMatchObject({
			format: "html",
			limit: 100,
			includeAttachments: false,
		});
		await waitFor(() => expect(saveBlobToDisk).toHaveBeenCalled());
		expect(onClose).toHaveBeenCalled();
	});

	it("typing a count reverts an armed Entire-history selection", async () => {
		// Selecting Entire history and then typing into the count input must
		// export the typed count, never a surprise full-history plaintext
		// dump (review on #530).
		exportRoom.mockResolvedValue({ blob: new Blob(["x"]), filename: "f" });
		setup();
		fireEvent.click(screen.getByRole("radio", { name: /Entire history/ }));
		fireEvent.input(screen.getByLabelText("Number of messages"), {
			target: { value: "50" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Export" }));
		await waitFor(() => expect(exportRoom).toHaveBeenCalled());
		expect(
			requiredAt(exportRoom.mock.calls, 0, "export call")[2],
		).toMatchObject({ limit: 50 });
	});

	it("reads the count the way the browser displays it, and rejects non-integers", async () => {
		// parseInt("1e10") is 1 - a silent 10-billion-fold misread. Number()
		// keeps the displayed value; non-integers stay rejected.
		exportRoom.mockResolvedValue({ blob: new Blob(["x"]), filename: "f" });
		setup();
		const count = screen.getByLabelText("Number of messages");
		fireEvent.input(count, { target: { value: "3.5" } });
		expect(
			(screen.getByRole("button", { name: "Export" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);

		fireEvent.input(count, { target: { value: "1e10" } });
		fireEvent.click(screen.getByRole("button", { name: "Export" }));
		await waitFor(() => expect(exportRoom).toHaveBeenCalled());
		expect(
			requiredAt(exportRoom.mock.calls, 0, "export call")[2],
		).toMatchObject({
			limit: 10_000_000_000,
		});
	});

	it("exports the entire history when selected", async () => {
		exportRoom.mockResolvedValue({ blob: new Blob(["x"]), filename: "f" });
		setup();
		fireEvent.click(screen.getByRole("radio", { name: /Entire history/ }));
		fireEvent.click(screen.getByRole("button", { name: "Export" }));
		await waitFor(() => expect(exportRoom).toHaveBeenCalled());
		expect(
			requiredAt(exportRoom.mock.calls, 0, "export call")[2],
		).toMatchObject({ limit: null });
	});

	it("aborts attachment downloads on cancel and force-closes on a second dismiss", async () => {
		let seenSignal: AbortSignal | undefined;
		exportRoom.mockImplementation(
			(
				_c: unknown,
				_r: unknown,
				_o: unknown,
				_p: unknown,
				_isCancelled: () => boolean,
				signal?: AbortSignal,
			) => {
				seenSignal = signal;
				// A run the client cannot interrupt.
				return new Promise(() => {});
			},
		);
		const { onClose } = setup();
		fireEvent.click(screen.getByRole("button", { name: "Export" }));
		const cancel = await screen.findByRole("button", {
			name: "Cancel export",
		});
		fireEvent.click(cancel);
		expect(seenSignal?.aborted).toBe(true);
		expect(onClose).not.toHaveBeenCalled();
		// The run is wedged; the second dismissal is the escape hatch.
		fireEvent.click(cancel);
		expect(onClose).toHaveBeenCalled();
	});

	it("returns to the options after a cancelled export without saving", async () => {
		let finish!: () => void;
		exportRoom.mockImplementation(
			async (
				_c: unknown,
				_r: unknown,
				_o: unknown,
				_p: unknown,
				isCancelled: () => boolean,
			) => {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return isCancelled() ? null : { blob: new Blob(["x"]), filename: "f" };
			},
		);
		const { onClose } = setup();
		fireEvent.click(screen.getByRole("button", { name: "Export" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Cancel export" }),
		);
		finish();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Export" })).toBeTruthy(),
		);
		expect(saveBlobToDisk).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});
});
