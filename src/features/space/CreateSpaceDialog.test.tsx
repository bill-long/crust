import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, type ParentComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import {
	createSummariesStore,
	type SummariesStore,
} from "../../client/summaries";
import { createMockClient } from "../../test/mockClient";
import { CreateSpaceDialog } from "./CreateSpaceDialog";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const navigateMock = vi.fn();
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
}));

const optimisticallyMarkJoined = vi.fn();

const Wrapper: ParentComponent<{
	client: ReturnType<typeof createMockClient>;
}> = (props) => {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const { summaries } = createSummariesStore(
		props.client as unknown as MatrixClient,
	);
	return (
		<ClientContext.Provider
			value={{
				client: props.client as unknown as MatrixClient,
				syncState,
				cryptoState,
				summaries: summaries as unknown as SummariesStore,
				cryptoStatus: {
					crossSigningReady: () => true,
					thisDeviceVerified: () => true,
					backupVersion: () => null,
					backupOnServer: () => false,
					backupTrusted: () => true,
					secretStorageReady: () => true,
					crossSigningStatus: () => undefined,
					refresh: async () => {},
				},
				requestRecoveryKey: async () => null,
				setRecoveryKeyResolver: () => {},
				clearSecretStorageCache: () => {},
				optimisticallyMarkJoined,
				optimisticallyMarkLeft: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
	cleanup();
	navigateMock.mockReset();
	optimisticallyMarkJoined.mockReset();
});

function setup() {
	const client = createMockClient();
	const [open, setOpen] = createSignal(true);
	const onClose = vi.fn(() => setOpen(false));
	render(() => (
		<Wrapper client={client}>
			<CreateSpaceDialog
				client={client as unknown as MatrixClient}
				open={open}
				onClose={onClose}
			/>
		</Wrapper>
	));
	return { client, open, setOpen, onClose };
}

function makeImageFile(name = "a.png", bytes = 100, type = "image/png"): File {
	return new File([new Uint8Array(bytes)], name, { type });
}

describe("CreateSpaceDialog", () => {
	it("submits a private space with name only and navigates to /space/<id>", async () => {
		const { client, onClose } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "My Space" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		expect(client.createRoom).toHaveBeenCalledTimes(1);
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		expect(opts.name).toBe("My Space");
		expect(opts.visibility).toBe("private");
		expect(opts.preset).toBe("private_chat");
		expect(opts.creation_content).toEqual({ type: "m.space" });
		const pl = opts.power_level_content_override as Record<string, unknown>;
		expect(pl.events_default).toBe(100);
		expect(pl.state_default).toBe(100);
		expect(pl.users_default).toBe(0);
		expect(pl.invite).toBe(50);
		expect((pl.events as Record<string, number>)["m.space.child"]).toBe(50);
		const initial = opts.initial_state as Array<{
			type: string;
			content: Record<string, unknown>;
		}>;
		// History visibility + guest access (no avatar, no encryption)
		expect(
			initial.find((e) => e.type === "m.room.history_visibility")?.content,
		).toEqual({ history_visibility: "shared" });
		expect(
			initial.find((e) => e.type === "m.room.guest_access")?.content,
		).toEqual({ guest_access: "forbidden" });
		expect(initial.find((e) => e.type === "m.room.encryption")).toBeUndefined();
		expect(initial.find((e) => e.type === "m.room.avatar")).toBeUndefined();
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent("!created:example.com")}`,
		);
		expect(optimisticallyMarkJoined).toHaveBeenCalledWith(
			"!created:example.com",
			{ name: "My Space", avatarUrl: null, isSpace: true },
		);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("uses world_readable history visibility for public spaces", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "Lobby" },
		});
		fireEvent.click(screen.getByLabelText(/Public/i));
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		expect(opts.visibility).toBe("public");
		expect(opts.preset).toBe("public_chat");
		const initial = opts.initial_state as Array<{
			type: string;
			content: Record<string, unknown>;
		}>;
		expect(
			initial.find((e) => e.type === "m.room.history_visibility")?.content,
		).toEqual({ history_visibility: "world_readable" });
	});

	it("uploads avatar and includes m.room.avatar in initial_state", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const file = makeImageFile();
		Object.defineProperty(fileInput, "files", { value: [file] });
		fireEvent.change(fileInput);
		await flush();
		await flush();
		expect(client.uploadContent).toHaveBeenCalledWith(file);
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		const initial = opts.initial_state as Array<{
			type: string;
			content: Record<string, unknown>;
		}>;
		expect(initial.find((e) => e.type === "m.room.avatar")?.content).toEqual({
			url: "mxc://example.com/avatar",
		});
		expect(optimisticallyMarkJoined).toHaveBeenCalledWith(
			"!created:example.com",
			expect.objectContaining({
				isSpace: true,
				avatarUrl: expect.stringContaining("example.com/avatar"),
			}),
		);
	});

	it("rejects non-image files", async () => {
		const { client } = setup();
		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const file = new File(["x"], "x.txt", { type: "text/plain" });
		Object.defineProperty(fileInput, "files", { value: [file] });
		fireEvent.change(fileInput);
		await flush();
		expect(client.uploadContent).not.toHaveBeenCalled();
		expect(screen.getByText(/must be an image/i)).toBeTruthy();
	});

	it("rejects images over 10 MB", async () => {
		const { client } = setup();
		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const file = makeImageFile("big.png", 11 * 1024 * 1024);
		Object.defineProperty(fileInput, "files", { value: [file] });
		fireEvent.change(fileInput);
		await flush();
		expect(client.uploadContent).not.toHaveBeenCalled();
		expect(screen.getByText(/under 10 MB/i)).toBeTruthy();
	});

	it("disables Create while avatar is uploading", async () => {
		const { client } = setup();
		let resolveUpload!: (v: { content_uri: string }) => void;
		(client.uploadContent as ReturnType<typeof vi.fn>).mockImplementationOnce(
			() =>
				new Promise<{ content_uri: string }>((res) => {
					resolveUpload = res;
				}),
		);
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		Object.defineProperty(fileInput, "files", { value: [makeImageFile()] });
		fireEvent.change(fileInput);
		await flush();
		const submit = screen.getByRole("button", {
			name: /^Create$/i,
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		resolveUpload({ content_uri: "mxc://example.com/late" });
		await flush();
		await flush();
		expect(submit.disabled).toBe(false);
	});

	it("ignores a stale upload result after a newer file is picked", async () => {
		const { client } = setup();
		let resolveFirst!: (v: { content_uri: string }) => void;
		(client.uploadContent as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(
				() =>
					new Promise<{ content_uri: string }>((res) => {
						resolveFirst = res;
					}),
			)
			.mockResolvedValueOnce({ content_uri: "mxc://example.com/second" });
		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		// First selection
		Object.defineProperty(fileInput, "files", {
			value: [makeImageFile("first.png")],
			configurable: true,
		});
		fireEvent.change(fileInput);
		await flush();
		// Second selection before first resolves
		Object.defineProperty(fileInput, "files", {
			value: [makeImageFile("second.png")],
			configurable: true,
		});
		fireEvent.change(fileInput);
		await flush();
		await flush();
		// Now the first (stale) upload resolves — must be ignored.
		resolveFirst({ content_uri: "mxc://example.com/first" });
		await flush();
		await flush();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		const initial = opts.initial_state as Array<{
			type: string;
			content: Record<string, unknown>;
		}>;
		expect(initial.find((e) => e.type === "m.room.avatar")?.content).toEqual({
			url: "mxc://example.com/second",
		});
	});

	it("ignores a stale upload when the next file is rejected by validation", async () => {
		const { client } = setup();
		let resolveFirst!: (v: { content_uri: string }) => void;
		(client.uploadContent as ReturnType<typeof vi.fn>).mockImplementationOnce(
			() =>
				new Promise<{ content_uri: string }>((res) => {
					resolveFirst = res;
				}),
		);
		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		Object.defineProperty(fileInput, "files", {
			value: [makeImageFile("first.png")],
			configurable: true,
		});
		fireEvent.change(fileInput);
		await flush();
		// Pick a non-image — uploadAvatar must bump generation BEFORE validating
		// so the in-flight upload's resolution is dropped.
		Object.defineProperty(fileInput, "files", {
			value: [new File(["x"], "x.txt", { type: "text/plain" })],
			configurable: true,
		});
		fireEvent.change(fileInput);
		await flush();
		resolveFirst({ content_uri: "mxc://example.com/stale" });
		await flush();
		await flush();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		const initial = opts.initial_state as Array<{ type: string }>;
		expect(initial.find((e) => e.type === "m.room.avatar")).toBeUndefined();
	});

	it("parses invite MXIDs and includes them in invite[]", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		fireEvent.input(screen.getByLabelText(/Invite users/i), {
			target: { value: "@alice:example.com, @bob:example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		expect(opts.invite).toEqual(["@alice:example.com", "@bob:example.com"]);
	});

	it("drops the caller's own MXID from invites", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		fireEvent.input(screen.getByLabelText(/Invite users/i), {
			target: { value: "@test:example.com, @alice:example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		expect(opts.invite).toEqual(["@alice:example.com"]);
	});

	it("blocks submit on malformed invites", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		fireEvent.input(screen.getByLabelText(/Invite users/i), {
			target: { value: "bogus" },
		});
		const submit = screen.getByRole("button", {
			name: /^Create$/i,
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		fireEvent.click(submit);
		await flush();
		expect(client.createRoom).not.toHaveBeenCalled();
		expect(screen.getByText(/bogus:/i)).toBeTruthy();
	});

	it("blocks submit on invalid alias local-part", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		fireEvent.input(screen.getByLabelText(/^Alias/i), {
			target: { value: "has spaces" },
		});
		const submit = screen.getByRole("button", {
			name: /^Create$/i,
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		fireEvent.click(submit);
		await flush();
		expect(client.createRoom).not.toHaveBeenCalled();
	});

	it("includes room_alias_name when alias is valid", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		fireEvent.input(screen.getByLabelText(/^Alias/i), {
			target: { value: "my-space" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		expect(opts.room_alias_name).toBe("my-space");
	});

	it("surfaces createRoom errors and keeps the dialog open", async () => {
		const { client, onClose } = setup();
		(client.createRoom as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("Server said no"),
		);
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "x" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		expect(screen.getByRole("alert").textContent).toContain("Server said no");
		expect(onClose).not.toHaveBeenCalled();
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("closes on Escape", () => {
		const { onClose } = setup();
		const dialog = screen.getByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes on outside click", () => {
		const { onClose } = setup();
		const dialog = screen.getByRole("dialog");
		fireEvent.click(dialog);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("ignores a double-click on Create (no duplicate createRoom calls)", async () => {
		const client = createMockClient();
		let resolveCreate!: (v: { room_id: string }) => void;
		(client.createRoom as ReturnType<typeof vi.fn>).mockImplementationOnce(
			() =>
				new Promise<{ room_id: string }>((res) => {
					resolveCreate = res;
				}),
		);
		const [open, setOpen] = createSignal(true);
		const onClose = vi.fn(() => setOpen(false));
		render(() => (
			<Wrapper client={client}>
				<CreateSpaceDialog
					client={client as unknown as MatrixClient}
					open={open}
					onClose={onClose}
				/>
			</Wrapper>
		));
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		const submit = screen.getByRole("button", { name: /^Create$/i });
		fireEvent.click(submit);
		fireEvent.click(submit);
		fireEvent.click(submit);
		expect(client.createRoom).toHaveBeenCalledTimes(1);
		resolveCreate({ room_id: "!once:example.com" });
		await flush();
		await flush();
		expect(client.createRoom).toHaveBeenCalledTimes(1);
	});

	it("ignores a stale in-flight submit after close+reopen", async () => {
		const client = createMockClient();
		let resolveFirst!: (v: { room_id: string }) => void;
		(client.createRoom as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(
				() =>
					new Promise<{ room_id: string }>((res) => {
						resolveFirst = res;
					}),
			)
			.mockResolvedValueOnce({ room_id: "!second:example.com" });
		const [open, setOpen] = createSignal(true);
		const onClose = vi.fn(() => setOpen(false));
		render(() => (
			<Wrapper client={client}>
				<CreateSpaceDialog
					client={client as unknown as MatrixClient}
					open={open}
					onClose={onClose}
				/>
			</Wrapper>
		));
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "first" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		// Close mid-flight, then reopen, then resolve the stale submit.
		setOpen(false);
		await flush();
		setOpen(true);
		await flush();
		resolveFirst({ room_id: "!first:example.com" });
		await flush();
		await flush();
		expect(navigateMock).not.toHaveBeenCalled();
		expect(optimisticallyMarkJoined).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("does not navigate or write store if closed before createRoom resolves", async () => {
		const client = createMockClient();
		let resolveCreate!: (v: { room_id: string }) => void;
		(client.createRoom as ReturnType<typeof vi.fn>).mockImplementationOnce(
			() =>
				new Promise<{ room_id: string }>((res) => {
					resolveCreate = res;
				}),
		);
		const [open, setOpen] = createSignal(true);
		const onClose = vi.fn(() => setOpen(false));
		render(() => (
			<Wrapper client={client}>
				<CreateSpaceDialog
					client={client as unknown as MatrixClient}
					open={open}
					onClose={onClose}
				/>
			</Wrapper>
		));
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		setOpen(false);
		await flush();
		resolveCreate({ room_id: "!late:example.com" });
		await flush();
		await flush();
		expect(optimisticallyMarkJoined).not.toHaveBeenCalled();
		expect(navigateMock).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(0);
	});

	it("resets form fields when reopened", async () => {
		const client = createMockClient();
		const [open, setOpen] = createSignal(true);
		const onClose = vi.fn(() => setOpen(false));
		render(() => (
			<Wrapper client={client}>
				<CreateSpaceDialog
					client={client as unknown as MatrixClient}
					open={open}
					onClose={onClose}
				/>
			</Wrapper>
		));
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "draft" },
		});
		fireEvent.input(screen.getByLabelText(/^Topic/i), {
			target: { value: "draft topic" },
		});
		setOpen(false);
		await flush();
		setOpen(true);
		await flush();
		expect((screen.getByLabelText(/^Name$/i) as HTMLInputElement).value).toBe(
			"",
		);
		expect(
			(screen.getByLabelText(/^Topic/i) as HTMLTextAreaElement).value,
		).toBe("");
	});

	it("Remove avatar clears the mxc and the next submit omits m.room.avatar", async () => {
		const { client } = setup();
		const fileInput = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		Object.defineProperty(fileInput, "files", { value: [makeImageFile()] });
		fireEvent.change(fileInput);
		await flush();
		await flush();
		fireEvent.click(screen.getByRole("button", { name: /^Remove$/i }));
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "S" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		const initial = opts.initial_state as Array<{ type: string }>;
		expect(initial.find((e) => e.type === "m.room.avatar")).toBeUndefined();
	});
});
