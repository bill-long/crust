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
import { clearNotices, notices } from "../../stores/notices";
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
const optimisticallyMarkKnocked = vi.fn();

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
				optimisticallyMarkKnocked,
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
	optimisticallyMarkKnocked.mockReset();
	clearNotices();
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

	it("offers the knock path (not the invite-only alert) after M_FORBIDDEN", async () => {
		const { client } = setup();
		client.joinRoom.mockRejectedValueOnce({
			errcode: "M_FORBIDDEN",
			message: "You are not invited to this room.",
		});
		fireEvent.input(addressInput(), {
			target: { value: "!private:example.org example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));

		// #442: a forbidden join may be a knock-rule room, so the dialog
		// offers Request to join instead of the plain error alert. The
		// invite-only text only appears if the knock itself 403s (see the
		// knock-offer suite below).
		await screen.findByRole("button", { name: /^Request to join$/i });
		expect(screen.queryByRole("alert")).toBeNull();
		// Focus lands on the offer's first control (the reason input), not
		// the void left by the unmounted Join button.
		expect(document.activeElement).toBe(
			screen.getByLabelText(/^Reason \(optional\)$/i),
		);
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

describe("JoinRoomDialog knock offer (#442)", () => {
	const FORBIDDEN = { errcode: "M_FORBIDDEN" };

	async function reachKnockOffer(address: string) {
		const { client, setOpen, onClose } = setup();
		client.joinRoom.mockRejectedValue(FORBIDDEN);
		fireEvent.input(addressInput(), { target: { value: address } });
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /^Request to join$/i }),
			).toBeTruthy(),
		);
		return { client, setOpen, onClose };
	}

	it("offers Request to join (with an optional reason) after a forbidden join", async () => {
		await reachKnockOffer("!restricted:example.org");
		// The offer replaces the plain error + Join button.
		expect(screen.getByLabelText(/^Reason \(optional\)$/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^Join$/i })).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("sends the knock with reason and via servers, marks knocked, toasts, and closes", async () => {
		const { client, onClose } = await reachKnockOffer(
			"!restricted:example.org one.org",
		);
		fireEvent.input(screen.getByLabelText(/^Reason \(optional\)$/i), {
			target: { value: "  let me in  " },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Request to join$/i }));

		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(client.knockRoom).toHaveBeenCalledWith("!restricted:example.org", {
			reason: "let me in",
			viaServers: ["one.org"],
		});
		expect(optimisticallyMarkKnocked).toHaveBeenCalledWith(
			"!knocked:example.com",
			{ name: "!restricted:example.org", avatarUrl: null },
		);
		expect(notices().some((n) => n.message === "Request to join sent.")).toBe(
			true,
		);
	});

	it("omits the reason when left blank", async () => {
		const { client, onClose } = await reachKnockOffer(
			"!restricted:example.org",
		);
		fireEvent.click(screen.getByRole("button", { name: /^Request to join$/i }));
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(client.knockRoom).toHaveBeenCalledWith("!restricted:example.org", {
			reason: undefined,
			viaServers: [],
		});
	});

	it("drops the offer and shows invite-only when the knock itself is forbidden", async () => {
		const { client } = await reachKnockOffer("!restricted:example.org");
		client.knockRoom.mockRejectedValue(FORBIDDEN);
		fireEvent.click(screen.getByRole("button", { name: /^Request to join$/i }));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				"That room isn't open to join. Ask a member to invite you.",
			),
		);
		expect(
			screen.queryByRole("button", { name: /^Request to join$/i }),
		).toBeNull();
		expect(optimisticallyMarkKnocked).not.toHaveBeenCalled();
	});

	it("shows a curated error when the knock fails for another reason", async () => {
		const { client } = await reachKnockOffer("!restricted:example.org");
		client.knockRoom.mockRejectedValue(new TypeError("Failed to fetch"));
		fireEvent.click(screen.getByRole("button", { name: /^Request to join$/i }));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				"Couldn't send the join request. Please try again.",
			),
		);
	});

	it("editing the address after the offer hides it", async () => {
		await reachKnockOffer("!restricted:example.org");
		fireEvent.input(addressInput(), {
			target: { value: "!other:example.org" },
		});
		expect(
			screen.queryByRole("button", { name: /^Request to join$/i }),
		).toBeNull();
		expect(screen.getByRole("button", { name: /^Join$/i })).toBeTruthy();
	});

	it("clears the typed reason when editing the address dismisses the offer", async () => {
		const { client } = await reachKnockOffer("!restricted:example.org");
		fireEvent.input(screen.getByLabelText(/^Reason \(optional\)$/i), {
			target: { value: "my reason" },
		});
		// Dismiss the offer by editing the address...
		fireEvent.input(addressInput(), {
			target: { value: "!other:example.org" },
		});
		// ...then re-trigger it for the new address: the reason must not
		// leak across rooms.
		client.joinRoom.mockRejectedValue({ errcode: "M_FORBIDDEN" });
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));
		await screen.findByRole("button", { name: /^Request to join$/i });
		expect(
			(screen.getByLabelText(/^Reason \(optional\)$/i) as HTMLInputElement)
				.value,
		).toBe("");
	});

	it("does not offer a knock for non-forbidden join failures", async () => {
		const { client } = setup();
		client.joinRoom.mockRejectedValue({ errcode: "M_NOT_FOUND" });
		fireEvent.input(addressInput(), {
			target: { value: "!missing:example.org" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^Join$/i }));
		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		expect(
			screen.queryByRole("button", { name: /^Request to join$/i }),
		).toBeNull();
	});

	it("Enter in the reason input sends the knock", async () => {
		const { client, onClose } = await reachKnockOffer(
			"!restricted:example.org",
		);
		// Implicit submission: the form's submit event routes to the knock
		// while the offer is engaged (the Join submit button is unmounted).
		const form = screen.getByRole("dialog").querySelector("form");
		expect(form).toBeTruthy();
		fireEvent.submit(form as HTMLFormElement);

		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(client.knockRoom).toHaveBeenCalledWith("!restricted:example.org", {
			reason: undefined,
			viaServers: [],
		});
		expect(client.joinRoom).toHaveBeenCalledTimes(1); // the original 403
	});

	it("keeps the Request button disabled and labelled Sending… while the knock is in flight", async () => {
		const { client, onClose } = await reachKnockOffer(
			"!restricted:example.org",
		);
		let resolveKnock: ((value: { room_id: string }) => void) | undefined;
		client.knockRoom.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveKnock = resolve;
				}),
		);
		fireEvent.click(screen.getByRole("button", { name: /^Request to join$/i }));

		const button = screen.getByRole("button", {
			name: /^Sending…$/i,
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(
			(screen.getByLabelText(/^Reason \(optional\)$/i) as HTMLInputElement)
				.disabled,
		).toBe(true);
		expect(addressInput().disabled).toBe(true);

		resolveKnock?.({ room_id: "!knocked:example.com" });
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	});

	it("blocks Escape and backdrop close while the knock is in flight", async () => {
		const { client, onClose } = await reachKnockOffer(
			"!restricted:example.org",
		);
		let resolveKnock: ((value: { room_id: string }) => void) | undefined;
		client.knockRoom.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveKnock = resolve;
				}),
		);
		fireEvent.click(screen.getByRole("button", { name: /^Request to join$/i }));
		await screen.findByRole("button", { name: /^Sending…$/i });

		const dialog = screen.getByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		fireEvent.click(dialog); // backdrop: target === currentTarget
		expect(onClose).not.toHaveBeenCalled();

		resolveKnock?.({ room_id: "!knocked:example.com" });
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	});

	it("commits nothing when the parent closes the dialog mid-knock", async () => {
		const { client, setOpen, onClose } = await reachKnockOffer(
			"!restricted:example.org",
		);
		let resolveKnock: ((value: { room_id: string }) => void) | undefined;
		client.knockRoom.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveKnock = resolve;
				}),
		);
		fireEvent.click(screen.getByRole("button", { name: /^Request to join$/i }));
		await screen.findByRole("button", { name: /^Sending…$/i });

		// Parent-driven close (route change, etc.): tryClose is blocked
		// while submitting, so this is the only way out mid-knock.
		setOpen(false);
		resolveKnock?.({ room_id: "!knocked:example.com" });
		// Settle the microtask-only continuation chain (no timers involved).
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(optimisticallyMarkKnocked).not.toHaveBeenCalled();
		expect(notices()).toEqual([]);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("opens with the knock offer pre-engaged (space discovery Request button)", async () => {
		const client = createMockClient();
		const [open, setOpen] = createSignal(false);
		const onClose = vi.fn(() => setOpen(false));
		render(() => (
			<Wrapper client={client}>
				<JoinRoomDialog
					client={client as unknown as MatrixClient}
					open={open}
					onClose={onClose}
					prefill={() => ({
						idOrAlias: "!restricted:example.org",
						viaServers: ["one.org"],
					})}
					knockOffered={() => true}
				/>
			</Wrapper>
		));

		setOpen(true);
		// Offer is immediately visible - no doomed join attempt first.
		await screen.findByRole("button", { name: /^Request to join$/i });
		expect(client.joinRoom).not.toHaveBeenCalled();
		expect(addressInput().value).toBe("!restricted:example.org one.org");
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByLabelText(/^Reason \(optional\)$/i),
			),
		);

		fireEvent.click(screen.getByRole("button", { name: /^Request to join$/i }));
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(client.knockRoom).toHaveBeenCalledWith("!restricted:example.org", {
			reason: undefined,
			viaServers: ["one.org"],
		});
	});

	it("restores focus to the address input when the knock itself is forbidden", async () => {
		const { client } = await reachKnockOffer("!restricted:example.org");
		client.knockRoom.mockRejectedValue({ errcode: "M_FORBIDDEN" });
		fireEvent.click(screen.getByRole("button", { name: /^Request to join$/i }));

		await screen.findByRole("alert");
		// The focused Request button unmounted with the offer; focus lands
		// back on the address input rather than <body>.
		expect(document.activeElement).toBe(addressInput());
	});

	it("restores focus to the reason input after a non-forbidden knock failure", async () => {
		const { client } = await reachKnockOffer("!restricted:example.org");
		client.knockRoom.mockRejectedValue(new TypeError("Failed to fetch"));
		fireEvent.click(screen.getByRole("button", { name: /^Request to join$/i }));

		await screen.findByRole("alert");
		expect(document.activeElement).toBe(
			screen.getByLabelText(/^Reason \(optional\)$/i),
		);
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
