import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportKeysDialog } from "./ExportKeysDialog";
import { ImportKeysDialog } from "./ImportKeysDialog";
import { encryptMegolmKeyFile } from "./megolmKeyFile";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// Keep PBKDF2 cheap in tests: the dialog hardcodes the format's 500k
// iteration default, which is right in production but seconds-slow here.
// The file format itself is covered by megolmKeyFile.test.ts.
vi.mock("./megolmKeyFile", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./megolmKeyFile")>();
	return {
		...actual,
		encryptMegolmKeyFile: (data: string, passphrase: string) =>
			actual.encryptMegolmKeyFile(data, passphrase, 1_000),
	};
});

const exportRoomKeysAsJson = vi.fn();
const importRoomKeysAsJson = vi.fn();

vi.mock("../../../client/client", () => ({
	useClient: () => ({
		client: {
			getCrypto: () => ({
				exportRoomKeysAsJson,
				importRoomKeysAsJson,
			}),
		},
	}),
}));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const KEYS_JSON = JSON.stringify([
	{ room_id: "!r:example.com", session_id: "s1", session_key: "k" },
	{ room_id: "!r:example.com", session_id: "s2", session_key: "k" },
]);

/** jsdom File lacks text(); shadow it on the instance (known jsdom gap). */
function makeFile(content: string, name = "keys.txt"): File {
	const f = new File([content], name, { type: "text/plain" });
	(f as unknown as { text: () => Promise<string> }).text = async () => content;
	return f;
}

