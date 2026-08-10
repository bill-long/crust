import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import type { IPublicRoomsChunkRoom, MatrixClient } from "matrix-js-sdk";
import { createSignal, type ParentComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import {
	createSummariesStore,
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
	const store = createSummariesStore(props.client as unknown as MatrixClient);
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

function setup(
	open = true,
	configure?: (client: ReturnType<typeof createMockClient>) => void,
) {
	const client = createMockClient();
	// Configure BEFORE render: the dialog fires its initial directory
	// search in the mount effect.
	configure?.(client);
	const onClose = vi.fn();
	render(() => (
		<Wrapper client={client}>
			<ExploreDialog open={() => open} onClose={onClose} />
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
		fireEvent.submit(
			screen.getByRole("button", { name: "Search" }).closest("form")!,
		);
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
		await waitFor(() =>
			expect(client.joinRoom).toHaveBeenCalledWith("!a:example.com", {
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

	it("navigates space results to the space route", async () => {
		const { client } = setup(true, (c) => {
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
		const { client, onClose } = setup(true, (c) => {
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
		const { client, onClose } = setup(true, (c) => {
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
});
