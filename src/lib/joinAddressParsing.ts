import { isValidServerName } from "./serverName";

/** A room address the user wants to join, ready for `client.joinRoom`. */
export interface JoinAddress {
	/** Room alias (`#general:example.org`) or room ID (`!id:example.org`). */
	idOrAlias: string;
	/**
	 * Servers to join through (`client.joinRoom`'s `viaServers`). Aliases
	 * self-resolve via their own server, so this is usually empty for
	 * alias input - but any via servers the user supplied (trailing
	 * tokens in the bare form, `via` params in a matrix.to link) are
	 * forwarded verbatim for either sigil. Room IDs typically need at
	 * least one: the joining server must reach a server already
	 * participating in the room.
	 */
	viaServers: string[];
}

export type ParseJoinAddressResult =
	| { ok: true; address: JoinAddress }
	| { ok: false; error: string };

/**
 * Parse a free-form "join a room" string into a `client.joinRoom` target.
 *
 * Accepted forms:
 *   - `#alias:server`
 *   - `!id:server`
 *   - `#alias:server s1.org` / `!id:server s1.org s2.org`
 *     (trailing tokens become via servers, for either sigil)
 *   - `https://matrix.to/#/!id:server?via=s1.org&via=s2.org`
 *   - `https://matrix.to/#/%23alias:server`  (aliases are %23-encoded in
 *     matrix.to fragments because `#` would terminate the fragment)
 *
 * User links (`@user:server`, matrix.to user URLs) are rejected with a
 * hint to start a direct message instead.
 */
export function parseJoinAddress(raw: string): ParseJoinAddressResult {
	const trimmed = raw.trim();
	if (!trimmed) {
		return {
			ok: false,
			error: "Enter a room address or link (e.g. #general:example.org).",
		};
	}

	const matrixTo = /^(?:https?:\/\/)?matrix\.to\/#\/(.+)$/i.exec(trimmed);
	if (matrixTo) {
		const fragment = matrixTo[1];
		if (fragment === undefined) {
			return { ok: false, error: "That matrix.to link is malformed." };
		}
		return parseMatrixToFragment(fragment);
	}

	// Bare form: first token is the address; any remaining tokens are via
	// servers to try the join through.
	const [identifier = "", ...viaTokens] = trimmed.split(/\s+/);
	if (identifier.startsWith("@")) {
		return {
			ok: false,
			error: "That's a user ID - use New direct message instead.",
		};
	}
	const valid = validateRoomIdOrAlias(identifier);
	if (!valid.ok) return valid;
	const viaServers: string[] = [];
	for (const tok of viaTokens) {
		if (!isValidServerName(tok)) {
			return { ok: false, error: `"${tok}" is not a valid server name.` };
		}
		if (!viaServers.includes(tok)) viaServers.push(tok);
	}
	return { ok: true, address: { idOrAlias: identifier, viaServers } };
}

/** Parse the fragment of a matrix.to link (`!id:server?via=s1.org&via=s2.org`). */
function parseMatrixToFragment(fragment: string): ParseJoinAddressResult {
	const qIdx = fragment.indexOf("?");
	const path = qIdx >= 0 ? fragment.slice(0, qIdx) : fragment;
	const query = qIdx >= 0 ? fragment.slice(qIdx + 1) : "";

	// The identifier is the first path segment (matrix.to room links have no
	// further segments; user/event deep links are out of scope here).
	let identifier: string;
	try {
		const [encodedIdentifier = ""] = path.split("/");
		identifier = decodeURIComponent(encodedIdentifier);
	} catch {
		return { ok: false, error: "That matrix.to link is malformed." };
	}
	if (identifier.startsWith("@")) {
		return {
			ok: false,
			error: "That's a user link - use New direct message instead.",
		};
	}
	const valid = validateRoomIdOrAlias(identifier);
	if (!valid.ok) return valid;

	const viaServers: string[] = [];
	for (const part of query.split("&")) {
		if (!part) continue;
		const eq = part.indexOf("=");
		const key = eq >= 0 ? part.slice(0, eq) : part;
		if (key !== "via") continue;
		let server: string;
		try {
			server = decodeURIComponent(eq >= 0 ? part.slice(eq + 1) : "");
		} catch {
			return { ok: false, error: "That matrix.to link is malformed." };
		}
		if (!isValidServerName(server)) {
			return {
				ok: false,
				error: `Via server "${server}" is not a valid hostname.`,
			};
		}
		if (!viaServers.includes(server)) viaServers.push(server);
	}
	return { ok: true, address: { idOrAlias: identifier, viaServers } };
}

/** Inverse of {@link parseJoinAddress}'s bare form: the address followed by
 *  any via servers as trailing tokens. Round-trips through the parser, so it
 *  can prefill the join dialog's free-form input. */
export function formatJoinAddress(address: JoinAddress): string {
	return [address.idOrAlias, ...address.viaServers].join(" ");
}

export function validateRoomIdOrAlias(
	input: string,
): { ok: true } | { ok: false; error: string } {
	const sigil = input[0];
	if (sigil !== "!" && sigil !== "#") {
		return {
			ok: false,
			error: "Room address must start with # (alias) or ! (room ID).",
		};
	}
	// The first ":" after the sigil splits the localpart from the server, so
	// server portions may legitimately contain more colons (ports, IPv6).
	const colonIdx = input.indexOf(":", 1);
	if (colonIdx < 0) {
		return {
			ok: false,
			error: "Room address must include a server (e.g. #general:example.org).",
		};
	}
	const localpart = input.slice(1, colonIdx);
	if (!localpart) {
		return {
			ok: false,
			error: "Room address is missing a name before the ':'.",
		};
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional - reject control chars in user input.
	if (/[\s\x00-\x1f\x7f:]/.test(localpart)) {
		return {
			ok: false,
			error: "Room address contains invalid characters.",
		};
	}
	if (!isValidServerName(input.slice(colonIdx + 1))) {
		return { ok: false, error: "Server portion is not a valid hostname." };
	}
	return { ok: true };
}
