import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../test/mockClient";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// Controllable search params: tests seed `paramsState` before render and
// observe strips via setSearchParamsMock.
let paramsState: Record<string, string | undefined> = {};
const setSearchParamsMock = vi.fn();
vi.mock("@solidjs/router", () => ({
	useSearchParams: () => [paramsState, setSearchParamsMock],
}));

// The timeline is mocked; the test asserts the deep-link param is handed to
// it as a jump request. The jump itself (scroll + flash + anchored context
// load) is covered by useTimeline's own suite - see "useTimeline jumpToEvent
// anchored loads" in src/features/room/timeline/useTimeline.test.ts.
const capturedJumpRequest: {
	accessor: (() => string | null) | undefined;
} = { accessor: undefined };
const capturedOnJumpHandled: { fn: (() => void) | undefined } = {
	fn: undefined,
};
vi.mock("../features/room/timeline/TimelineView", () => ({
	TimelineView: (props: {
		jumpRequest?: () => string | null;
		onJumpHandled?: () => void;
	}) => {
		capturedJumpRequest.accessor = props.jumpRequest;
		capturedOnJumpHandled.fn = props.onJumpHandled;
		return null;
	},
}));
vi.mock("../features/room/threads/ThreadPanel", () => ({
	ThreadPanel: () => null,
}));
vi.mock("../features/room/MemberList", () => ({ MemberList: () => null }));
vi.mock("../features/room/pinned/PinnedMessagesPanel", () => ({
	PinnedMessagesPanel: () => null,
}));
vi.mock("../features/room/pinned/usePinnedEvents", () => ({
	usePinnedEvents: () => ({
		canPin: () => false,
		isPinned: () => false,
		pin: vi.fn(),
		unpin: vi.fn(),
	}),
}));
vi.mock("../features/room/RoomNotificationMenu", () => ({
	RoomNotificationMenu: () => null,
}));
vi.mock("../features/room/search/SearchPanel", () => ({
	SearchPanel: () => null,
}));
vi.mock("../features/room/threads/ThreadListPanel", () => ({
	ThreadListPanel: () => null,
}));
vi.mock("../features/room/call/CallButton", () => ({
	CallButton: () => null,
}));
vi.mock("../features/emoji/useImagePacks", () => ({
	useImagePacks: () => () => [],
	buildShortcodeLookup: () => new Map(),
}));
vi.mock("../stores/viewport", () => ({ isMobile: () => false }));

import { RoomPane } from "./RoomPane";

const ROOM_ID = "!room:example.org";

function setup(
	params: Record<string, string | undefined>,
	options: {
		client?: ReturnType<typeof createMockClient>;
		onOpenSettings?: () => void;
	} = {},
) {
	paramsState = params;
	const client = options.client ?? createMockClient();
	render(() => (
		<RoomPane
			client={client as unknown as MatrixClient}
			rid={ROOM_ID}
			roomName="Room"
			onBack={() => {}}
			callActive={() => false}
			copyState={() => "idle"}
			onCopyLink={() => {}}
			canInvite={() => false}
			onInvite={() => {}}
			onMarkUnread={() => {}}
			canMarkUnread={() => true}
			leaving={() => false}
			onLeave={() => {}}
			onOpenSettings={options.onOpenSettings ?? (() => {})}
			membersVisible={() => false}
			onToggleMembers={() => {}}
			membersWidth={() => 240}
			onMembersWidthChange={() => {}}
			onMembersWidthCommit={() => {}}
			threadWidth={() => 320}
			onThreadWidthChange={() => {}}
			onThreadWidthCommit={() => {}}
		/>
	));
}

afterEach(() => {
	cleanup();
	paramsState = {};
	setSearchParamsMock.mockReset();
	capturedJumpRequest.accessor = undefined;
	capturedOnJumpHandled.fn = undefined;
});

describe("RoomPane ?event= deep link", () => {
	it("hands the event id to the timeline as a jump request and strips the param", () => {
		setup({ event: "$ev:example.org" });
		expect(capturedJumpRequest.accessor?.()).toBe("$ev:example.org");
		expect(setSearchParamsMock).toHaveBeenCalledWith(
			{ event: undefined },
			{ replace: true },
		);
	});

	it("clears the request once the timeline has handled the jump", () => {
		setup({ event: "$ev:example.org" });
		capturedOnJumpHandled.fn?.();
		expect(capturedJumpRequest.accessor?.()).toBeNull();
	});

	it("requests no jump without the param", () => {
		setup({});
		expect(capturedJumpRequest.accessor?.()).toBeNull();
		expect(setSearchParamsMock).not.toHaveBeenCalledWith(
			{ event: undefined },
			{ replace: true },
		);
	});
});

describe("RoomPane header topic", () => {
	function clientWithTopic(topic: unknown) {
		const room = createMockRoom(ROOM_ID);
		if (topic !== undefined) {
			room.__setStateEvent("m.room.topic", "", { topic });
		}
		return createMockClient(new Map([[ROOM_ID, room]]));
	}

	it("renders the topic as a single truncated line with a tooltip", () => {
		setup({}, { client: clientWithTopic("Weekly sync\nnotes   and links") });
		const button = screen.getByTitle("Weekly sync notes and links");
		expect(button.textContent).toContain("Weekly sync notes and links");
	});

	it("opens room settings when the topic is clicked", () => {
		const onOpenSettings = vi.fn();
		setup({}, { client: clientWithTopic("A topic"), onOpenSettings });
		fireEvent.click(screen.getByTitle("A topic"));
		expect(onOpenSettings).toHaveBeenCalledTimes(1);
	});

	it("renders no topic line when the room has no topic", () => {
		setup({}, { client: clientWithTopic(undefined) });
		expect(screen.queryByText(/Open room settings/)).toBeNull();
	});

	it("ignores a malformed (non-string) topic", () => {
		setup({}, { client: clientWithTopic({ nested: "object" }) });
		expect(screen.queryByText(/Open room settings/)).toBeNull();
	});

	it("updates when an m.room.topic state event arrives", () => {
		const client = clientWithTopic("Before");
		setup({}, { client });
		const room = client.getRoom(ROOM_ID);
		room?.__setStateEvent("m.room.topic", "", { topic: "After" });
		client.__emit("RoomState.events", {
			getType: () => "m.room.topic",
			getRoomId: () => ROOM_ID,
			getStateKey: () => "",
		});
		expect(screen.getByTitle("After")).toBeTruthy();
		expect(screen.queryByTitle("Before")).toBeNull();
	});
});
