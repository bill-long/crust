import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, type ParentComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import type { SummariesStore } from "../../client/summaries";
import {
	_resetJoinDialogForTests,
	joinDialogRequest,
} from "../../stores/joinDialog";
import { clearNotices } from "../../stores/notices";
import { findJoinedRoomId, PermalinkRouting } from "./PermalinkRouting";
import { closeProfileCard, profileCardRequest } from "./profile/profileCard";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const navigateMock = vi.fn();
// Controllable location: tests set `locationState.pathname` before clicking.
const locationState = { pathname: "/home" };
// Controllable route params (useDecodedParams wraps useParams): tests set
// `paramsState.roomId` to simulate viewing a room.
const paramsState: { roomId?: string } = {};
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
	useLocation: () => locationState,
	useParams: () => paramsState,
}));

const optimisticallyMarkJoined = vi.fn();

type Membership = "join" | "invite" | "leave";

function makeRoomStub(
	roomId: string,
	opts: {
		membership?: Membership;
		canonicalAlias?: string | null;
		altAliases?: string[];
	} = {},
) {
	return {
		roomId,
		getMyMembership: () => opts.membership ?? "join",
		getCanonicalAlias: () => opts.canonicalAlias ?? null,
		getAltAliases: () => opts.altAliases ?? [],
	};
}

interface FakeClientOptions {
	rooms?: ReturnType<typeof makeRoomStub>[];
	createdRoomId?: string;
	/** m.direct content: userId -> room IDs (drives the existing-DM fast path). */
	direct?: Record<string, string[]>;
	failCreateRoom?: boolean;
}

function makeClient(opts: FakeClientOptions = {}) {
	const rooms = opts.rooms ?? [];
	const createRoom = vi.fn(async () => {
		if (opts.failCreateRoom) throw new Error("M_UNKNOWN: cannot create");
		return { room_id: opts.createdRoomId ?? "!created:example.com" };
	});
	const setAccountData = vi.fn(async () => ({}));
	const client = {
		getUserId: () => "@test:example.com",
		getRoom: (roomId: string) => rooms.find((r) => r.roomId === roomId) ?? null,
		getRooms: () => rooms,
		getAccountData: (type: string) =>
			type === "m.direct" && opts.direct
				? { getContent: () => opts.direct }
				: null,
		createRoom,
		setAccountData,
	} as unknown as MatrixClient;
	return { client, createRoom };
}

