import type { MatrixClient } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { getParentSpaceCandidates } from "./restrictedAllowCandidates";

interface StateInit {
	type: string;
	stateKey: string;
	content: Record<string, unknown>;
}

interface RoomInit {
	roomId: string;
	name?: string;
	isSpace?: boolean;
	state?: StateInit[];
}

function fakeRoom(init: RoomInit) {
	const state = init.state ?? [];
	const wrap = (s: StateInit) => ({
		getStateKey: () => s.stateKey,
		getContent: () => s.content,
	});
	return {
		roomId: init.roomId,
		name: init.name,
		isSpaceRoom: () => !!init.isSpace,
		currentState: {
			getStateEvents: (type: string, stateKey?: string) => {
				const matches = state.filter(
					(s) =>
						s.type === type &&
						(stateKey === undefined || s.stateKey === stateKey),
				);
				if (stateKey !== undefined) {
					const m = matches[0];
					return m ? wrap(m) : null;
				}
				return matches.map(wrap);
			},
		},
	};
}

function fakeClient(rooms: ReturnType<typeof fakeRoom>[]): MatrixClient {
	const byId = new Map(rooms.map((r) => [r.roomId, r]));
	return {
		getRoom: (id: string) => byId.get(id) ?? null,
		getRooms: () => [...byId.values()],
	} as unknown as MatrixClient;
}

describe("getParentSpaceCandidates", () => {
	const ROOM = "!r:example.com";

	it("collects parents from both relationship directions, deduped and sorted", () => {
		const room = fakeRoom({
			roomId: ROOM,
			state: [
				{
					type: "m.space.parent",
					stateKey: "!gamma:example.com",
					content: { via: ["example.com"] },
				},
				// Also listed as a child by gamma → must dedupe to one entry.
			],
		});
		const gamma = fakeRoom({
			roomId: "!gamma:example.com",
			name: "Gamma",
			isSpace: true,
			state: [
				{
					type: "m.space.child",
					stateKey: ROOM,
					content: { via: ["example.com"] },
				},
			],
		});
		const delta = fakeRoom({
			roomId: "!delta:example.com",
			name: "Delta",
			isSpace: true,
			state: [
				{
					type: "m.space.child",
					stateKey: ROOM,
					content: { via: ["example.com"] },
				},
			],
		});

		const result = getParentSpaceCandidates(
			fakeClient([room, gamma, delta]),
			ROOM,
		);
		expect(result).toEqual([
			{ roomId: "!delta:example.com", name: "Delta" },
			{ roomId: "!gamma:example.com", name: "Gamma" },
		]);
	});

	it("ignores links without a via list and non-space rooms", () => {
		const room = fakeRoom({
			roomId: ROOM,
			state: [
				// Parent with empty via → ignored.
				{
					type: "m.space.parent",
					stateKey: "!novia:example.com",
					content: { via: [] },
				},
				// Parent that does not resolve to a known room → ignored.
				{
					type: "m.space.parent",
					stateKey: "!ghost:example.com",
					content: { via: ["x"] },
				},
			],
		});
		const novia = fakeRoom({
			roomId: "!novia:example.com",
			name: "NoVia",
			isSpace: true,
		});
		// A non-space room claiming the child link → ignored.
		const epsilon = fakeRoom({
			roomId: "!epsilon:example.com",
			name: "Epsilon",
			isSpace: false,
			state: [
				{
					type: "m.space.child",
					stateKey: ROOM,
					content: { via: ["example.com"] },
				},
			],
		});

		const result = getParentSpaceCandidates(
			fakeClient([room, novia, epsilon]),
			ROOM,
		);
		expect(result).toEqual([]);
	});

	it("falls back to the room ID when a space has no name", () => {
		const room = fakeRoom({ roomId: ROOM });
		const space = fakeRoom({
			roomId: "!nameless:example.com",
			isSpace: true,
			state: [
				{
					type: "m.space.child",
					stateKey: ROOM,
					content: { via: ["example.com"] },
				},
			],
		});
		const result = getParentSpaceCandidates(fakeClient([room, space]), ROOM);
		expect(result).toEqual([
			{ roomId: "!nameless:example.com", name: "!nameless:example.com" },
		]);
	});

	it("never returns the room itself as a candidate", () => {
		// A space room that self-references via parent and child links.
		const selfSpace = fakeRoom({
			roomId: ROOM,
			name: "Self",
			isSpace: true,
			state: [
				{ type: "m.space.parent", stateKey: ROOM, content: { via: ["x"] } },
				{ type: "m.space.child", stateKey: ROOM, content: { via: ["x"] } },
			],
		});
		const result = getParentSpaceCandidates(fakeClient([selfSpace]), ROOM);
		expect(result).toEqual([]);
	});
});
