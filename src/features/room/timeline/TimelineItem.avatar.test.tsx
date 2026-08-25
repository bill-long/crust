import { cleanup, render } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFailedImageUrls } from "../../../lib/imageFallback";
import { createMockClient } from "../../../test/mockClient";
import { makeTimelineEvent } from "../../../test/timelineEvent";
import { TimelineItem } from "./TimelineItem";
import type { TimelineEvent } from "./timelineTypes";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

function renderItem(event: TimelineEvent, showHeader = true) {
	const client = createMockClient();
	return render(() => (
		<TimelineItem
			event={event}
			showHeader={showHeader}
			isOwnMessage={false}
			onReact={() => {}}
			onVote={() => {}}
			onEndPoll={() => {}}
			onReply={() => {}}
			onJumpToReply={() => {}}
			onEdit={() => {}}
			onDelete={() => {}}
			onViewSource={() => {}}
			client={client as unknown as MatrixClient}
			shortcodeLookup={new Map()}
			emoteLookup={new Map()}
			packs={[]}
			brokenAvatars={createFailedImageUrls()}
			onOpenProfile={() => {}}
		/>
	));
}

afterEach(() => cleanup());

describe("TimelineItem sender avatar (#517)", () => {
	it("renders the avatar image in the group header when a URL is present", () => {
		const { container } = renderItem(
			makeTimelineEvent({
				senderAvatarUrl: "https://example.com/avatar.png",
			}),
		);
		const img = container.querySelector<HTMLImageElement>(
			"[data-event-id] img",
		);
		expect(img?.getAttribute("src")).toBe("https://example.com/avatar.png");
	});

	it("falls back to the sigil-stripped initial when there is no avatar", () => {
		const { container, getByText } = renderItem(
			makeTimelineEvent({
				senderAvatarUrl: null,
				senderName: "@mallory:example.com",
			}),
		);
		expect(container.querySelector("[data-event-id] img")).toBeNull();
		// "@mallory:example.com" renders "M", not "@" (shared avatarInitial).
		// Exact-text query: the initial is the only element whose full text
		// is the bare letter.
		expect(getByText("M")).toBeTruthy();
	});

	it("shows no avatar slot on grouped continuation rows", () => {
		const { container } = renderItem(
			makeTimelineEvent({
				senderAvatarUrl: "https://example.com/avatar.png",
			}),
			false,
		);
		expect(container.querySelector("[data-event-id] img")).toBeNull();
	});
});
