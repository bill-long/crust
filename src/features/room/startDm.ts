import { EventType, type MatrixClient, Preset } from "matrix-js-sdk";

/**
 * The `m.direct` account-data map: a record of user ID -> list of room IDs
 * that are direct messages with that user. See
 * https://spec.matrix.org/v1.11/client-server-api/#mdirect.
 */
export type DirectMap = Record<string, string[]>;

/**
 * Read and normalize the `m.direct` account-data map for the current user.
 *
 * The spec only constrains values to be arrays of room-ID strings, so we
 * defensively drop any non-array entries and any non-string room IDs rather
 * than trusting the raw content shape.
 */
export function readDirectMap(client: MatrixClient): DirectMap {
	const event = client.getAccountData(EventType.Direct);
	const content = event?.getContent() as Record<string, unknown> | undefined;
	// Null-prototype map: m.direct keys are server-controlled user IDs, so a
	// key like "__proto__" must become a normal entry, not pollute Object's
	// prototype.
	const map: DirectMap = Object.create(null);
	if (!content) return map;
	for (const [userId, rooms] of Object.entries(content)) {
		if (Array.isArray(rooms)) {
			map[userId] = rooms.filter((r): r is string => typeof r === "string");
		}
	}
	return map;
}

/**
 * Return a new `m.direct` map with `roomId` recorded under `userId`,
 * preserving every other entry and de-duplicating within the user's list.
 * Pure: does not mutate the input.
 */
export function addDmToMap(
	map: DirectMap,
	userId: string,
	roomId: string,
): DirectMap {
	const next: DirectMap = Object.create(null);
	for (const [user, rooms] of Object.entries(map)) {
		next[user] = [...rooms];
	}
	const list = next[userId] ?? [];
	if (!list.includes(roomId)) list.push(roomId);
	next[userId] = list;
	return next;
}

/**
 * Find an existing usable DM room with `userId` from the `m.direct` map.
 *
 * Prefers a room the user has actually joined; falls back to the first room
 * the user has only been invited to. Rooms the SDK no longer knows about, or
 * that the user has left/been banned from, are skipped so we never route into
 * (or reuse) a dead room. Returns `null` when no reusable room exists.
 */
export function findExistingDmRoom(
	client: MatrixClient,
	userId: string,
	map: DirectMap,
): string | null {
	const candidates = map[userId] ?? [];
	let inviteFallback: string | null = null;
	for (const roomId of candidates) {
		const room = client.getRoom(roomId);
		if (!room) continue;
		const membership = room.getMyMembership();
		if (membership === "join") return roomId;
		if (membership === "invite" && inviteFallback === null) {
			inviteFallback = roomId;
		}
	}
	return inviteFallback;
}

export interface StartDmResult {
	roomId: string;
	/** True when a new room was created; false when an existing DM was reused. */
	created: boolean;
}

export interface StartDmOptions {
	/** Enable end-to-end encryption on a newly created DM. Defaults to true. */
	encrypt?: boolean;
}

/**
 * Per-client serialization of `m.direct` read-modify-write cycles so two
 * concurrent `startDm` calls (e.g. from the member-list popover and the
 * "New DM" dialog) can't both read the same stale map and clobber each
 * other's mapping. Each write re-reads the map after the previous one
 * settles (the local echo updates `getAccountData`). Keyed per client so an
 * account switch doesn't entangle the new client's writes with the old
 * client's chain. Cross-device writes remain last-writer-wins — the spec
 * offers no compare-and-set for account data.
 */
const directWriteChains = new WeakMap<MatrixClient, Promise<void>>();

