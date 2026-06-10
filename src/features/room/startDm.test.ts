import { EventType } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	addDmToMap,
	findExistingDmRoom,
	readDirectMap,
	startDm,
} from "./startDm";

type Membership = "join" | "invite" | "leave" | "ban";

interface FakeClientOptions {
	direct?: Record<string, unknown>;
	rooms?: Record<string, Membership>;
	createdRoomId?: string;
	failSetAccountData?: boolean;
}

function makeClient(opts: FakeClientOptions = {}) {
	const accountData = new Map<
		string,
		{ getContent: () => Record<string, unknown> }
	>();
	if (opts.direct) {
		accountData.set(EventType.Direct, { getContent: () => opts.direct ?? {} });
	}
	const setAccountData = vi.fn(
		async (type: string, content: Record<string, unknown>) => {
			// matrix-js-sdk's real setAccountData runs deepCompare against any
			// existing value, which calls hasOwnProperty on the content. A
			// null-prototype object would throw here — mirror that so a
			// regression at the write boundary is caught by tests.
			if (typeof content.hasOwnProperty !== "function") {
				throw new TypeError("content.hasOwnProperty is not a function");
			}
			if (opts.failSetAccountData) throw new Error("account data write failed");
			accountData.set(type, { getContent: () => content });
		},
	);
	const createRoom = vi.fn(async (_opts?: Record<string, unknown>) => ({
		room_id: opts.createdRoomId ?? "!new:server",
	}));
	const joinRoom = vi.fn(async (roomId: string) => ({ roomId }));
	const client = {
		getAccountData: (type: string) => accountData.get(type) ?? null,
		getRoom: (roomId: string) => {
			const membership = opts.rooms?.[roomId];
			if (!membership) return null;
			return { getMyMembership: () => membership };
		},
		setAccountData,
		createRoom,
		joinRoom,
		// biome-ignore lint/suspicious/noExplicitAny: minimal MatrixClient stand-in for unit tests.
	} as any;
	return { client, setAccountData, createRoom, joinRoom };
}

describe("readDirectMap", () => {
	it("returns an empty map when no m.direct account data exists", () => {
		const { client } = makeClient();
		expect(readDirectMap(client)).toEqual({});
	});

	it("drops non-array entries and non-string room IDs", () => {
		const { client } = makeClient({
			direct: {
				"@a:server": ["!r1:server", 42, "!r2:server"],
				"@b:server": "not-an-array",
			},
		});
		expect(readDirectMap(client)).toEqual({
			"@a:server": ["!r1:server", "!r2:server"],
		});
	});

	it("returns a null-prototype map and preserves a JSON __proto__ key safely", () => {
		// JSON.parse produces an OWN "__proto__" property (unlike an object
		// literal, which would invoke the prototype setter), mirroring how
		// server-sent m.direct content reaches us.
		const content = JSON.parse(
			'{"__proto__":["!evil:server"],"@a:server":["!ok:server"]}',
		);
		const { client } = makeClient({ direct: content });
		const map = readDirectMap(client);
		expect(Object.getPrototypeOf(map)).toBeNull();
		expect(map["@a:server"]).toEqual(["!ok:server"]);
		// Object's prototype was not polluted.
		expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype);
	});
});

describe("addDmToMap", () => {
	it("adds a new room without mutating the input", () => {
		const map = { "@a:server": ["!r1:server"] };
		const next = addDmToMap(map, "@b:server", "!r2:server");
		expect(next).toEqual({
			"@a:server": ["!r1:server"],
			"@b:server": ["!r2:server"],
		});
		expect(map).toEqual({ "@a:server": ["!r1:server"] });
	});

	it("appends to an existing user list and de-duplicates", () => {
		const map = { "@a:server": ["!r1:server"] };
		expect(addDmToMap(map, "@a:server", "!r2:server")).toEqual({
			"@a:server": ["!r1:server", "!r2:server"],
		});
		expect(addDmToMap(map, "@a:server", "!r1:server")).toEqual({
			"@a:server": ["!r1:server"],
		});
	});
});

