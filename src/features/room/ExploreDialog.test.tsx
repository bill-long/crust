import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import type { IPublicRoomsChunkRoom, MatrixClient } from "matrix-js-sdk";
import { createSignal, type JSX, type ParentComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import {
	createSummariesStore,
	type RoomSummary,
	type SummariesStore,
} from "../../client/summaries";
import {
	_resetJoinDialogForTests,
	joinDialogRequest,
} from "../../stores/joinDialog";
import { createMockClient } from "../../test/mockClient";
import { ExploreDialog } from "./ExploreDialog";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// virtua's Virtualizer requires real layout measurements (ResizeObserver +
// non-zero element sizes) that jsdom doesn't provide. Substitute the same
// transparent renderer the MembersTab tests use so every row mounts.
vi.mock("virtua/solid", async () => {
	const solid = await import("solid-js");
	return {
		Virtualizer: <T,>(props: {
			data: T[];
			children: (item: T, index: number) => unknown;
		}) =>
			solid.createComponent(solid.For, {
				get each() {
					return props.data;
				},
				children: (item: T) => props.children(item, 0) as JSX.Element,
			}),
	};
});

const navigateMock = vi.fn();
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
}));

const optimisticallyMarkJoined = vi.fn();

const Wrapper: ParentComponent<{
	client: ReturnType<typeof createMockClient>;
	seed?: RoomSummary[];
}> = (props) => {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const store = createSummariesStore(props.client as unknown as MatrixClient);
	for (const s of props.seed ?? []) store.setSummaries(s.roomId, s);
	return (
		<ClientContext.Provider
			value={{
				client: props.client as unknown as MatrixClient,
				syncState,
				cryptoState,
				summaries: store.summaries as unknown as SummariesStore,
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
				optimisticallyMarkKnocked: vi.fn(),
				optimisticallyMarkLeft: vi.fn(),
				optimisticallySetMarkedUnread: vi.fn(),
				optimisticallySetRoomTag: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

function makeChunk(
	roomId: string,
	name: string,
	overrides: Partial<IPublicRoomsChunkRoom> = {},
): IPublicRoomsChunkRoom {
	return {
		room_id: roomId,
		name,
		world_readable: false,
		guest_can_join: false,
		num_joined_members: 42,
		...overrides,
	};
}

// Implicit-submission helper: fires the dialog's search form the way the
// JoinRoomDialog tests do (querySelector + truthy assert, no non-null
// assertion).
function searchForm(): HTMLFormElement {
	const form = screen.getByRole("dialog").querySelector("form");
	expect(form).toBeTruthy();
	return form as HTMLFormElement;
}

function setup(
	open = true,
	configure?: (client: ReturnType<typeof createMockClient>) => void,
	seed: RoomSummary[] = [],
) {
	const client = createMockClient();
	// Configure BEFORE render: the dialog fires its initial directory
	// search in the mount effect.
	configure?.(client);
	const onClose = vi.fn();
	// Reactive open state mirroring the real store-driven host, so
	// close-path behavior (and post-close continuation guards) is real.
	const [isOpen, setIsOpen] = createSignal(open);
	render(() => (
		<Wrapper client={client} seed={seed}>
			<ExploreDialog
				open={isOpen}
				onClose={() => {
					onClose();
					setIsOpen(false);
				}}
			/>
		</Wrapper>
	));
	return { client, onClose };
}

afterEach(() => {
	cleanup();
	navigateMock.mockReset();
	optimisticallyMarkJoined.mockReset();
	_resetJoinDialogForTests();
});

describe("ExploreDialog", () => {
	it("loads the server's default directory listing on open", async () => {
		const { client } = setup(true, (c) => {
			c.publicRooms.mockResolvedValue({
				chunk: [makeChunk("!a:example.com", "alpha")],
			});
		});
		await waitFor(() => expect(client.publicRooms).toHaveBeenCalled());
		expect(client.publicRooms).toHaveBeenCalledWith({
			server: undefined,
			limit: 20,
			filter: undefined,
		});
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		expect(screen.getByText("42 members")).toBeTruthy();
	});

	it("searches with the entered term and server", async () => {
		const { client } = setup(true, (c) => {
			c.publicRooms.mockResolvedValue({ chunk: [] });
		});
		await waitFor(() => expect(client.publicRooms).toHaveBeenCalled());
		fireEvent.input(screen.getByPlaceholderText("Search rooms"), {
			target: { value: "oasis" },
		});
		fireEvent.input(screen.getByPlaceholderText("Server (optional)"), {
			target: { value: "matrix.org" },
		});
		fireEvent.submit(searchForm());
		await waitFor(() =>
			expect(client.publicRooms).toHaveBeenCalledWith({
				server: "matrix.org",
				limit: 20,
				filter: { generic_search_term: "oasis" },
			}),
		);
	});

	it("paginates with Load more using the next batch token", async () => {
		const { client } = setup(true, (c) => {
			c.publicRooms
				.mockResolvedValueOnce({
					chunk: [makeChunk("!a:example.com", "alpha")],
					next_batch: "page2",
				})
				.mockResolvedValueOnce({
					chunk: [makeChunk("!b:example.com", "beta")],
				});
		});
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.click(screen.getByText("Load more rooms"));
		await waitFor(() => expect(screen.getByText("beta")).toBeTruthy());
		expect(client.publicRooms).toHaveBeenLastCalledWith(
			expect.objectContaining({ since: "page2" }),
		);
		expect(screen.getByText("alpha")).toBeTruthy();
	});

	it("joins a room, stubs the summary, navigates, and closes", async () => {
		const { client, onClose } = setup(true, (c) => {
			c.publicRooms.mockResolvedValue({
				chunk: [
					makeChunk("!a:example.com", "alpha", {
						canonical_alias: "#alpha:example.com",
					}),
				],
			});
		});
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Join alpha" }));
		// Alias entries join by alias (self-resolving, no via needed).
		await waitFor(() =>
			expect(client.joinRoom).toHaveBeenCalledWith("#alpha:example.com", {
				viaServers: [],
			}),
		);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(optimisticallyMarkJoined).toHaveBeenCalledWith("!a:example.com", {
			name: "alpha",
			avatarUrl: null,
			isSpace: false,
		});
		expect(navigateMock).toHaveBeenCalledWith(
			`/home/${encodeURIComponent("!a:example.com")}`,
		);
	});

	it("joins alias-less entries by room ID through the directory server", async () => {
		const { client } = setup(true, (c) => {
			c.publicRooms.mockResolvedValue({
				chunk: [makeChunk("!r:remote.example", "remote room")],
			});
		});
		await waitFor(() => expect(screen.getByText("remote room")).toBeTruthy());
		// Browse a remote directory, then join: the queried server is the
		// via server (it's necessarily in the room it lists).
		fireEvent.input(screen.getByPlaceholderText("Server (optional)"), {
			target: { value: "remote.example" },
		});
		fireEvent.submit(searchForm());
		await waitFor(() =>
			expect(client.publicRooms).toHaveBeenLastCalledWith(
				expect.objectContaining({ server: "remote.example" }),
			),
		);
		fireEvent.click(screen.getByRole("button", { name: "Join remote room" }));
		await waitFor(() =>
			expect(client.joinRoom).toHaveBeenCalledWith("!r:remote.example", {
				viaServers: ["remote.example"],
			}),
		);
	});

	it("normalizes a non-mxc avatar_url to null in the summary stub", async () => {
		const { client } = setup(true, (c) => {
			c.publicRooms.mockResolvedValue({
				chunk: [makeChunk("!a:example.com", "alpha")],
			});
			// The real mxcUrlToHttp returns "" for non-mxc input; the mock
			// passes input through, so override it for this contract test.
			(c as unknown as { mxcUrlToHttp: () => string }).mxcUrlToHttp = () => "";
		});
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		// Force the row's avatar_url down the present-but-not-mxc path.
		client.publicRooms.mockResolvedValue({
			chunk: [
				makeChunk("!a:example.com", "alpha", {
					avatar_url: "not-an-mxc-url",
				}),
			],
		});
		fireEvent.submit(searchForm());
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Join alpha" })).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Join alpha" }));
		await waitFor(() =>
			expect(optimisticallyMarkJoined).toHaveBeenCalledWith(
				"!a:example.com",
				expect.objectContaining({ avatarUrl: null }),
			),
		);
	});

	it("navigates space results to the space route", async () => {
		setup(true, (c) => {
			c.publicRooms.mockResolvedValue({
				chunk: [
					makeChunk("!s:example.com", "my space", { room_type: "m.space" }),
				],
			});
		});
		await waitFor(() => expect(screen.getByText("my space")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Join my space" }));
		await waitFor(() =>
			expect(navigateMock).toHaveBeenCalledWith(
				`/space/${encodeURIComponent("!s:example.com")}`,
			),
		);
		expect(optimisticallyMarkJoined).toHaveBeenCalledWith("!s:example.com", {
			name: "my space",
			avatarUrl: null,
			isSpace: true,
		});
	});

	it("delegates a forbidden join to the join dialog's knock flow", async () => {
		const { onClose } = setup(true, (c) => {
			c.publicRooms.mockResolvedValue({
				chunk: [
					makeChunk("!k:example.com", "knockable", {
						canonical_alias: "#knockable:example.com",
					}),
				],
			});
			c.joinRoom.mockRejectedValue({ errcode: "M_FORBIDDEN" });
		});
		await waitFor(() => expect(screen.getByText("knockable")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Join knockable" }));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(joinDialogRequest()).toEqual({
			prefill: {
				idOrAlias: "#knockable:example.com",
				viaServers: [],
			},
			knockOffered: true,
		});
	});

	it("offers Retry after a failed join", async () => {
		const { onClose } = setup(true, (c) => {
			c.publicRooms.mockResolvedValue({
				chunk: [makeChunk("!a:example.com", "alpha")],
			});
			c.joinRoom.mockRejectedValueOnce(new Error("M_LIMIT_EXCEEDED"));
		});
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Join alpha" }));
		await waitFor(() => expect(screen.getByText("Retry")).toBeTruthy());
		expect(onClose).not.toHaveBeenCalled();
	});

	it("surfaces a directory load failure inline", async () => {
		setup(true, (c) => {
			c.publicRooms.mockRejectedValue(new Error("M_UNKNOWN: nope"));
		});
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("nope"),
		);
	});

	it("shows the curated fallback for browser-jargon load failures", async () => {
		setup(true, (c) => {
			c.publicRooms.mockRejectedValue(new TypeError("Failed to fetch"));
		});
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				"Couldn't load the room directory. Please try again.",
			),
		);
	});

	it("focuses the search input on open", async () => {
		setup(true, (c) => {
			c.publicRooms.mockResolvedValue({ chunk: [] });
		});
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByPlaceholderText("Search rooms"),
			),
		);
	});

	it("restores focus to the pre-open element on close", async () => {
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);
		trigger.focus();
		try {
			setup(true, (c) => {
				c.publicRooms.mockResolvedValue({ chunk: [] });
			});
			// Opening captured the trigger as previousFocus and moved focus
			// into the dialog.
			await waitFor(() =>
				expect(document.activeElement).toBe(
					screen.getByPlaceholderText("Search rooms"),
				),
			);
			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			await waitFor(() => expect(document.activeElement).toBe(trigger));
		} finally {
			trigger.remove();
		}
	});

	it("closes via Close button, backdrop click, and Escape", async () => {
		const configure = (c: ReturnType<typeof createMockClient>) => {
			c.publicRooms.mockResolvedValue({ chunk: [] });
		};

		const first = setup(true, configure);
		await waitFor(() =>
			expect(screen.getByText("No rooms found")).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(first.onClose).toHaveBeenCalledTimes(1);
		cleanup();

		const second = setup(true, configure);
		await waitFor(() =>
			expect(screen.getByText("No rooms found")).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("dialog"));
		expect(second.onClose).toHaveBeenCalledTimes(1);
		cleanup();

		const third = setup(true, configure);
		await waitFor(() =>
			expect(screen.getByText("No rooms found")).toBeTruthy(),
		);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(third.onClose).toHaveBeenCalledTimes(1);
	});

	it("shows the alias, topic, and space arms of a row", async () => {
		setup(true, (c) => {
			c.publicRooms.mockResolvedValue({
				chunk: [
					makeChunk("!s:example.com", "The Oasis", {
						canonical_alias: "#oasis:example.com",
						topic: "A quiet place",
						room_type: "m.space",
					}),
				],
			});
		});
		await waitFor(() => expect(screen.getByText("The Oasis")).toBeTruthy());
		expect(screen.getByText("#oasis:example.com")).toBeTruthy();
		expect(screen.getByText("A quiet place")).toBeTruthy();
		expect(screen.getByRole("img", { name: "Space" })).toBeTruthy();
	});

	it("labels already-joined rooms instead of offering Join", async () => {
		setup(
			true,
			(c) => {
				c.publicRooms.mockResolvedValue({
					chunk: [makeChunk("!a:example.com", "alpha")],
				});
			},
			[
				{
					roomId: "!a:example.com",
					name: "alpha",
					avatarUrl: null,
					lastMessage: null,
					unreadCount: 0,
					highlightCount: 0,
					markedUnread: false,
					isFavourite: false,
					isLowPriority: false,
					membership: "join",
					isEncrypted: false,
					isDirect: false,
					isSpace: false,
					kind: "text",
					callActive: false,
					children: [],
				},
			],
		);
		await waitFor(() => expect(screen.getByText("Joined")).toBeTruthy());
		expect(screen.queryByRole("button", { name: "Join alpha" })).toBeNull();
	});

	it("does not navigate when the dialog is dismissed mid-join", async () => {
		let resolveJoin!: (v: { roomId: string }) => void;
		const { client, onClose } = setup(true, (c) => {
			c.publicRooms.mockResolvedValue({
				chunk: [makeChunk("!a:example.com", "alpha")],
			});
			c.joinRoom.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveJoin = resolve;
					}),
			);
		});
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Join alpha" }));
		await waitFor(() => expect(client.joinRoom).toHaveBeenCalled());

		// Escape mid-join: the dialog closes, and the late join
		// continuation must not navigate or re-close anything.
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
		resolveJoin({ roomId: "!a:example.com" });
		// Awaiting the same join promise flushes the component's
		// continuation (attached before this await) deterministically.
		await client.joinRoom.mock.results[0].value;
		expect(navigateMock).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(optimisticallyMarkJoined).not.toHaveBeenCalled();
	});

	it("does not leave Load more stuck when a new search supersedes it", async () => {
		let resolveMore!: (v: { chunk: IPublicRoomsChunkRoom[] }) => void;
		setup(true, (c) => {
			c.publicRooms
				.mockResolvedValueOnce({
					chunk: [makeChunk("!a:example.com", "alpha")],
					next_batch: "page2",
				})
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							resolveMore = resolve;
						}),
				)
				.mockResolvedValue({
					chunk: [makeChunk("!b:example.com", "beta")],
					next_batch: "page3",
				});
		});
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.click(screen.getByText("Load more rooms"));
		// Supersede the in-flight load-more with a fresh search.
		fireEvent.input(screen.getByPlaceholderText("Search rooms"), {
			target: { value: "beta" },
		});
		fireEvent.submit(searchForm());
		resolveMore({ chunk: [] });
		await waitFor(() => expect(screen.getByText("beta")).toBeTruthy());
		// The fresh search's own next page is offered, enabled.
		const button = screen.getByText("Load more rooms");
		expect(button).toBeTruthy();
		expect((button as HTMLButtonElement).disabled).toBe(false);
	});

	it("clears a superseded join's row state on a new search", async () => {
		let resolveJoin!: (v: { roomId: string }) => void;
		const { client } = setup(true, (c) => {
			c.publicRooms.mockResolvedValue({
				chunk: [makeChunk("!a:example.com", "alpha")],
			});
			c.joinRoom.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveJoin = resolve;
					}),
			);
		});
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Join alpha" }));
		// The aria-label is constant; the join state shows in the label text.
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Join alpha" }).textContent,
			).toBe("Joining…"),
		);

		// Supersede the in-flight join with a fresh search returning the
		// same room: the stale "Joining…" state must not leak across.
		fireEvent.input(screen.getByPlaceholderText("Search rooms"), {
			target: { value: "alpha" },
		});
		fireEvent.submit(searchForm());
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Join alpha" }).textContent,
			).toBe("Join"),
		);

		// The late join continuation bails on the generation bump: no stub,
		// no navigation.
		resolveJoin({ roomId: "!a:example.com" });
		await client.joinRoom.mock.results[0].value;
		expect(optimisticallyMarkJoined).not.toHaveBeenCalled();
		expect(navigateMock).not.toHaveBeenCalled();
	});
});
