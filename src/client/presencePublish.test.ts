import type { MatrixClient } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { reportError } from "../lib/reportError";
import { presenceOf, recordSelfPresence } from "./presence";
import {
	applySyncPresence,
	attachPresencePublisher,
	setPresenceSharing,
} from "./presencePublish";

vi.mock("../lib/reportError", () => ({
	reportError: vi.fn(),
}));

function mkClient(setPresence = vi.fn(async () => {})) {
	const setSyncPresence = vi.fn();
	const client = {
		setPresence,
		setSyncPresence,
		getUserId: () => "@me:x",
	} as unknown as MatrixClient;
	return { client, setPresence, setSyncPresence };
}

/**
 * The publisher is module-level, so every case attaches inside its own root
 * and detaches on the way out - otherwise one case's sharing state would
 * decide whether the next one publishes at all.
 */
function withPublisher(client: MatrixClient, body: () => void): void {
	createRoot((dispose) => {
		attachPresencePublisher(client);
		body();
		dispose();
	});
}

describe("presence publisher", () => {
	it("publishes online when sharing is switched on", () => {
		const { client, setPresence, setSyncPresence } = mkClient();
		withPublisher(client, () => setPresenceSharing(true));

		// No status_msg ever: this client does not set one, and including the
		// field would rewrite or clear what another client set.
		expect(setPresence).toHaveBeenCalledWith({ presence: "online" });
		expect(setSyncPresence).toHaveBeenCalledWith("online");
	});

	it("publishes offline rather than just going quiet", () => {
		// A server that has heard nothing recently keeps reporting the last
		// value it was given, so silence would leave us online forever.
		const { client, setPresence, setSyncPresence } = mkClient();
		withPublisher(client, () => {
			setPresenceSharing(true);
			setPresenceSharing(false);
		});

		expect(setPresence).toHaveBeenLastCalledWith({ presence: "offline" });
		expect(setSyncPresence).toHaveBeenLastCalledWith("offline");
	});

	it("stops the sync loop re-asserting the opposite", () => {
		// Without setSyncPresence the very next /sync would put us back
		// online moments after we published offline.
		const { client, setSyncPresence } = mkClient();
		withPublisher(client, () => setPresenceSharing(false));
		expect(setSyncPresence).toHaveBeenCalledWith("offline");
	});

	it("does not re-publish when nothing changed", () => {
		const { client, setPresence } = mkClient();
		withPublisher(client, () => {
			setPresenceSharing(true);
			setPresenceSharing(true);
		});
		expect(setPresence).toHaveBeenCalledTimes(1);
	});

	it("re-asserts the sync presence once the sync API exists", () => {
		// setSyncPresence is `syncApi?.setPresence(...)`, and syncApi is not
		// created until startClient(). The publish during provider setup
		// therefore reaches nothing, SyncApi omits set_presence, and the
		// spec's default for an omitted value is online - so "sharing off"
		// silently failed on every reload until this re-assert.
		const { client, setSyncPresence } = mkClient();
		withPublisher(client, () => {
			setPresenceSharing(false);
			setSyncPresence.mockClear();
			applySyncPresence();
		});

		expect(setSyncPresence).toHaveBeenCalledWith("offline");
	});

	it("has nothing to re-assert before a preference is known", () => {
		const { client, setSyncPresence } = mkClient();
		withPublisher(client, () => {
			setSyncPresence.mockClear();
			applySyncPresence();
		});
		expect(setSyncPresence).not.toHaveBeenCalled();
	});

	it.each([
		["a 404 with no JSON body, as a proxy returns", { httpStatus: 404 }],
		[
			"M_UNRECOGNIZED, as a server that never had presence returns",
			{
				httpStatus: 400,
				errcode: "M_UNRECOGNIZED",
			},
		],
	])("rolls back on %s", async (_label, shape) => {
		// The Conduwuity shape is covered above. These are the other two the
		// predicate exists for, and without them either clause can be
		// deleted with the suite still green.
		const failing = vi.fn(async () => {
			throw Object.assign(new Error("nope"), shape);
		});
		const { client } = mkClient(failing);
		recordSelfPresence("@me:x", true);

		const dispose = createRoot((d) => {
			attachPresencePublisher(client);
			setPresenceSharing(true);
			return d;
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(presenceOf("@me:x").status).toBe("unknown");
		dispose();
	});

	it.each([
		[
			"stays console-only when the server has no presence at all",
			{ httpStatus: 404, errcode: "M_NOT_FOUND" },
			undefined,
		],
		[
			"warns the user when the failure was transient",
			{ httpStatus: 500, errcode: "M_UNKNOWN" },
			"Couldn't update your presence. Others may still see you as online.",
		],
	])("%s", async (_label, shape, expected) => {
		// The toast would be untrue on a server with presence disabled -
		// nobody sees us as anything - and the dot rollback is already the
		// inline surface for it, so a toast is the second signal AGENTS.md
		// says not to stack. On a blip the wording is accurate and there is
		// no other feedback, since the switch stays flipped either way.
		vi.mocked(reportError).mockClear();
		const failing = vi.fn(async () => {
			throw Object.assign(new Error("nope"), shape);
		});
		const { client } = mkClient(failing);

		const dispose = createRoot((d) => {
			attachPresencePublisher(client);
			// Twice: the first call is start-up applying the stored value,
			// and only a later one counts as the user reaching for it.
			setPresenceSharing(false);
			setPresenceSharing(true);
			return d;
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(vi.mocked(reportError).mock.calls.at(-1)?.[1]).toMatchObject({
			userMessage: expected,
		});
		dispose();
	});

	it("leaves our own dot alone when the failure is a blip", async () => {
		// Nothing retries this and the effect only re-runs when the setting
		// changes, so rolling back on a 5xx would strip our own dot for the
		// rest of the session - while set_presence on every /sync keeps us
		// genuinely online to everyone else.
		const flaky = vi.fn(async () => {
			throw Object.assign(new Error("Internal server error"), {
				httpStatus: 500,
				errcode: "M_UNKNOWN",
			});
		});
		const { client } = mkClient(flaky);
		recordSelfPresence("@me:x", true);

		// Attached across the await: detaching first would skip the rollback
		// on identity alone and prove nothing about which errors it accepts.
		const dispose = createRoot((d) => {
			attachPresencePublisher(client);
			setPresenceSharing(true);
			return d;
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(presenceOf("@me:x").status).toBe("online");
		dispose();
	});

	it("does not blank the previous account after a session swap", async () => {
		// The store is module-level, so a late rejection from the old
		// session would write `unknown` under the *previous* user's ID -
		// blanking them as a peer in the session that replaced it.
		let reject: ((e: unknown) => void) | undefined;
		const hanging = vi.fn(
			() =>
				new Promise<void>((_, r) => {
					reject = r;
				}),
		);
		const { client } = mkClient(hanging as never);
		recordSelfPresence("@me:x", true);

		const dispose = createRoot((d) => {
			attachPresencePublisher(client);
			setPresenceSharing(true);
			return d;
		});
		dispose();

		reject?.(Object.assign(new Error("not found"), { httpStatus: 404 }));
		await Promise.resolve();
		await Promise.resolve();

		expect(presenceOf("@me:x").status).toBe("online");
	});

	it("takes our own dot back down when the publish is refused", async () => {
		// A homeserver with presence disabled 404s here, and no peer ever
		// produces a presence event either - so leaving the optimistic write
		// alone would show one green dot on screen, ours, sourced from the
		// only claim the server actually rejected.
		const failing = vi.fn(async () => {
			throw Object.assign(new Error("Presence is disabled"), {
				httpStatus: 404,
				errcode: "M_NOT_FOUND",
			});
		});
		const { client } = mkClient(failing);
		recordSelfPresence("@me:x", true);
		expect(presenceOf("@me:x").status).toBe("online");

		// Attached across the await, unlike `withPublisher`: the rollback is
		// deliberately skipped once this publisher has been detached, since
		// by then the store belongs to whatever replaced it.
		const dispose = createRoot((d) => {
			attachPresencePublisher(client);
			setPresenceSharing(true);
			return d;
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(presenceOf("@me:x").status).toBe("unknown");
		dispose();
	});

	it("survives a homeserver with presence disabled", () => {
		// Answering 404 here is not something to put in front of the user on
		// every start.
		const failing = vi.fn(async () => {
			throw new Error("M_NOT_FOUND");
		});
		const { client } = mkClient(failing);
		expect(() =>
			withPublisher(client, () => setPresenceSharing(true)),
		).not.toThrow();
	});
});