describe("findExistingDmRoom", () => {
	it("returns null when the user has no DM rooms", () => {
		const { client } = makeClient();
		expect(findExistingDmRoom(client, "@a:server", {})).toBeNull();
	});

	it("prefers a joined room over an invite-only one", () => {
		const { client } = makeClient({
			rooms: { "!invited:server": "invite", "!joined:server": "join" },
		});
		const map = { "@a:server": ["!invited:server", "!joined:server"] };
		expect(findExistingDmRoom(client, "@a:server", map)).toBe("!joined:server");
	});

	it("falls back to an invite when no joined room exists", () => {
		const { client } = makeClient({
			rooms: { "!invited:server": "invite" },
		});
		const map = { "@a:server": ["!invited:server"] };
		expect(findExistingDmRoom(client, "@a:server", map)).toBe(
			"!invited:server",
		);
	});

	it("skips rooms the SDK no longer knows about and left/banned rooms", () => {
		const { client } = makeClient({
			rooms: { "!left:server": "leave", "!banned:server": "ban" },
		});
		const map = {
			"@a:server": ["!gone:server", "!left:server", "!banned:server"],
		};
		expect(findExistingDmRoom(client, "@a:server", map)).toBeNull();
	});
});

describe("startDm", () => {
	it("reuses an existing joined DM without creating a room", async () => {
		const { client, createRoom, setAccountData, joinRoom } = makeClient({
			direct: { "@a:server": ["!joined:server"] },
			rooms: { "!joined:server": "join" },
		});
		const result = await startDm(client, "@a:server");
		expect(result).toEqual({ roomId: "!joined:server", created: false });
		expect(createRoom).not.toHaveBeenCalled();
		expect(setAccountData).not.toHaveBeenCalled();
		expect(joinRoom).not.toHaveBeenCalled();
	});

	it("accepts a pending invite when reusing an invited DM room", async () => {
		const { client, createRoom, joinRoom } = makeClient({
			direct: { "@a:server": ["!invited:server"] },
			rooms: { "!invited:server": "invite" },
		});
		const result = await startDm(client, "@a:server");
		expect(result).toEqual({ roomId: "!invited:server", created: false });
		expect(joinRoom).toHaveBeenCalledWith("!invited:server");
		expect(createRoom).not.toHaveBeenCalled();
	});

	it("creates an encrypted DM and records it in m.direct", async () => {
		const { client, createRoom, setAccountData } = makeClient({
			createdRoomId: "!new:server",
		});
		const result = await startDm(client, "@a:server");
		expect(result).toEqual({ roomId: "!new:server", created: true });

		const createArg = createRoom.mock.calls[0][0] as Record<string, unknown>;
		expect(createArg.is_direct).toBe(true);
		expect(createArg.preset).toBe("trusted_private_chat");
		expect(createArg.invite).toEqual(["@a:server"]);
		expect(createArg.initial_state).toEqual([
			{
				type: "m.room.encryption",
				state_key: "",
				content: { algorithm: "m.megolm.v1.aes-sha2" },
			},
		]);

		expect(setAccountData).toHaveBeenCalledWith(EventType.Direct, {
			"@a:server": ["!new:server"],
		});
	});

	it("omits encryption initial state when encrypt is false", async () => {
		const { client, createRoom } = makeClient();
		await startDm(client, "@a:server", { encrypt: false });
		const createArg = createRoom.mock.calls[0][0] as Record<string, unknown>;
		expect(createArg.initial_state).toBeUndefined();
	});

	it("merges the new room into an existing m.direct map", async () => {
		const { client, setAccountData } = makeClient({
			direct: { "@a:server": ["!existing:server"] },
			rooms: { "!existing:server": "leave" },
			createdRoomId: "!new:server",
		});
		await startDm(client, "@a:server");
		expect(setAccountData).toHaveBeenCalledWith(EventType.Direct, {
			"@a:server": ["!existing:server", "!new:server"],
		});
		// The content handed to the SDK must have a normal prototype so the
		// SDK's deepCompare (hasOwnProperty) doesn't throw.
		const content = setAccountData.mock.calls[0][1];
		expect(Object.getPrototypeOf(content)).toBe(Object.prototype);
	});

	it("coalesces concurrent calls for the same user into one room creation", async () => {
		const { client, createRoom } = makeClient({ createdRoomId: "!new:server" });
		const p1 = startDm(client, "@a:server");
		const p2 = startDm(client, "@a:server");
		expect(p1).toBe(p2);
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toEqual({ roomId: "!new:server", created: true });
		expect(r2).toEqual({ roomId: "!new:server", created: true });
		expect(createRoom).toHaveBeenCalledTimes(1);
	});

	it("still resolves with the created room when the m.direct write fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { client, createRoom } = makeClient({
			createdRoomId: "!new:server",
			failSetAccountData: true,
		});
		const result = await startDm(client, "@a:server");
		expect(result).toEqual({ roomId: "!new:server", created: true });
		expect(createRoom).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
