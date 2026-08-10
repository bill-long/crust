import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, type ParentComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import {
	createSummariesStore,
	type SummariesStore,
} from "../../client/summaries";
import type { JoinAddress } from "../../lib/joinAddressParsing";
import { createMockClient } from "../../test/mockClient";
import { describeJoinError, JoinRoomDialog } from "./JoinRoomDialog";

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
			<JoinRoomDialog
				client={client as unknown as MatrixClient}
				open={open}
				onClose={onClose}
			/>
		</Wrapper>
	));
	return { client, open, setOpen, onClose };
}

/** Variant that starts closed with a focusable element outside the dialog,
    for focus capture/restore tests. */
function setupWithTrigger() {
	const client = createMockClient();
	const [open, setOpen] = createSignal(false);
	const onClose = vi.fn(() => setOpen(false));
	let triggerEl!: HTMLButtonElement;
	render(() => (
		<Wrapper client={client}>
			<button
				type="button"
				ref={(el) => {
					triggerEl = el;
				}}
			>
				trigger
			</button>
			<JoinRoomDialog
				client={client as unknown as MatrixClient}
				open={open}
				onClose={onClose}
			/>
		</Wrapper>
	));
	return { client, setOpen, onClose, trigger: () => triggerEl };
}

const JOINED_ID = "!joined:example.com";

function addressInput(): HTMLInputElement {
	return screen.getByLabelText(/^Room address or link$/i) as HTMLInputElement;
}