const Wrapper: ParentComponent<{
	client: MatrixClient;
	summaries?: Record<string, unknown>;
}> = (props) => {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	return (
		<ClientContext.Provider
			value={{
				client: props.client,
				syncState,
				cryptoState,
				summaries: (props.summaries ?? {}) as unknown as SummariesStore,
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

afterEach(() => {
	cleanup();
	navigateMock.mockReset();
	optimisticallyMarkJoined.mockReset();
	_resetJoinDialogForTests();
	clearNotices();
	closeProfileCard();
	locationState.pathname = "/home";
	paramsState.roomId = undefined;
});

/** Render the router plus one anchor, then dispatch a real (cancelable) click. */
function clickLink(
	client: MatrixClient,
	href: string,
	clickInit: MouseEventInit = {},
	summaries?: Record<string, unknown>,
): MouseEvent {
	render(() => (
		<Wrapper client={client} summaries={summaries}>
			<PermalinkRouting />
			<a href={href}>the link</a>
		</Wrapper>
	));
	const event = new MouseEvent("click", {
		bubbles: true,
		cancelable: true,
		button: 0,
		...clickInit,
	});
	screen.getByText("the link").dispatchEvent(event);
	return event;
}

describe("findJoinedRoomId", () => {
	it("returns the room ID for a joined room looked up by ID", () => {
		const room = makeRoomStub("!a:example.org");
		const { client } = makeClient({ rooms: [room] });
		expect(findJoinedRoomId(client, "!a:example.org")).toBe("!a:example.org");
	});

	it("matches an alias against canonical and alt aliases of joined rooms", () => {
		const room = makeRoomStub("!a:example.org", {
			canonicalAlias: "#main:example.org",
			altAliases: ["#alt:example.org"],
		});
		const { client } = makeClient({ rooms: [room] });
		expect(findJoinedRoomId(client, "#main:example.org")).toBe(
			"!a:example.org",
		);
		expect(findJoinedRoomId(client, "#alt:example.org")).toBe("!a:example.org");
	});

	it("returns null for unknown rooms and non-joined memberships", () => {
		const invited = makeRoomStub("!inv:example.org", { membership: "invite" });
		const aliasedInvite = makeRoomStub("!inv2:example.org", {
			membership: "invite",
			canonicalAlias: "#invited:example.org",
		});
		const { client } = makeClient({ rooms: [invited, aliasedInvite] });
		expect(findJoinedRoomId(client, "!inv:example.org")).toBeNull();
		expect(findJoinedRoomId(client, "!unknown:example.org")).toBeNull();
		expect(findJoinedRoomId(client, "#invited:example.org")).toBeNull();
		expect(findJoinedRoomId(client, "#unknown:example.org")).toBeNull();
	});
});

describe("PermalinkRouting click handling", () => {
	it("navigates to a joined room link instead of opening externally", () => {
		const { client } = makeClient({
			rooms: [makeRoomStub("!joined:example.org")],
		});
		const event = clickLink(client, "https://matrix.to/#/!joined:example.org");
		expect(event.defaultPrevented).toBe(true);
		expect(navigateMock).toHaveBeenCalledWith(
			`/home/${encodeURIComponent("!joined:example.org")}`,
		);
	});

	it("resolves a joined room by alias", () => {
		const { client } = makeClient({
			rooms: [
				makeRoomStub("!joined:example.org", {
					canonicalAlias: "#main:example.org",
				}),
			],
		});
		const event = clickLink(client, "https://matrix.to/#/%23main:example.org");
		expect(event.defaultPrevented).toBe(true);
		expect(navigateMock).toHaveBeenCalledWith(
			`/home/${encodeURIComponent("!joined:example.org")}`,
		);
	});

	it("routes a DM room link to the /dm/ route", () => {
		const { client } = makeClient({
			rooms: [makeRoomStub("!dm:example.org")],
		});
		clickLink(
			client,
			"https://matrix.to/#/!dm:example.org",
			{},
			{ "!dm:example.org": { isDirect: true } },
		);
		expect(navigateMock).toHaveBeenCalledWith(
			`/dm/${encodeURIComponent("!dm:example.org")}`,
		);
	});

	it("keeps a space child inside the open space", () => {
		const { client } = makeClient({
			rooms: [makeRoomStub("!child:example.org")],
		});
		locationState.pathname = `/space/${encodeURIComponent("!space:example.org")}`;
		clickLink(
			client,
			"https://matrix.to/#/!child:example.org",
			{},
			{
				"!space:example.org": {
					isSpace: true,
					children: ["!child:example.org"],
				},
			},
		);
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent("!space:example.org")}/${encodeURIComponent("!child:example.org")}`,
		);
	});

	it("opens the join dialog prefilled for an unknown room", () => {
		const { client } = makeClient();
		const event = clickLink(
			client,
			"https://matrix.to/#/!unknown:example.org?via=s1.org",
		);
		expect(event.defaultPrevented).toBe(true);
		expect(navigateMock).not.toHaveBeenCalled();
		expect(joinDialogRequest()?.prefill).toEqual({
			idOrAlias: "!unknown:example.org",
			viaServers: ["s1.org"],
		});
	});

	it("opens the join dialog for a room the user is only invited to", () => {
		const { client } = makeClient({
			rooms: [makeRoomStub("!inv:example.org", { membership: "invite" })],
		});
		clickLink(client, "https://matrix.to/#/!inv:example.org");
		expect(navigateMock).not.toHaveBeenCalled();
		expect(joinDialogRequest()?.prefill?.idOrAlias).toBe("!inv:example.org");
	});

	it("navigates with ?event= for an event permalink to a joined room", () => {
		const { client } = makeClient({
			rooms: [makeRoomStub("!joined:example.org")],
		});
		const event = clickLink(
			client,
			"https://matrix.to/#/!joined:example.org/$ev:example.org",
		);
		expect(event.defaultPrevented).toBe(true);
		expect(navigateMock).toHaveBeenCalledWith(
			`/home/${encodeURIComponent("!joined:example.org")}?event=${encodeURIComponent("$ev:example.org")}`,
		);
	});

	it("prefills the join dialog with the room part of an unknown event permalink", () => {
		const { client } = makeClient();
		clickLink(
			client,
			"https://matrix.to/#/!unknown:example.org/$ev:example.org?via=s1.org",
		);
		expect(navigateMock).not.toHaveBeenCalled();
		expect(joinDialogRequest()?.prefill).toEqual({
			idOrAlias: "!unknown:example.org",
			viaServers: ["s1.org"],
		});
	});

	it("opens the profile card for a user pill, anchored to the pill (#444)", () => {
		const { client, createRoom } = makeClient();
		paramsState.roomId = "!room:example.org";
		const event = clickLink(client, "https://matrix.to/#/@alice:example.org");
		expect(event.defaultPrevented).toBe(true);
		const request = profileCardRequest();
		expect(request?.userId).toBe("@alice:example.org");
		expect(request?.roomId).toBe("!room:example.org");
		expect(request?.anchor).toBe(screen.getByText("the link"));
		// The card owns Open DM now - the pill itself starts nothing.
		expect(createRoom).not.toHaveBeenCalled();
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("opens the card without room context on non-room routes", () => {
		const { client } = makeClient();
		locationState.pathname = "/home";
		clickLink(client, "https://matrix.to/#/@alice:example.org");
		expect(profileCardRequest()?.roomId).toBeNull();
	});

	it("opens the card for the user's own pill too", () => {
		const { client, createRoom } = makeClient();
		const event = clickLink(client, "https://matrix.to/#/@test:example.com");
		expect(event.defaultPrevented).toBe(true);
		expect(profileCardRequest()?.userId).toBe("@test:example.com");
		expect(createRoom).not.toHaveBeenCalled();
		expect(navigateMock).not.toHaveBeenCalled();
		expect(joinDialogRequest()).toBeNull();
	});

	it("handles matrix: URIs", () => {
		const { client } = makeClient({
			rooms: [makeRoomStub("!joined:example.org")],
		});
		const event = clickLink(client, "matrix:roomid/joined:example.org");
		expect(event.defaultPrevented).toBe(true);
		expect(navigateMock).toHaveBeenCalledWith(
			`/home/${encodeURIComponent("!joined:example.org")}`,
		);
	});

	it("ignores clicks another handler already cancelled", () => {
		const { client } = makeClient({
			rooms: [makeRoomStub("!joined:example.org")],
		});
		render(() => (
			<Wrapper client={client}>
				<PermalinkRouting />
				<a href="https://matrix.to/#/!joined:example.org">the link</a>
			</Wrapper>
		));
		const event = new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
			button: 0,
		});
		event.preventDefault();
		screen.getByText("the link").dispatchEvent(event);
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("leaves ordinary URLs to the browser", () => {
		const { client } = makeClient();
		const event = clickLink(client, "https://example.org/page");
		expect(event.defaultPrevented).toBe(false);
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("leaves modified and non-left clicks to the browser", () => {
		const { client } = makeClient({
			rooms: [makeRoomStub("!joined:example.org")],
		});
		const href = "https://matrix.to/#/!joined:example.org";
		for (const init of [
			{ ctrlKey: true },
			{ metaKey: true },
			{ shiftKey: true },
			{ button: 1 },
		] satisfies MouseEventInit[]) {
			cleanup();
			const event = clickLink(client, href, init);
			expect(event.defaultPrevented).toBe(false);
		}
		expect(navigateMock).not.toHaveBeenCalled();
	});
});