function recordDmInDirectMap(
	client: MatrixClient,
	userId: string,
	roomId: string,
): Promise<void> {
	const chain = directWriteChains.get(client) ?? Promise.resolve();
	const run = chain.then(async () => {
		const nextMap = addDmToMap(readDirectMap(client), userId, roomId);
		// Serialize a plain-prototype object: matrix-js-sdk's setAccountData
		// runs deepCompare, which calls hasOwnProperty on the content — a
		// null-prototype object (used internally for pollution safety) would
		// throw. Object spread copies own keys without invoking any __proto__
		// setter, so the boundary object stays pollution-safe too.
		await client.setAccountData(EventType.Direct, { ...nextMap });
	});
	// Keep the chain alive on failure so one bad write doesn't wedge later ones.
	directWriteChains.set(
		client,
		run.catch(() => {}),
	);
	return run;
}

/**
 * In-flight `startDm` calls, per client, keyed by target user ID. A second
 * call for the same user while the first is still running returns the same
 * promise rather than racing a duplicate `createRoom`. This dedups the two UI
 * entry points (member-list popover + "New DM" dialog) within a tab; it
 * cannot prevent a different device from creating a parallel DM. Keyed per
 * client so an account switch can't hand a caller a promise from the old
 * account.
 */
const inFlightStartsByClient = new WeakMap<
	MatrixClient,
	Map<string, Promise<StartDmResult>>
>();

/**
 * Start (or reuse) a direct message with `userId`.
 *
 * If a usable DM room already exists in `m.direct`, it is reused so we don't
 * create duplicate one-on-one rooms — accepting a pending invite to that DM
 * if the user hasn't joined it yet. Otherwise a new invite-only DM room is
 * created (`is_direct`, `trusted_private_chat`, optionally encrypted) and the
 * `m.direct` account-data map is updated to record it.
 *
 * On success the user is always a joined member of the returned room.
 * Navigation and optimistic UI are the caller's responsibility — this helper
 * is router-agnostic so it can be unit-tested in isolation.
 *
 * Concurrent calls for the same `userId` are coalesced; `options` from the
 * first caller win for the duration of that in-flight call.
 */
export function startDm(
	client: MatrixClient,
	userId: string,
	options?: StartDmOptions,
): Promise<StartDmResult> {
	let inFlight = inFlightStartsByClient.get(client);
	if (!inFlight) {
		inFlight = new Map<string, Promise<StartDmResult>>();
		inFlightStartsByClient.set(client, inFlight);
	}
	const pending = inFlight.get(userId);
	if (pending) return pending;
	const promise = startDmUncoalesced(client, userId, options).finally(() => {
		inFlight.delete(userId);
	});
	inFlight.set(userId, promise);
	return promise;
}

async function startDmUncoalesced(
	client: MatrixClient,
	userId: string,
	options?: StartDmOptions,
): Promise<StartDmResult> {
	const existing = findExistingDmRoom(client, userId, readDirectMap(client));
	if (existing) {
		// Reused room may be an outstanding invite — accept it so the caller
		// lands in a room the user has actually joined, not an invite preview.
		if (client.getRoom(existing)?.getMyMembership() === "invite") {
			await client.joinRoom(existing);
		}
		return { roomId: existing, created: false };
	}

	const encrypt = options?.encrypt ?? true;
	const createOpts: Parameters<MatrixClient["createRoom"]>[0] = {
		preset: Preset.TrustedPrivateChat,
		is_direct: true,
		invite: [userId],
	};
	if (encrypt) {
		createOpts.initial_state = [
			{
				type: "m.room.encryption",
				state_key: "",
				content: { algorithm: "m.megolm.v1.aes-sha2" },
			},
		];
	}

	const { room_id } = await client.createRoom(createOpts);

	// The room now exists on the server. Recording it in m.direct is
	// best-effort: if that write fails we must NOT reject, or the caller would
	// surface an error and the user would retry — creating a duplicate room
	// (the first is invisible to findExistingDmRoom because it was never
	// recorded). Navigating into the usable room and relying on the caller's
	// optimistic isDirect flag (and the next successful account-data write or
	// /sync) to reconcile is the lesser evil.
	try {
		await recordDmInDirectMap(client, userId, room_id);
	} catch (err) {
		console.warn("startDm: failed to record DM in m.direct", err);
	}

	return { roomId: room_id, created: true };
}
