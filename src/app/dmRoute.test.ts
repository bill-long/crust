import { describe, expect, it } from "vitest";
import { dmCanonicalTarget } from "./dmRoute";

describe("dmCanonicalTarget", () => {
	it("redirects a /home/<dmId> route to /dm/<dmId> when the room is direct", () => {
		expect(dmCanonicalTarget("/home/!abc:server", "!abc:server", true)).toBe(
			"/dm/!abc%3Aserver",
		);
	});

	it("does not redirect when the room is not yet known to be direct", () => {
		expect(
			dmCanonicalTarget("/home/!abc:server", "!abc:server", undefined),
		).toBeNull();
		expect(
			dmCanonicalTarget("/home/!abc:server", "!abc:server", false),
		).toBeNull();
	});

	it("does not redirect non-/home routes (prevents a redirect loop on /dm)", () => {
		expect(
			dmCanonicalTarget("/dm/!abc:server", "!abc:server", true),
		).toBeNull();
		expect(
			dmCanonicalTarget("/space/!s:server/!abc:server", "!abc:server", true),
		).toBeNull();
		expect(dmCanonicalTarget("/settings/account", undefined, true)).toBeNull();
	});

	it("does not redirect when there is no roomId", () => {
		expect(dmCanonicalTarget("/home", undefined, true)).toBeNull();
		expect(dmCanonicalTarget("/home/", undefined, true)).toBeNull();
	});

	it("encodes the roomId so the redirect target round-trips with useDecodedParams", () => {
		// Matches RoomList.navigateToRoom: `/dm/${encodeURIComponent(roomId)}`.
		const roomId = "!room:matrix.org";
		const target = dmCanonicalTarget(`/home/${roomId}`, roomId, true);
		expect(target).toBe(`/dm/${encodeURIComponent(roomId)}`);
		const encoded = target?.slice("/dm/".length) ?? "";
		expect(decodeURIComponent(encoded)).toBe(roomId);
	});
});
