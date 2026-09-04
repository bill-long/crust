import type { MatrixClient } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it, type Mock, vi } from "vitest";
import { reportError } from "../lib/reportError";
import {
	attachPresence,
	presenceOf,
	recordSelfPresence,
	recordSelfStatusMsg,
} from "./presence";
import {
	applySyncPresence,
	attachPresencePublisher,
	fetchStatusMessage,
	setPresenceSharing,
	setStatusMessage,
} from "./presencePublish";

vi.mock("../lib/reportError", () => ({
	reportError: vi.fn(),
}));

function mkClient(
	setPresence: Mock = vi.fn(async () => {}),
	getPresence: Mock = vi.fn(async () => ({ presence: "online" })),
) {
	const setSyncPresence = vi.fn();
	const client = {
		setPresence,
		setSyncPresence,
		getPresence,
		getUserId: () => "@me:x",
		on: () => {},
		off: () => {},
	} as unknown as MatrixClient;
	return { client, setPresence, setSyncPresence, getPresence };
}

/** Let the serialised read-then-write settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * The publisher is module-level, so every case attaches inside its own root
 * and detaches on the way out - otherwise one case's sharing state would
 * decide whether the next one publishes at all.
 */
function withPublisher(client: MatrixClient, body: () => void): void {
	// The store too, under a root that is never disposed: attaching resets
	// the echoed raw status the publisher would otherwise carry over from
	// the previous case, while disposing would wipe the entries a case
	// asserts on after the body. The mock's listeners are no-ops.
	createRoot(() => attachPresence(client));
	createRoot((dispose) => {
		attachPresencePublisher(client);
		body();
		dispose();
	});
}

