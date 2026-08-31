import { cleanup, render, screen } from "@solidjs/testing-library";
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

function renderItem(event: TimelineEvent) {
	const client = createMockClient();
	return render(() => (
		<TimelineItem
			event={event}
			now={Date.now()}
			showHeader={true}
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

describe("TimelineItem m.emote rendering (#448)", () => {
	it("renders an emote as an italic '* Name action' line", () => {
		const { container } = renderItem(
			makeTimelineEvent({
				senderName: "Mallory",
				msgtype: "m.emote",
				body: "waves at everyone",
			}),
		);
		const line = container.querySelector(".emote-body");
		expect(line).not.toBeNull();
		expect(line?.textContent).toContain("Mallory");
		expect(line?.textContent).toContain("waves at everyone");
		// The decorative asterisk is hidden from screen readers.
		expect(
			line?.querySelector('[aria-hidden="true"]')?.textContent?.trim(),
		).toBe("*");
	});

	it("renders a plain text message without the emote wrapper", () => {
		const { container } = renderItem(
			makeTimelineEvent({ body: "ordinary message" }),
		);
		expect(container.querySelector(".emote-body")).toBeNull();
		expect(screen.getByText("ordinary message")).toBeTruthy();
	});
});
