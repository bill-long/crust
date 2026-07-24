/**
 * Browser-mode tests for the room-wide Threads panel (issue #331): popover
 * open/close, row rendering from the thread list hook, open-thread wiring,
 * degraded-server notice, and roving focus. Browser mode because the panel
 * body renders through a Kobalte portal.
 */

import { cleanup, render } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../../styles/global.css";
import { createMockClient, createMockRoom } from "../../../test/mockClient";

const { ThreadListPanel } = await import("./ThreadListPanel");

const ROOM_ID = "!room:example.com";

function fakeThread(id: string, opts?: { latestTs?: number; body?: string }) {
	return {
		id,
		length: 2,
		replyToEvent: {
			getSender: () => "@bob:example.com",
			getTs: () => opts?.latestTs ?? 5000,
		},
		hasCurrentUserParticipated: false,
		initialEventsFetched: true,
		rootEvent: {
			getId: () => id,
			getSender: () => "@alice:example.com",
			getTs: () => 1000,
			getContent: () => ({
				msgtype: "m.text",
				body: opts?.body ?? `root of ${id}`,
			}),
			isRedacted: () => false,
			isDecryptionFailure: () => false,
			unstableExtensibleEvent: undefined,
		},
	};
}

function setup(prep?: (room: ReturnType<typeof createMockRoom>) => void) {
	const room = createMockRoom(
		ROOM_ID,
		[],
		[{ userId: "@alice:example.com", name: "Alice" }],
	);
	prep?.(room);
	const client = createMockClient(new Map([[ROOM_ID, room]]));
	const onOpenThread = vi.fn();
	const utils = render(() => (
		<ThreadListPanel
			client={client as unknown as MatrixClient}
			roomId={ROOM_ID}
			onOpenThread={onOpenThread}
		/>
	));
	return { room, client, onOpenThread, ...utils };
}

function panelRoot(): HTMLElement | null {
	return document.querySelector('[role="dialog"][aria-label="Threads"]');
}

afterEach(() => cleanup());

describe("ThreadListPanel", () => {
	it("opens from the header trigger and lists threads newest-activity-first", async () => {
		const { getByLabelText } = setup((room) => {
			room.threads.set("$old", fakeThread("$old", { latestTs: 2000 }));
			room.threads.set("$new", fakeThread("$new", { latestTs: 9000 }));
		});
		await userEvent.click(getByLabelText("Threads"));
		const panel = panelRoot();
		if (!panel) throw new Error("panel did not open");
		const rows = [...panel.querySelectorAll("button")].filter((b) =>
			b.textContent?.includes("replies"),
		);
		expect(rows.map((r) => r.textContent)).toEqual([
			expect.stringContaining("root of $new"),
			expect.stringContaining("root of $old"),
		]);
	});

	it("opens the clicked thread's panel and closes the popover", async () => {
		const { getByLabelText, onOpenThread } = setup((room) => {
			room.threads.set("$t", fakeThread("$t"));
		});
		await userEvent.click(getByLabelText("Threads"));
		const row = [...(panelRoot()?.querySelectorAll("button") ?? [])].find((b) =>
			b.textContent?.includes("root of $t"),
		);
		if (!row) throw new Error("no row");
		await userEvent.click(row);
		expect(onOpenThread).toHaveBeenCalledWith("$t");
		expect(panelRoot()).toBeNull();
	});

	it("shows the degraded notice when the server can't list threads", async () => {
		const { getByLabelText } = setup((room) => {
			room.threads.set("$known", fakeThread("$known"));
			room.fetchRoomThreads.mockRejectedValue(new Error("M_UNRECOGNIZED"));
		});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		await userEvent.click(getByLabelText("Threads"));
		const panel = panelRoot();
		expect(panel?.textContent).toContain("This server can't list all threads");
		// The session's known threads still render behind the notice.
		expect(panel?.textContent).toContain("root of $known");
		consoleError.mockRestore();
	});

	it("shows the empty state for a room with no threads", async () => {
		const { getByLabelText } = setup();
		await userEvent.click(getByLabelText("Threads"));
		expect(panelRoot()?.textContent).toContain("No threads in this room.");
	});

	it("moves roving focus between rows with the arrow keys", async () => {
		const { getByLabelText } = setup((room) => {
			room.threads.set("$a", fakeThread("$a", { latestTs: 9000 }));
			room.threads.set("$b", fakeThread("$b", { latestTs: 2000 }));
		});
		await userEvent.click(getByLabelText("Threads"));
		const panel = panelRoot();
		if (!panel) throw new Error("panel did not open");
		// The first row captures focus on open (rAF-deferred).
		await new Promise((r) => requestAnimationFrame(() => r(undefined)));
		const first = document.activeElement as HTMLElement;
		expect(first.textContent).toContain("root of $a");
		await userEvent.keyboard("{ArrowDown}");
		await new Promise((r) => requestAnimationFrame(() => r(undefined)));
		expect((document.activeElement as HTMLElement).textContent).toContain(
			"root of $b",
		);
	});
});