describe("JoinRoomDialog", () => {
	it("joins by alias, stubs the summary, navigates, and closes", async () => {
		const { client, onClose } = setup();
		fireEvent.input(addressInput(), {
			target: { value: "#general:example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(client.joinRoom).toHaveBeenCalledWith("#general:example.org", {
			viaServers: [],
		});
		expect(optimisticallyMarkJoined).toHaveBeenCalledWith(JOINED_ID, {
			name: "#general:example.org",
			avatarUrl: null,
		});
		expect(navigateMock).toHaveBeenCalledWith(
			`/home/${encodeURIComponent(JOINED_ID)}`,
		);
	});

	it("joins by room ID with trailing via servers", async () => {
		const { client, onClose } = setup();
		fireEvent.input(addressInput(), {
			target: { value: "!abc:example.org one.org two.org:8448" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(client.joinRoom).toHaveBeenCalledWith("!abc:example.org", {
			viaServers: ["one.org", "two.org:8448"],
		});
		expect(optimisticallyMarkJoined).toHaveBeenCalledWith(JOINED_ID, {
			name: "!abc:example.org",
			avatarUrl: null,
		});
	});

	it("accepts a matrix.to link", async () => {
		const { client, onClose } = setup();
		fireEvent.input(addressInput(), {
			target: {
				value: "https://matrix.to/#/%23general:example.org?via=one.org",
			},
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(client.joinRoom).toHaveBeenCalledWith("#general:example.org", {
			viaServers: ["one.org"],
		});
	});

	it("shows an inline validation error and does not call joinRoom", async () => {
		const { client } = setup();
		fireEvent.input(addressInput(), { target: { value: "general" } });
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		await screen.findByRole("alert");
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain(
			"must start with # (alias) or ! (room ID)",
		);
		expect(client.joinRoom).not.toHaveBeenCalled();
		// aria wiring: the input points at the alert and is marked invalid.
		const input = addressInput();
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toBe(alert.id);
		// and focus lands back on the field so the user can fix the address.
		expect(document.activeElement).toBe(input);
	});

	it("points a user ID at New direct message", async () => {
		const { client } = setup();
		fireEvent.input(addressInput(), {
			target: { value: "@alice:example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toBe(
			"That's a user ID - use New direct message instead.",
		);
		expect(client.joinRoom).not.toHaveBeenCalled();
	});

	it("maps M_NOT_FOUND to a check-the-address message", async () => {
		const { client } = setup();
		client.joinRoom.mockRejectedValueOnce({
			errcode: "M_NOT_FOUND",
			message: "Room not found",
		});
		fireEvent.input(addressInput(), {
			target: { value: "#nope:example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toBe(
			"Couldn't find a room at that address. Check the address and try again.",
		);
	});

	it("maps M_FORBIDDEN to an ask-for-an-invite message", async () => {
		const { client } = setup();
		client.joinRoom.mockRejectedValueOnce({
			errcode: "M_FORBIDDEN",
			message: "You are not invited to this room.",
		});
		fireEvent.input(addressInput(), {
			target: { value: "!private:example.org example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toBe(
			"That room isn't open to join. Ask a member to invite you.",
		);
		// The catch path restores focus to the input.
		expect(document.activeElement).toBe(addressInput());
	});

	it("maps M_LIMIT_EXCEEDED to a rate-limit message", async () => {
		const { client } = setup();
		client.joinRoom.mockRejectedValueOnce({
			errcode: "M_LIMIT_EXCEEDED",
			message: "Too Many Requests",
		});
		fireEvent.input(addressInput(), {
			target: { value: "#general:example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toBe(
			"You're being rate-limited. Wait a moment, then try again.",
		);
	});

	it("keeps a human-readable server message from an Error instance", async () => {
		const { client } = setup();
		client.joinRoom.mockRejectedValueOnce(
			new Error("Homeserver is over capacity, try later"),
		);
		fireEvent.input(addressInput(), {
			target: { value: "#general:example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toBe(
			"Homeserver is over capacity, try later",
		);
	});

	it("swaps network jargon for the curated fallback", async () => {
		const { client } = setup();
		client.joinRoom.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		fireEvent.input(addressInput(), {
			target: { value: "#general:example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toBe(
			"Couldn't join the room. Please try again.",
		);
	});

	it("keeps the submit button disabled while the join is in flight", async () => {
		const { client } = setup();
		let resolveJoin: ((value: { roomId: string }) => void) | undefined;
		client.joinRoom.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveJoin = resolve;
				}),
		);
		fireEvent.input(addressInput(), {
			target: { value: "#general:example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		const joinButton = screen.getByRole("button", {
			name: /^Joining…$/i,
		}) as HTMLButtonElement;
		expect(joinButton.disabled).toBe(true);
		expect(addressInput().disabled).toBe(true);
		expect(client.joinRoom).toHaveBeenCalledOnce();

		resolveJoin?.({ roomId: JOINED_ID });
		await waitFor(() =>
			expect(navigateMock).toHaveBeenCalledWith(
				`/home/${encodeURIComponent(JOINED_ID)}`,
			),
		);
	});

	it("blocks Escape and backdrop close while the join is in flight", async () => {
		const { client, onClose } = setup();
		let resolveJoin: ((value: { roomId: string }) => void) | undefined;
		client.joinRoom.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveJoin = resolve;
				}),
		);
		fireEvent.input(addressInput(), {
			target: { value: "#general:example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));
		await screen.findByRole("button", { name: /^Joining…$/i });

		const dialog = screen.getByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		// Backdrop click: target === currentTarget on the overlay.
		fireEvent.click(dialog);
		expect(onClose).not.toHaveBeenCalled();

		// The successful join still closes the dialog itself.
		resolveJoin?.({ roomId: JOINED_ID });
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	});

	it("commits nothing when the parent closes the dialog mid-flight", async () => {
		const { client, setOpen } = setup();
		let resolveJoin: ((value: { roomId: string }) => void) | undefined;
		client.joinRoom.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveJoin = resolve;
				}),
		);
		fireEvent.input(addressInput(), {
			target: { value: "#general:example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));
		await screen.findByRole("button", { name: /^Joining…$/i });

		// Parent-driven close (route change, etc.): tryClose is blocked while
		// submitting, so this is the only way the dialog can go away mid-join.
		setOpen(false);
		resolveJoin?.({ roomId: JOINED_ID });
		// Settle the microtask-only continuation chain (no timers involved).
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(navigateMock).not.toHaveBeenCalled();
		expect(optimisticallyMarkJoined).not.toHaveBeenCalled();
	});

	it("closes on backdrop click without joining", async () => {
		const { client, onClose } = setup();
		// Backdrop click: target === currentTarget on the overlay.
		fireEvent.click(screen.getByRole("dialog"));
		expect(onClose).toHaveBeenCalledOnce();
		expect(client.joinRoom).not.toHaveBeenCalled();
	});

	it("closes on Cancel without joining", async () => {
		const { client, onClose } = setup();
		fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(client.joinRoom).not.toHaveBeenCalled();
	});

	it("clears the error when the user edits the address", async () => {
		setup();
		fireEvent.input(addressInput(), { target: { value: "general" } });
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));
		await screen.findByRole("alert");

		fireEvent.input(addressInput(), { target: { value: "#g" } });
		expect(screen.queryByRole("alert")).toBeNull();
		expect(addressInput().getAttribute("aria-invalid")).toBeNull();
	});

	it("closes on Escape without joining", async () => {
		const { client, onClose } = setup();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
		expect(client.joinRoom).not.toHaveBeenCalled();
	});

	it("focuses the address input on open", async () => {
		setup();
		await waitFor(() => expect(document.activeElement).toBe(addressInput()));
	});

	it("restores focus to the pre-open element on close", async () => {
		const { setOpen, trigger } = setupWithTrigger();
		trigger().focus();
		expect(document.activeElement).toBe(trigger());

		setOpen(true);
		await waitFor(() => expect(document.activeElement).toBe(addressInput()));

		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		await waitFor(() => expect(document.activeElement).toBe(trigger()));
	});

	it("keeps Tab cycling inside the dialog", async () => {
		setup();
		await waitFor(() => expect(document.activeElement).toBe(addressInput()));
		// jsdom has no layout engine, so offsetParent is always null and
		// trapTabKey's visibility filter would drop every candidate. Force
		// the dialog's focusable elements visible (same trick as
		// focusTrap.test.ts).
		const dialog = screen.getByRole("dialog");
		for (const el of dialog.querySelectorAll("button, input")) {
			Object.defineProperty(el, "offsetParent", {
				configurable: true,
				get: () => document.body,
			});
		}

		// Focus order: input -> Cancel -> Join. Tab on the last wraps to first.
		const joinButton = screen.getByRole("button", { name: /^Join$/i });
		joinButton.focus();
		expect(document.activeElement).toBe(joinButton);
		fireEvent.keyDown(dialog, { key: "Tab" });
		expect(document.activeElement).toBe(addressInput());

		// Shift+Tab on the first wraps to last.
		fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(joinButton);
	});
});

describe("JoinRoomDialog prefill", () => {
	function setupPrefill(prefill: () => JoinAddress | null) {
		const client = createMockClient();
		const [open, setOpen] = createSignal(true);
		const onClose = vi.fn(() => setOpen(false));
		render(() => (
			<Wrapper client={client}>
				<JoinRoomDialog
					client={client as unknown as MatrixClient}
					open={open}
					onClose={onClose}
					prefill={prefill}
				/>
			</Wrapper>
		));
		return { client, setOpen, onClose };
	}

	it("prefills the address input on open and joins with the parsed via servers", async () => {
		const { client, onClose } = setupPrefill(() => ({
			idOrAlias: "!linked:example.org",
			viaServers: ["one.org"],
		}));
		expect(addressInput().value).toBe("!linked:example.org one.org");

		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(client.joinRoom).toHaveBeenCalledWith("!linked:example.org", {
			viaServers: ["one.org"],
		});
	});

	it("starts empty when the prefill returns null", () => {
		setupPrefill(() => null);
		expect(addressInput().value).toBe("");
	});

	it("does not carry a stale prefill into a later open", async () => {
		let address: JoinAddress | null = {
			idOrAlias: "#linked:example.org",
			viaServers: [],
		};
		const { setOpen } = setupPrefill(() => address);
		expect(addressInput().value).toBe("#linked:example.org");

		// Close, clear the prefill (as JoinRoomDialogHost's close does), reopen.
		fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
		address = null;
		setOpen(true);
		await waitFor(() => expect(addressInput().value).toBe(""));
	});
});

describe("describeJoinError", () => {
	it("maps the known errcodes", () => {
		expect(describeJoinError({ errcode: "M_NOT_FOUND" })).toBe(
			"Couldn't find a room at that address. Check the address and try again.",
		);
		expect(describeJoinError({ errcode: "M_FORBIDDEN" })).toBe(
			"That room isn't open to join. Ask a member to invite you.",
		);
		expect(describeJoinError({ errcode: "M_LIMIT_EXCEEDED" })).toBe(
			"You're being rate-limited. Wait a moment, then try again.",
		);
	});

	it("keeps human-readable messages from Error instances", () => {
		expect(describeJoinError(new Error("Invalid address"))).toBe(
			"Invalid address",
		);
	});

	it("swaps browser jargon for the curated fallback", () => {
		const fallback = "Couldn't join the room. Please try again.";
		expect(describeJoinError(new TypeError("Failed to fetch"))).toBe(fallback);
		expect(describeJoinError(new DOMException("aborted", "AbortError"))).toBe(
			fallback,
		);
	});

	it("falls back for non-Error values and unknown errcodes", () => {
		const fallback = "Couldn't join the room. Please try again.";
		expect(describeJoinError(null)).toBe(fallback);
		expect(describeJoinError({ errcode: "M_UNKNOWN" })).toBe(fallback);
	});
});
