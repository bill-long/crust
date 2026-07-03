import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadSummaryChip } from "./ThreadSummaryChip";
import type { ThreadSummary } from "./threadSummary";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

afterEach(() => cleanup());

const NOW = 1_700_000_000_000;

function summary(overrides?: Partial<ThreadSummary>): ThreadSummary {
	return {
		threadId: "$root",
		replyCount: 3,
		latestSender: "@b:hs",
		latestTs: NOW - 5 * 60_000,
		currentUserParticipated: false,
		unreadCount: 0,
		provisional: false,
		...overrides,
	};
}

describe("ThreadSummaryChip", () => {
	it("shows the reply count and relative activity", () => {
		render(() => <ThreadSummaryChip thread={summary()} now={NOW} />);
		expect(screen.getByText("3 replies")).toBeTruthy();
		expect(screen.getByText("5m ago")).toBeTruthy();
	});

	it("uses the singular for one reply", () => {
		render(() => (
			<ThreadSummaryChip thread={summary({ replyCount: 1 })} now={NOW} />
		));
		expect(screen.getByText("1 reply")).toBeTruthy();
	});

	it("omits the activity label when the latest timestamp is unknown", () => {
		render(() => (
			<ThreadSummaryChip thread={summary({ latestTs: null })} now={NOW} />
		));
		expect(screen.getByText("3 replies")).toBeTruthy();
		expect(screen.queryByText(/ago|just now/)).toBeNull();
	});

	it("shows an unread dot and aria suffix when unread", () => {
		render(() => (
			<ThreadSummaryChip
				thread={summary({ unreadCount: 2 })}
				onOpen={() => {}}
				now={NOW}
			/>
		));
		expect(screen.getByLabelText(/unread$/)).toBeTruthy();
	});

	it("no unread dot or suffix when read", () => {
		render(() => (
			<ThreadSummaryChip
				thread={summary({ unreadCount: 0 })}
				onOpen={() => {}}
				now={NOW}
			/>
		));
		expect(screen.queryByLabelText(/unread$/)).toBeNull();
	});
});