describe("presence publisher", () => {
	it("publishes online when sharing is switched on", async () => {
		const { client, setPresence, setSyncPresence } = mkClient();
		withPublisher(client, () => setPresenceSharing(true));
		await settle();

		// status_msg rides along, read fresh from the server first: the
		// endpoint treats an omitted field as "clear". No status set -> "".
		expect(setPresence).toHaveBeenCalledWith({
			presence: "online",
			status_msg: "",
		});
		expect(setSyncPresence).toHaveBeenCalledWith("online");
	});

	it("publishes offline rather than just going quiet", async () => {
		// A server that has heard nothing recently keeps reporting the last
		// value it was given, so silence would leave us online forever.
		const { client, setPresence, setSyncPresence } = mkClient();
		withPublisher(client, () => {
			setPresenceSharing(true);
			setPresenceSharing(false);
		});
		await settle();

		expect(setPresence).toHaveBeenLastCalledWith({
			presence: "offline",
			status_msg: "",
		});
		expect(setSyncPresence).toHaveBeenLastCalledWith("offline");
	});

	it("stops the sync loop re-asserting the opposite", () => {
		// Without setSyncPresence the very next /sync would put us back
		// online moments after we published offline.
		const { client, setSyncPresence } = mkClient();
		withPublisher(client, () => setPresenceSharing(false));
		expect(setSyncPresence).toHaveBeenCalledWith("offline");
	});

	it("does not re-publish when nothing changed", async () => {
		const { client, setPresence } = mkClient();
		withPublisher(client, () => {
			setPresenceSharing(true);
			setPresenceSharing(true);
		});
		await settle();
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
		await settle();

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
			// and only a later one counts as the user reaching for it - and
			// only the offline direction warns (online rides on the next /sync).
			setPresenceSharing(true);
			setPresenceSharing(false);
			return d;
		});
		await settle();

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
		await settle();

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
		// The publish reads the status first; let that resolve so the hanging
		// PUT is actually in flight before it is refused.
		await settle();

		reject?.(Object.assign(new Error("not found"), { httpStatus: 404 }));
		await settle();

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
		await settle();

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

	describe("status message (#538)", () => {
		it("re-sends the account's current raw status with a sharing publish", async () => {
			// A presence PUT that omits status_msg clears it server-side, so
			// the sharing switch would otherwise wipe a status set anywhere.
			const getPresence = vi.fn(async () => ({
				presence: "online",
				status_msg: "  raw\n\nstatus  ",
			}));
			const { client, setPresence } = mkClient(undefined, getPresence);
			withPublisher(client, () => setPresenceSharing(false));
			await settle();
			expect(getPresence).toHaveBeenCalledWith("@me:x");
			expect(setPresence).toHaveBeenLastCalledWith({
				presence: "offline",
				status_msg: "  raw\n\nstatus  ",
			});
		});

		it("does not publish at all when the status read fails transiently", async () => {
			// A PUT without the status would clear it server-side, so a blip on
			// the read fails the publish like a blip on the write: the toggle
			// gets its toast, the dot is left alone.
			vi.mocked(reportError).mockClear();
			const getPresence = vi.fn(async () => {
				throw Object.assign(new Error("read failed"), { httpStatus: 500 });
			});
			const { client, setPresence } = mkClient(undefined, getPresence);
			withPublisher(client, () => {
				recordSelfPresence("@me:x", true);
				setPresenceSharing(true);
				setPresenceSharing(false);
			});
			await settle();
			expect(setPresence).not.toHaveBeenCalled();
			expect(presenceOf("@me:x").status).toBe("online");
			expect(vi.mocked(reportError).mock.calls.at(-1)?.[1]).toMatchObject({
				userMessage:
					"Couldn't update your presence. Others may still see you as online.",
			});
		});

		it("treats a 403 on the read as presence being off: no write, dot down, no toast", async () => {
			// Continuwuity answers 403 M_FORBIDDEN on both endpoints when presence
			// is disabled; the read hits it first now.
			vi.mocked(reportError).mockClear();
			const getPresence = vi.fn(async () => {
				throw Object.assign(new Error("Presence is disabled on this server"), {
					httpStatus: 403,
					errcode: "M_FORBIDDEN",
				});
			});
			const { client, setPresence } = mkClient(undefined, getPresence);
			const dispose = createRoot((d) => {
				attachPresence(client);
				attachPresencePublisher(client);
				recordSelfPresence("@me:x", true);
				setPresenceSharing(true);
				setPresenceSharing(false);
				return d;
			});
			await settle();
			expect(setPresence).not.toHaveBeenCalled();
			expect(presenceOf("@me:x").status).toBe("unknown");
			expect(vi.mocked(reportError).mock.calls.at(-1)?.[1]).toMatchObject({
				userMessage: undefined,
			});
			dispose();
		});

		it("reads a not-found as no status and publishes on", async () => {
			// Two servers answer it: one with no presence at all, which fails the
			// PUT next and is classified there (once, with the dot rollback); and
			// Continuwuity for an account that shares no room with itself. Failing
			// the publish instead would take our own dot down on the first and
			// make the status editor unopenable on the second.
			const getPresence = vi.fn(async () => {
				throw Object.assign(
					new Error("Presence state for this user was not found"),
					{ httpStatus: 404, errcode: "M_NOT_FOUND" },
				);
			});
			const { client, setPresence } = mkClient(undefined, getPresence);
			const dispose = createRoot((d) => {
				attachPresence(client);
				recordSelfPresence("@me:x", true);
				attachPresencePublisher(client);
				setPresenceSharing(true);
				return d;
			});
			await settle();
			expect(setPresence).toHaveBeenCalledWith({
				presence: "online",
				status_msg: "",
			});
			expect(presenceOf("@me:x").status).toBe("online");
			dispose();
		});

		it("skips the read once the echo has told us our status, and writes synchronously", () => {
			// A tab closed inside a read's RTT would drop the offline publish,
			// and the read races a change from another client - so once known,
			// the echoed raw value goes out with the toggle at once.
			const { client, setPresence, getPresence } = mkClient();
			withPublisher(client, () => {
				recordSelfStatusMsg("@me:x", "  echoed  ");
				setPresenceSharing(false);
				expect(setPresence).toHaveBeenCalledWith({
					presence: "offline",
					status_msg: "  echoed  ",
				});
			});
			expect(getPresence).not.toHaveBeenCalled();
		});

		it("stays quiet when a read blip fails the online direction", async () => {
			// set_presence=online on the next /sync carries the intent anyway,
			// and the toast's wording is about still appearing online.
			vi.mocked(reportError).mockClear();
			const getPresence = vi.fn(async () => {
				throw Object.assign(new Error("blip"), { httpStatus: 500 });
			});
			const { client } = mkClient(undefined, getPresence);
			withPublisher(client, () => {
				setPresenceSharing(false);
				setPresenceSharing(true);
			});
			await settle();
			expect(vi.mocked(reportError).mock.calls.at(-1)?.[1]).toMatchObject({
				userMessage: undefined,
			});
		});

		it("records the status a sharing publish re-sent, ahead of the echo", async () => {
			const getPresence = vi.fn(async () => ({
				presence: "online",
				status_msg: "  set   elsewhere  ",
			}));
			const { client } = mkClient(undefined, getPresence);
			const dispose = createRoot((d) => {
				attachPresence(client);
				recordSelfPresence("@me:x", true);
				attachPresencePublisher(client);
				setPresenceSharing(true);
				return d;
			});
			await settle();
			expect(presenceOf("@me:x")).toEqual({
				status: "online",
				statusMsg: "set elsewhere",
			});
			dispose();
		});

		it("sends a status that renders as nothing as a clear", async () => {
			const { client, setPresence } = mkClient();
			let saved: Promise<void> | undefined;
			withPublisher(client, () => {
				setPresenceSharing(true);
				saved = setStatusMessage("   ");
			});
			await saved;
			expect(setPresence).toHaveBeenLastCalledWith({
				presence: "online",
				status_msg: "",
			});
		});

		it("publishes the status verbatim on the presence already published", async () => {
			const { client, setPresence } = mkClient();
			recordSelfPresence("@me:x", false);
			// Attached across the await: the store write is identity-guarded, so
			// disposing first would prove nothing about it.
			const dispose = createRoot((d) => {
				attachPresencePublisher(client);
				setPresenceSharing(false);
				return d;
			});
			await setStatusMessage("  in a\tmeeting  ");
			expect(setPresence).toHaveBeenLastCalledWith({
				presence: "offline",
				status_msg: "  in a\tmeeting  ",
			});
			// The store learns the display rendering of what the server took;
			// our own status stays whatever the sharing preference draws.
			expect(presenceOf("@me:x")).toEqual({
				status: "unknown",
				statusMsg: "in a meeting",
			});
			dispose();
		});

		it("clears with an empty string and drops the message from the store", async () => {
			const { client, setPresence } = mkClient();
			recordSelfStatusMsg("@me:x", "old");
			const dispose = createRoot((d) => {
				attachPresencePublisher(client);
				setPresenceSharing(true);
				return d;
			});
			await setStatusMessage("");
			expect(setPresence).toHaveBeenLastCalledWith({
				presence: "online",
				status_msg: "",
			});
			expect(presenceOf("@me:x").statusMsg).toBeNull();
			dispose();
		});

		it("runs after a pending sharing publish so it cannot be undone by it", async () => {
			// The publish reads the status, then writes. A save landing in that
			// gap must be ordered after the write, or the publish re-sends the
			// stale value it read.
			const order: string[] = [];
			const setPresence = vi.fn(async (opts: { status_msg?: string }) => {
				order.push(`put:${opts.status_msg}`);
			});
			const getPresence = vi.fn(async () => {
				order.push("get");
				return { presence: "online", status_msg: "before" };
			});
			const { client } = mkClient(setPresence, getPresence);
			let saved: Promise<void> | undefined;
			withPublisher(client, () => {
				setPresenceSharing(true);
				saved = setStatusMessage("after");
			});
			await saved;
			expect(order).toEqual(["get", "put:before", "put:after"]);
		});

		it("rejects to the caller and leaves the store alone on failure", async () => {
			const failing = vi.fn(async () => {
				throw new Error("nope");
			});
			const { client } = mkClient(failing);
			let saved: Promise<void> | undefined;
			withPublisher(client, () => {
				recordSelfStatusMsg("@me:x", "kept");
				setPresenceSharing(true);
				saved = setStatusMessage("new");
			});
			await expect(saved).rejects.toThrow("nope");
			expect(presenceOf("@me:x").statusMsg).toBe("kept");
		});

		it("rejects before a sharing preference is known", async () => {
			const { client } = mkClient();
			let saved: Promise<void> | undefined;
			withPublisher(client, () => {
				saved = setStatusMessage("x");
			});
			await expect(saved).rejects.toThrow();
		});

		it("fetchStatusMessage returns the raw value, or empty when unset", async () => {
			const getPresence = vi.fn(async () => ({
				presence: "online",
				status_msg: " raw  ",
			}));
			const { client } = mkClient(undefined, getPresence);
			let got: Promise<string> | undefined;
			withPublisher(client, () => {
				got = fetchStatusMessage();
			});
			expect(await got).toBe(" raw  ");
			const bare = mkClient();
			let none: Promise<string> | undefined;
			withPublisher(bare.client, () => {
				none = fetchStatusMessage();
			});
			expect(await none).toBe("");
		});
	});
});
