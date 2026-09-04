import { EventType, type MatrixClient } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { addDmToMap, readDirectMap } from "./directMap";

/** A client whose `m.direct` account data has `content`; none when omitted. */
function makeClient(content?: unknown): MatrixClient {
	const event = content === undefined ? null : { getContent: () => content };
	return {
		getAccountData: (type: string) =>
			type === EventType.Direct ? event : null,
	} as unknown as MatrixClient;
}

describe("readDirectMap", () => {
	it("returns an empty null-prototype map when no m.direct account data exists", () => {
		const map = readDirectMap(makeClient());
		expect(map).toEqual({});
		expect(Object.getPrototypeOf(map)).toBeNull();
	});

	it("returns an empty null-prototype map for content that is not a plain object", () => {
		for (const content of [null, "x", 42, true, [["!r:server"]]]) {
			const map = readDirectMap(makeClient(content));
			expect(map).toEqual({});
			expect(Object.getPrototypeOf(map)).toBeNull();
		}
	});

	it("drops non-array entries and non-string room IDs", () => {
		expect(
			readDirectMap(
				makeClient({
					"@a:server": ["!r1:server", 42, "!r2:server"],
					"@b:server": "not-an-array",
					"@c:server": null,
				}),
			),
		).toEqual({
			"@a:server": ["!r1:server", "!r2:server"],
		});
	});

	it("returns a null-prototype map and preserves a JSON __proto__ key safely", () => {
		// JSON.parse produces an OWN "__proto__" property (unlike an object
		// literal, which would invoke the prototype setter), mirroring how
		// server-sent m.direct content reaches us.
		const map = readDirectMap(
			makeClient(
				JSON.parse('{"__proto__":["!evil:server"],"@a:server":["!ok:server"]}'),
			),
		);
		expect(Object.getPrototypeOf(map)).toBeNull();
		expect(map["@a:server"]).toEqual(["!ok:server"]);
		// The "__proto__" key is retained as an ordinary own entry (not the
		// prototype), so it round-trips rather than being silently dropped.
		expect(Object.hasOwn(map, "__proto__")).toBe(true);
		expect(map.__proto__).toEqual(["!evil:server"]);
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

	it("returns a plain-prototype object that keeps a __proto__ user ID as an own key", () => {
		// The write boundary: the SDK's setAccountData deep-compares with
		// hasOwnProperty, so the result must have Object's prototype, while a
		// server-sent "__proto__" user ID must still round-trip as data.
		const next = addDmToMap(
			readDirectMap(makeClient(JSON.parse('{"__proto__":["!evil:server"]}'))),
			"__proto__",
			"!r2:server",
		);
		expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
		expect(Object.hasOwn(next, "__proto__")).toBe(true);
		expect(next.__proto__).toEqual(["!evil:server", "!r2:server"]);
		expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype);
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
