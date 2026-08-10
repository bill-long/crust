import { afterEach, describe, expect, it } from "vitest";
import type { RoomSummary, SummariesStore } from "../client/summaries";
import {
	_resetLastChannelsForTests,
	setLastChannel,
} from "../stores/lastChannel";
import { spaceLandingPath } from "./spaceLanding";

function room(partial: Partial<RoomSummary> & { roomId: string }): RoomSummary {
	return {
		name: partial.roomId,
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		membership: "join",
		isEncrypted: false,
		isDirect: false,
		isSpace: false,
		kind: "text",
		callActive: false,
		children: [],
		...partial,
	};
}

function store(rooms: RoomSummary[]): SummariesStore {
	const s: SummariesStore = {};
	for (const r of rooms) s[r.roomId] = r;
	return s;
}

afterEach(() => {
	_resetLastChannelsForTests();
});

describe("spaceLandingPath", () => {
	it("falls back to the space landing view when no channel is remembered", () => {
		const s = store([room({ roomId: "!space:x", isSpace: true })]);
		expect(spaceLandingPath(s, "!space:x")).toBe(
			`/space/${encodeURIComponent("!space:x")}`,
		);
	});

	it("re-opens the remembered channel when it is a joined child (#226)", () => {
		const s = store([
			room({ roomId: "!space:x", isSpace: true, children: ["!general:x"] }),
			room({ roomId: "!general:x" }),
		]);
		setLastChannel("!space:x", "!general:x");
		expect(spaceLandingPath(s, "!space:x")).toBe(
			`/space/${encodeURIComponent("!space:x")}/${encodeURIComponent("!general:x")}`,
		);
	});

	it("falls back to landing when the remembered channel is not a joined child", () => {
		const s = store([
			room({ roomId: "!space:x", isSpace: true, children: ["!general:x"] }),
			room({ roomId: "!general:x" }),
		]);
		setLastChannel("!space:x", "!stale:x");
		expect(spaceLandingPath(s, "!space:x")).toBe(
			`/space/${encodeURIComponent("!space:x")}`,
		);
	});

	it("falls back to landing when the remembered child room was left", () => {
		const s = store([
			room({ roomId: "!space:x", isSpace: true, children: ["!general:x"] }),
			room({ roomId: "!general:x", membership: "leave" }),
		]);
		setLastChannel("!space:x", "!general:x");
		expect(spaceLandingPath(s, "!space:x")).toBe(
			`/space/${encodeURIComponent("!space:x")}`,
		);
	});
});
