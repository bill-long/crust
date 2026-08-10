import { cleanup, render } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function setup(params: Record<string, string | undefined>) {
	paramsState = params;
	render(() => (
		<RoomPane
			client={{} as unknown as MatrixClient}
			rid="!room:example.org"
			roomName="Room"
			onBack={() => {}}
			callActive={() => false}
			copyState={() => "idle"}
			onCopyLink={() => {}}
			canInvite={() => false}
			onInvite={() => {}}
			leaving={() => false}
			onLeave={() => {}}
			onOpenSettings={() => {}}
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