beforeEach(() => {
	// jsdom doesn't implement createObjectURL.
	URL.createObjectURL = vi.fn(() => "blob:mock");
	URL.revokeObjectURL = vi.fn();
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ExportKeysDialog", () => {
	it("rejects mismatched passphrases before exporting", async () => {
		render(() => <ExportKeysDialog onClose={() => {}} />);
		fireEvent.input(screen.getByLabelText("Passphrase"), {
			target: { value: "one" },
		});
		fireEvent.input(screen.getByLabelText("Confirm passphrase"), {
			target: { value: "two" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Export" }));
		await flush();

		expect(screen.getByRole("alert").textContent).toContain("don't match");
		expect(exportRoomKeysAsJson).not.toHaveBeenCalled();
	});

	it("exports and downloads an encrypted file", async () => {
		exportRoomKeysAsJson.mockResolvedValue(KEYS_JSON);
		render(() => <ExportKeysDialog onClose={() => {}} />);
		fireEvent.input(screen.getByLabelText("Passphrase"), {
			target: { value: "hunter2" },
		});
		fireEvent.input(screen.getByLabelText("Confirm passphrase"), {
			target: { value: "hunter2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Export" }));
		await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());

		expect(exportRoomKeysAsJson).toHaveBeenCalledOnce();
		expect(screen.getByText("Keys exported")).toBeTruthy();
		expect(screen.getByText(/crust-message-keys-/)).toBeTruthy();
	});

	it("focuses the passphrase input on open", () => {
		render(() => <ExportKeysDialog onClose={() => {}} />);
		expect(document.activeElement).toBe(screen.getByLabelText("Passphrase"));
	});

	it("keeps Export disabled until a passphrase is entered", () => {
		render(() => <ExportKeysDialog onClose={() => {}} />);
		const button = screen.getByRole("button", { name: "Export" });
		expect(button).toHaveProperty("disabled", true);
		fireEvent.input(screen.getByLabelText("Passphrase"), {
			target: { value: "x" },
		});
		expect(button).toHaveProperty("disabled", false);
	});

	it("surfaces an export failure", async () => {
		exportRoomKeysAsJson.mockRejectedValue(new Error("crypto exploded"));
		render(() => <ExportKeysDialog onClose={() => {}} />);
		fireEvent.input(screen.getByLabelText("Passphrase"), {
			target: { value: "hunter2" },
		});
		fireEvent.input(screen.getByLabelText("Confirm passphrase"), {
			target: { value: "hunter2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Export" }));
		await waitFor(() => expect(screen.getByText("Export failed")).toBeTruthy());

		expect(screen.getByRole("alert").textContent).toContain("crypto exploded");
	});
});

describe("ImportKeysDialog", () => {
	async function pickEncryptedFile(passphrase: string): Promise<void> {
		const encrypted = await encryptMegolmKeyFile(KEYS_JSON, passphrase, 1_000);
		const input = screen.getByLabelText("Key export file") as HTMLInputElement;
		fireEvent.change(input, {
			target: { files: [makeFile(encrypted)] },
		});
	}

	it("imports an encrypted export file with the right passphrase", async () => {
		importRoomKeysAsJson.mockResolvedValue(undefined);
		render(() => <ImportKeysDialog onClose={() => {}} />);
		await pickEncryptedFile("hunter2");
		fireEvent.input(
			screen.getByLabelText("Passphrase (if the file is encrypted)"),
			{ target: { value: "hunter2" } },
		);
		fireEvent.click(screen.getByRole("button", { name: "Import" }));
		await waitFor(() => expect(screen.getByText("Keys imported")).toBeTruthy());

		expect(importRoomKeysAsJson).toHaveBeenCalledWith(KEYS_JSON);
		expect(screen.getByText(/Imported 2 message keys/)).toBeTruthy();
	});

	it("rejects a wrong passphrase with a clear error", async () => {
		render(() => <ImportKeysDialog onClose={() => {}} />);
		await pickEncryptedFile("right");
		fireEvent.input(
			screen.getByLabelText("Passphrase (if the file is encrypted)"),
			{ target: { value: "wrong" } },
		);
		fireEvent.click(screen.getByRole("button", { name: "Import" }));
		await waitFor(() => expect(screen.getByText("Import failed")).toBeTruthy());

		expect(screen.getByRole("alert").textContent).toContain(
			"Incorrect passphrase",
		);
		expect(importRoomKeysAsJson).not.toHaveBeenCalled();
	});

	it("imports a raw unencrypted JSON export without a passphrase", async () => {
		importRoomKeysAsJson.mockResolvedValue(undefined);
		render(() => <ImportKeysDialog onClose={() => {}} />);
		const input = screen.getByLabelText("Key export file") as HTMLInputElement;
		fireEvent.change(input, {
			target: { files: [makeFile(KEYS_JSON, "keys.json")] },
		});
		fireEvent.click(screen.getByRole("button", { name: "Import" }));
		await waitFor(() => expect(screen.getByText("Keys imported")).toBeTruthy());

		expect(importRoomKeysAsJson).toHaveBeenCalledWith(KEYS_JSON);
	});

	it("focuses the file input on open", () => {
		render(() => <ImportKeysDialog onClose={() => {}} />);
		expect(document.activeElement).toBe(
			screen.getByLabelText("Key export file"),
		);
	});

	it("keeps Import disabled until a file is chosen", () => {
		render(() => <ImportKeysDialog onClose={() => {}} />);
		const button = screen.getByRole("button", { name: "Import" });
		expect(button).toHaveProperty("disabled", true);
		const input = screen.getByLabelText("Key export file") as HTMLInputElement;
		// Raw JSON exports are supported by the parser, so the picker must
		// not hide them.
		expect(input.accept).toContain(".json");
		fireEvent.change(input, {
			target: { files: [makeFile(KEYS_JSON, "keys.json")] },
		});
		expect(button).toHaveProperty("disabled", false);
	});

	it("rejects a file that is neither an export nor valid JSON", async () => {
		render(() => <ImportKeysDialog onClose={() => {}} />);
		fireEvent.change(screen.getByLabelText("Key export file"), {
			target: { files: [makeFile("not json at all", "keys.txt")] },
		});
		fireEvent.click(screen.getByRole("button", { name: "Import" }));
		await waitFor(() => expect(screen.getByText("Import failed")).toBeTruthy());

		expect(screen.getByRole("alert").textContent).toContain(
			"doesn't contain valid exported keys",
		);
		expect(importRoomKeysAsJson).not.toHaveBeenCalled();
	});
});
