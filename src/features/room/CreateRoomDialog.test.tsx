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
import { CreateRoomDialog } from "./CreateRoomDialog";

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
					backupTrusted: () => true,
					secretStorageReady: () => true,
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

function setup(opts?: { spaceId?: string }) {
	const client = createMockClient();
	const [open, setOpen] = createSignal(true);
	const onClose = vi.fn(() => setOpen(false));
	render(() => (
		<Wrapper client={client}>
			<CreateRoomDialog
				client={client as unknown as MatrixClient}
				open={open}
				onClose={onClose}
				spaceId={opts?.spaceId}
			/>
		</Wrapper>
	));
	return { client, open, setOpen, onClose };
}

describe("CreateRoomDialog", () => {
	it("submits with name only and navigates to /home/<roomId>", async () => {
		const { client, onClose } = setup();
		const name = screen.getByLabelText(/^Name$/i) as HTMLInputElement;
		fireEvent.input(name, { target: { value: "general" } });
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		expect(client.createRoom).toHaveBeenCalledTimes(1);
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		expect(opts.name).toBe("general");
		expect(opts.visibility).toBe("private");
		expect(opts.preset).toBe("private_chat");
		// Encryption defaults on for invite-only
		const initialState = opts.initial_state as Array<{ type: string }>;
		expect(initialState?.[0]?.type).toBe("m.room.encryption");
		expect(navigateMock).toHaveBeenCalledWith(
			`/home/${encodeURIComponent("!created:example.com")}`,
		);
		expect(optimisticallyMarkJoined).toHaveBeenCalledWith(
			"!created:example.com",
			{ name: "general", avatarUrl: null },
		);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("disables encryption by default when public is selected", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "lobby" },
		});
		fireEvent.click(screen.getByLabelText(/Public/i));
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		expect(opts.visibility).toBe("public");
		expect(opts.preset).toBe("public_chat");
		expect(opts.initial_state).toBeUndefined();
	});

	it("preserves user encryption choice across visibility flips", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "x" },
		});
		// User explicitly disables encryption on invite-only
		const encBox = screen.getByLabelText(
			/End-to-end encryption/i,
		) as HTMLInputElement;
		fireEvent.click(encBox);
		expect(encBox.checked).toBe(false);
		// Flip to public, then back to invite-only — must stay off
		fireEvent.click(screen.getByLabelText(/Public/i));
		fireEvent.click(screen.getByLabelText(/Invite-only/i));
		expect(encBox.checked).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		const opts = (client.createRoom as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		expect(opts.initial_state).toBeUndefined();
	});

	it("sends m.space.child and navigates to /space/<spaceId>/<roomId>", async () => {
		const { client } = setup({ spaceId: "!space:example.com" });
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "alpha" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!space:example.com",
			"m.space.child",
			{ via: ["example.com"], suggested: false },
			"!created:example.com",
		);
		// #184: the bidirectional m.space.parent is also sent on the child.
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!created:example.com",
			"m.space.parent",
			{ via: ["example.com"], canonical: true },
			"!space:example.com",
		);
		expect(navigateMock).toHaveBeenCalledWith(
			"/space/" +
				encodeURIComponent("!space:example.com") +
				"/" +
				encodeURIComponent("!created:example.com"),
		);
	});

	it("respects unchecking 'Add to this space'", async () => {
		const { client } = setup({ spaceId: "!space:example.com" });
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "n" },
		});
		fireEvent.click(screen.getByLabelText(/Add to this space/i));
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		expect(client.sendStateEvent).not.toHaveBeenCalled();
		expect(navigateMock).toHaveBeenCalledWith(
			`/home/${encodeURIComponent("!created:example.com")}`,
		);
	});

	it("parses comma-separated invite MXIDs and includes them in invite[]", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "n" },
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

	it("blocks submit and shows the per-token error on a malformed invite", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "n" },
		});
		fireEvent.input(screen.getByLabelText(/Invite users/i), {
			target: { value: "bogus, @alice:example.com" },
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

	it("blocks submit on an invalid alias local-part", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "n" },
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

	it("navigates and closes even if space-child linking fails", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { client, onClose } = setup({ spaceId: "!space:example.com" });
		(client.sendStateEvent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("link failed"),
		);
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "n" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		expect(client.createRoom).toHaveBeenCalledTimes(1);
		expect(navigateMock).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
		errSpy.mockRestore();
	});

	it("closes on Escape", async () => {
		const { onClose } = setup();
		const dialog = screen.getByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
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
				<CreateRoomDialog
					client={client as unknown as MatrixClient}
					open={open}
					onClose={onClose}
				/>
			</Wrapper>
		));
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "n" },
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

	it("uses the spaceId captured at open time, not a later prop change", async () => {
		const client = createMockClient();
		const [open, setOpen] = createSignal(true);
		const [spaceId, setSpaceId] = createSignal<string | undefined>(
			"!opened:example.com",
		);
		const onClose = vi.fn(() => setOpen(false));
		render(() => (
			<Wrapper client={client}>
				<CreateRoomDialog
					client={client as unknown as MatrixClient}
					open={open}
					onClose={onClose}
					spaceId={spaceId()}
				/>
			</Wrapper>
		));
		// Simulate the user navigating to a different space while the dialog is open.
		setSpaceId("!other:example.com");
		await flush();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "n" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		await flush();
		await flush();
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!opened:example.com",
			"m.space.child",
			expect.anything(),
			"!created:example.com",
		);
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent("!opened:example.com")}/${encodeURIComponent("!created:example.com")}`,
		);
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
				<CreateRoomDialog
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
		// Close mid-flight.
		setOpen(false);
		await flush();
		// User reopens the dialog.
		setOpen(true);
		await flush();
		// Stale submit finally resolves — must NOT navigate or write store
		// for the old submission, even though the dialog is open again.
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
				<CreateRoomDialog
					client={client as unknown as MatrixClient}
					open={open}
					onClose={onClose}
				/>
			</Wrapper>
		));
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "n" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
		// Close the dialog (unmount it) before createRoom resolves.
		setOpen(false);
		await flush();
		resolveCreate({ room_id: "!late:example.com" });
		await flush();
		await flush();
		expect(optimisticallyMarkJoined).not.toHaveBeenCalled();
		expect(navigateMock).not.toHaveBeenCalled();
		// We closed the dialog directly with setOpen(false), not via the
		// dialog's onClose path; the post-await guard must skip the handler's
		// own onClose call as well.
		expect(onClose).toHaveBeenCalledTimes(0);
	});

	it("drops the caller's own MXID from the invite list", async () => {
		const { client } = setup();
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "n" },
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

	it("closes on outside click", async () => {
		const { onClose } = setup();
		const dialog = screen.getByRole("dialog");
		fireEvent.click(dialog);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("resets form fields when reopened", async () => {
		const client = createMockClient();
		const [open, setOpen] = createSignal(true);
		const onClose = vi.fn(() => setOpen(false));
		render(() => (
			<Wrapper client={client}>
				<CreateRoomDialog
					client={client as unknown as MatrixClient}
					open={open}
					onClose={onClose}
				/>
			</Wrapper>
		));
		fireEvent.input(screen.getByLabelText(/^Name$/i), {
			target: { value: "first attempt" },
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
});
