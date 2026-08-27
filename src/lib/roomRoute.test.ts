import { describe, expect, it } from "vitest";
import type { RoomSummary, SummariesStore } from "../client/summaries";
import { roomRoutePath } from "./roomRoute";

function store(
	...rooms: (Partial<RoomSummary> & { roomId: string })[]
): SummariesStore {
	const out: Record<string, unknown> = {};
	for (const r of rooms) out[r.roomId] = r;
	return out as SummariesStore;
}

describe("roomRoutePath", () => {
	it("sends a direct room straight to /dm/", () => {
		// Not /home/: Layout canonicalises that to /dm/, which is a different
		// route branch, so the pane remounts and takes any `?event=` jump
		// with it - the room opens and the message is never reached.
		const s = store({ roomId: "!d:x", isDirect: true });
		expect(roomRoutePath(s, "!d:x")).toBe(`/dm/${encodeURIComponent("!d:x")}`);
	});

	it("keeps a direct room out of the space branch", () => {
		const s = store(
			{ roomId: "!space:x", children: ["!d:x"] },
			{ roomId: "!d:x", isDirect: true },
		);
		expect(roomRoutePath(s, "!d:x", "!space:x")).toBe(
			`/dm/${encodeURIComponent("!d:x")}`,
		);
	});

	it("stays in the open space for one of its own rooms", () => {
		const s = store(
			{ roomId: "!space:x", children: ["!r:x"] },
			{ roomId: "!r:x" },
		);
		expect(roomRoutePath(s, "!r:x", "!space:x")).toBe(
			`/space/${encodeURIComponent("!space:x")}/${encodeURIComponent("!r:x")}`,
		);
	});

	it("falls back to /home/ for a room the open space does not list", () => {
		const s = store({ roomId: "!space:x", children: [] }, { roomId: "!r:x" });
		expect(roomRoutePath(s, "!r:x", "!space:x")).toBe(
			`/home/${encodeURIComponent("!r:x")}`,
		);
	});

	it("falls back to /home/ with no space open", () => {
		expect(roomRoutePath(store({ roomId: "!r:x" }), "!r:x")).toBe(
			`/home/${encodeURIComponent("!r:x")}`,
		);
	});
});
