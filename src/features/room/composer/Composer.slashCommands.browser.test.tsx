/**
 * Browser-mode tests for the composer's slash-command send path (#448):
 * the raw draft goes through parseSlashCommand before markdown, and the
 * resulting wire content (msgtype, body, formatted_body) is what lands
 * in client.sendMessage.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../styles/global.css";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { TestClientProvider } from "../../../test/TimelineHarness";
import { requiredAt } from "./testAssertions";

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

function setup() {
	const rooms = new Map<string, ReturnType<typeof createMockRoom>>();
	rooms.set(
		ROOM,
		createMockRoom(ROOM, [], [{ userId: "@test:example.com", name: "Test" }]),
	);
	const client = createMockClient(rooms);
	const { container } = render(() => (
		<TestClientProvider client={client}>
			<Composer roomId={ROOM} packs={[]} />
		</TestClientProvider>
	));
	const textarea = container.querySelector("textarea");
	if (!textarea) throw new Error("no composer textarea");
	return { client, textarea };
}

async function sendText(
	client: ReturnType<typeof createMockClient>,
	textarea: HTMLTextAreaElement,
	text: string,
): Promise<Record<string, unknown>> {
	const before = client.sendMessage.mock.calls.length;
	Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set?.call(textarea, text);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
	textarea.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true,
		}),
	);
	await vi.waitFor(() => {
		expect(client.sendMessage.mock.calls.length).toBe(before + 1);
	});
	const call = requiredAt(client.sendMessage.mock.calls, before, "send call");
	// 3-arg overload: (roomId, threadId, content).
	return call[2] as Record<string, unknown>;
}

afterEach(() => cleanup());

describe("Composer slash commands (send path)", () => {
	it("/me sends an m.emote with the action as the body", async () => {
		const { client, textarea } = setup();
		const content = await sendText(client, textarea, "/me waves at everyone");
		expect(content.msgtype).toBe("m.emote");
		expect(content.body).toBe("waves at everyone");
	});

	it("/shrug prepends the emoticon and skips markdown", async () => {
		const { client, textarea } = setup();
		const content = await sendText(client, textarea, "/shrug no idea");
		expect(content.msgtype).toBe("m.text");
		expect(content.body).toBe("¯\\_(ツ)_/¯ no idea");
		expect(content.formatted_body).toBeUndefined();
	});

	it("/spoiler wraps the formatted body and hides the plain-text fallback", async () => {
		const { client, textarea } = setup();
		const content = await sendText(client, textarea, "/spoiler the ending");
		expect(content.msgtype).toBe("m.text");
		// MSC2010: the fallback body must not leak the hidden content
		// (push notifications, room-list previews, plaintext clients).
		expect(content.body).toBe("[Spoiler]");
		expect(content.formatted_body).toBe(
			"<span data-mx-spoiler>the ending</span>",
		);
	});

	it("inline ||spoilers|| format through the markdown pipeline", async () => {
		const { client, textarea } = setup();
		const content = await sendText(client, textarea, "before ||hidden|| after");
		expect(content.body).toBe("before ||hidden|| after");
		expect(content.formatted_body).toBe(
			"before <span data-mx-spoiler>hidden</span> after",
		);
	});

	it("// escapes to a literal leading slash", async () => {
		const { client, textarea } = setup();
		const content = await sendText(client, textarea, "//me not a command");
		expect(content.msgtype).toBe("m.text");
		expect(content.body).toBe("/me not a command");
	});

	it("unknown commands send as literal text", async () => {
		const { client, textarea } = setup();
		const content = await sendText(client, textarea, "/gibberish hello");
		expect(content.body).toBe("/gibberish hello");
	});
});
