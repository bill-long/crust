/**
 * Browser-mode tests for compose-into-threads (#303 3d): thread sends go
 * through the SDK's 3-arg overload (which builds the MSC3440 relation),
 * never a hand-built m.thread relation.
 */

import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../../styles/global.css";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { TestClientProvider } from "../../../test/TimelineHarness";

vi.mock("../../gif/gifConfig", () => ({
	useGifConfig: () => ({
		available: () => false,
		provider: () => "tenor",
		apiKey: () => "",
		trendingOnOpen: () => false,
		maxRating: () => "off",
		autoDownload: () => false,
	}),
}));

const { Composer } = await import("./Composer");

const ROOM = "!room:example.com";

function makeClient() {
	const rooms = new Map<string, ReturnType<typeof createMockRoom>>();
	rooms.set(
		ROOM,
		createMockRoom(ROOM, [], [{ userId: "@test:example.com", name: "Test" }]),
	);
	return createMockClient(rooms);
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => cleanup());

function typeAndSend(container: HTMLElement, text: string): void {
	const ta = container.querySelector("textarea");
	if (!ta) throw new Error("textarea not found");
	ta.value = text;
	fireEvent.input(ta);
	fireEvent.keyDown(ta, { key: "Enter" });
}

describe("Composer thread sends", () => {
	it("routes a thread send through the 3-arg overload with no hand-built relation", async () => {
		const client = makeClient();
		const { container } = render(() => (
			<TestClientProvider client={client}>
				<Composer roomId={ROOM} threadRootId="$root" packs={[]} />
			</TestClientProvider>
		));
		typeAndSend(container, "hello thread");
		await tick();
		expect(client.sendMessage).toHaveBeenCalledTimes(1);
		const [roomId, threadId, content] = client.sendMessage.mock.calls[0];
		expect(roomId).toBe(ROOM);
		expect(threadId).toBe("$root");
		// The SDK's addThreadRelationIfNeeded builds the MSC3440 shape;
		// the composer must not pre-build any m.thread relation.
		expect(
			(content as Record<string, unknown>)["m.relates_to"],
		).toBeUndefined();
		expect((content as Record<string, unknown>).body).toBe("hello thread");
	});

	it("keeps main-composer sends thread-free (threadId null)", async () => {
		const client = makeClient();
		const { container } = render(() => (
			<TestClientProvider client={client}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		typeAndSend(container, "hello main");
		await tick();
		expect(client.sendMessage).toHaveBeenCalledTimes(1);
		const [roomId, threadId, content] = client.sendMessage.mock.calls[0];
		expect(roomId).toBe(ROOM);
		expect(threadId).toBeNull();
		expect((content as Record<string, unknown>).body).toBe("hello main");
	});

	it("a reply inside a thread keeps a bare m.in_reply_to (SDK wraps it)", async () => {
		const client = makeClient();
		const replyTo = {
			eventId: "$r1",
			senderId: "@b:example.com",
			senderName: "B",
			body: "first reply",
			msgtype: "m.text",
			type: "m.room.message",
			timestamp: 1000,
		} as never;
		const { container } = render(() => (
			<TestClientProvider client={client}>
				<Composer
					roomId={ROOM}
					threadRootId="$root"
					replyTo={replyTo}
					packs={[]}
				/>
			</TestClientProvider>
		));
		typeAndSend(container, "quoting you");
		await tick();
		const [, threadId, content] = client.sendMessage.mock.calls[0];
		expect(threadId).toBe("$root");
		const relates = (content as Record<string, unknown>)["m.relates_to"] as
			| Record<string, unknown>
			| undefined;
		// The composer writes ONLY the in_reply_to pointer; the SDK's
		// addThreadRelationIfNeeded wraps it with rel_type m.thread and
		// is_falling_back: false (a real reply).
		expect(relates?.rel_type).toBeUndefined();
		expect(relates?.["m.in_reply_to"]).toEqual({ event_id: "$r1" });
	});

	it("routes a thread edit through the 3-arg overload", async () => {
		const client = makeClient();
		const editingEvent = {
			eventId: "$mine",
			senderId: "@test:example.com",
			senderName: "Test",
			body: "original",
			msgtype: "m.text",
			type: "m.room.message",
			timestamp: 1000,
		} as never;
		const { container } = render(() => (
			<TestClientProvider client={client}>
				<Composer
					roomId={ROOM}
					threadRootId="$root"
					editingEvent={editingEvent}
					packs={[]}
				/>
			</TestClientProvider>
		));
		typeAndSend(container, "edited text");
		await tick();
		expect(client.sendMessage).toHaveBeenCalledTimes(1);
		const [roomId, threadId, content] = client.sendMessage.mock.calls[0];
		expect(roomId).toBe(ROOM);
		// Without the threadId the edit's local echo would get no thread
		// association and the panel's acceptsEvent gate would reject it.
		expect(threadId).toBe("$root");
		const relates = (content as Record<string, unknown>)["m.relates_to"] as
			| Record<string, unknown>
			| undefined;
		expect(relates?.rel_type).toBe("m.replace");
		expect(relates?.event_id).toBe("$mine");
	});

	it("offers the poll item inside threads but keeps the event item hidden (#332)", async () => {
		const client = makeClient();
		const { getByLabelText } = render(() => (
			<TestClientProvider client={client}>
				<Composer roomId={ROOM} threadRootId="$root" packs={[]} />
			</TestClientProvider>
		));
		// The items live in the portaled "+" menu (rendered on document.body,
		// only while open), so open it with a real click and query by role.
		await userEvent.click(getByLabelText("Message actions"));
		const items = [...document.body.querySelectorAll('[role="menuitem"]')].map(
			(el) => el.textContent?.trim(),
		);
		expect(items).toContain("Attach file");
		// Polls send into the thread via the SDK's thread overload.
		expect(items).toContain("Create poll");
		// Event cards stay main-timeline-only: their dialog picks a TARGET
		// room, which has no coherent meaning inside a thread scope.
		expect(items).not.toContain("Create event");
	});

	it("sends a poll created from the thread composer into the thread", async () => {
		const client = makeClient();
		const { getByLabelText } = render(() => (
			<TestClientProvider client={client}>
				<Composer roomId={ROOM} threadRootId="$root" packs={[]} />
			</TestClientProvider>
		));
		await userEvent.click(getByLabelText("Message actions"));
		const pollItem = [
			...document.body.querySelectorAll('[role="menuitem"]'),
		].find((el) => el.textContent?.trim() === "Create poll");
		if (!pollItem) throw new Error("no poll item");
		await userEvent.click(pollItem);
		// The dialog renders in the composer subtree; its inputs are
		// label-associated, so getByLabelText resolves them.
		await userEvent.type(getByLabelText("Question"), "Best pizza?");
		await userEvent.type(getByLabelText("Option 1"), "Margherita");
		await userEvent.type(getByLabelText("Option 2"), "Pepperoni");
		const submit = [...document.body.querySelectorAll("button")].find(
			(el) => el.textContent?.trim() === "Create poll",
		);
		if (!submit) throw new Error("no submit button");
		await userEvent.click(submit);
		expect(client.sendEvent).toHaveBeenCalledTimes(1);
		const [roomId, threadId, type] = client.sendEvent.mock.calls[0];
		expect(roomId).toBe(ROOM);
		expect(threadId).toBe("$root");
		expect(type).toBe("org.matrix.msc3381.poll.start");
	});
});
