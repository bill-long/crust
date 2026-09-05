import { validateMatrixUserId } from "./inviteValidation";
import { validateRoomIdOrAlias } from "./joinAddressParsing";
import { isValidServerName } from "./serverName";

/**
 * A Matrix permalink (`matrix.to` URL or `matrix:` URI) parsed into the
 * in-app routing target it points at.
 */
export type MatrixUriTarget =
	| {
			kind: "room";
			/** `#alias:server` or `!id:server`. */
			idOrAlias: string;
			viaServers: string[];
	  }
	| {
			kind: "event";
			roomIdOrAlias: string;
			eventId: string;
			viaServers: string[];
	  }
	| { kind: "user"; userId: string };

/**
 * Parse a link href into a Matrix permalink target, or return `null` when
 * the href is not a Matrix permalink (ordinary http(s) links, mailto, other
 * schemes, malformed input) - those keep the anchor's default external-open
 * behavior.
 *
 * Accepted forms:
 *   - `https://matrix.to/#/!id:server` / `#/%23alias:server` / `#/@user:server`
 *     (http and other-cased hosts are tolerated)
 *   - `https://matrix.to/#/!id:server/$event:server` (event permalink; the
 *     room part may be an alias)
 *   - `?via=s1.org&via=s2.org` on matrix.to room/event forms (dropped for
 *     user links, which have no use for join hints)
 *   - `matrix:r/alias:server`, `matrix:roomid/id:server`, `matrix:u/user:server`
 *   - `matrix:roomid/id:server/e/eventid` (event permalink - deliberately
 *     NOT accepted under matrix:r/, where the spec defines no event form)
 *
 * Via servers that fail hostname validation are dropped rather than failing
 * the whole link: a click handler has no error surface, and a permalink with
 * one bad hint still routes better than one treated as unparseable. The
 * list is also capped (see MAX_VIA_SERVERS) since the href is wire-controlled.
 */
export function parseMatrixUri(href: string): MatrixUriTarget | null {
	const trimmed = href.trim();
	if (/^matrix:/i.test(trimmed)) {
		return parseMatrixScheme(trimmed.slice("matrix:".length));
	}
	return parseMatrixToUrl(trimmed);
}

/** Parse an `https://matrix.to/#/...` URL. */
function parseMatrixToUrl(href: string): MatrixUriTarget | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.hostname.toLowerCase() !== "matrix.to") return null;
	// The identifier lives in the fragment (`#/!id:server?via=...`); the
	// query string is part of the fragment, not the URL's own search.
	if (!url.hash.startsWith("#/")) return null;
	return parseIdentifierPath(url.hash.slice(2));
}

/** Parse the path of a `matrix:` URI (the part after `matrix:`). */
function parseMatrixScheme(path: string): MatrixUriTarget | null {
	const qIdx = path.indexOf("?");
	const rawPath = qIdx >= 0 ? path.slice(0, qIdx) : path;
	const query = qIdx >= 0 ? path.slice(qIdx + 1) : "";
	const segments = rawPath.split("/");
	const [typeSeg, idSeg, ...rest] = segments;
	if (typeSeg === undefined || idSeg === undefined) return null;
	const id = decodeSegment(idSeg);
	if (id === null) return null;

	if (typeSeg === "u") {
		if (rest.length > 0) return null;
		const userId = `@${id}`;
		return validateMatrixUserId(userId).ok ? { kind: "user", userId } : null;
	}

	let idOrAlias: string;
	if (typeSeg === "r") {
		idOrAlias = `#${id}`;
	} else if (typeSeg === "roomid") {
		idOrAlias = `!${id}`;
	} else {
		return null;
	}
	if (!validateRoomIdOrAlias(idOrAlias).ok) return null;
	const viaServers = parseViaServers(query);

	if (rest.length === 0) {
		return { kind: "room", idOrAlias, viaServers };
	}
	// Event permalink: `matrix:roomid/<id>/e/<event id>`.
	const [eventType, eventSegment, ...extraSegments] = rest;
	if (
		typeSeg === "roomid" &&
		eventType === "e" &&
		eventSegment !== undefined &&
		extraSegments.length === 0
	) {
		const eventId = decodeSegment(eventSegment);
		if (eventId === null) return null;
		const withSigil = `$${eventId}`;
		if (!isValidEventId(withSigil)) return null;
		return {
			kind: "event",
			roomIdOrAlias: idOrAlias,
			eventId: withSigil,
			viaServers,
		};
	}
	return null;
}

/**
 * Parse a matrix.to fragment path (`!id:server/$event:server?via=s1.org`):
 * `<identifier>[/<event id>]` with an optional query.
 */
function parseIdentifierPath(pathAndQuery: string): MatrixUriTarget | null {
	const qIdx = pathAndQuery.indexOf("?");
	const rawPath = qIdx >= 0 ? pathAndQuery.slice(0, qIdx) : pathAndQuery;
	const query = qIdx >= 0 ? pathAndQuery.slice(qIdx + 1) : "";
	const segments = rawPath.split("/");
	if (segments.length < 1 || segments.length > 2) return null;

	const [identifierSegment = "", eventSegment] = segments;
	const identifier = decodeSegment(identifierSegment);
	if (identifier === null || identifier === "") return null;

	if (identifier.startsWith("@")) {
		if (segments.length > 1) return null;
		return validateMatrixUserId(identifier).ok
			? { kind: "user", userId: identifier }
			: null;
	}

	if (!identifier.startsWith("!") && !identifier.startsWith("#")) return null;
	if (!validateRoomIdOrAlias(identifier).ok) return null;
	const viaServers = parseViaServers(query);

	if (segments.length === 1) {
		return { kind: "room", idOrAlias: identifier, viaServers };
	}
	if (eventSegment === undefined) return null;
	const eventId = decodeSegment(eventSegment);
	if (eventId === null || !isValidEventId(eventId)) return null;
	return {
		kind: "event",
		roomIdOrAlias: identifier,
		eventId,
		viaServers,
	};
}

/**
 * Extract `via=` server hints from a query string. Unknown params (e.g.
 * matrix: `action=`) are ignored. Invalid hostnames are dropped (see the
 * `parseMatrixUri` doc), the rest are de-duplicated in order and capped at
 * MAX_VIA_SERVERS - the href is wire-controlled, so the dedupe scan needs
 * a bound.
 */
const MAX_VIA_SERVERS = 10;

function parseViaServers(query: string): string[] {
	const viaServers: string[] = [];
	for (const part of query.split("&")) {
		if (!part) continue;
		const eq = part.indexOf("=");
		const key = eq >= 0 ? part.slice(0, eq) : part;
		if (key !== "via") continue;
		const server = decodeSegment(eq >= 0 ? part.slice(eq + 1) : "");
		if (server === null || server === "") continue;
		if (!isValidServerName(server)) continue;
		if (viaServers.includes(server)) continue;
		if (viaServers.length >= MAX_VIA_SERVERS) break;
		viaServers.push(server);
	}
	return viaServers;
}

function decodeSegment(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

/**
 * Event IDs are `$`-prefixed opaque strings. v1 room event IDs carry a
 * server (`$localpart:server`); v3+ are bare hashes, so no server portion is
 * required - only non-emptiness and the absence of whitespace/control chars.
 */
function isValidEventId(eventId: string): boolean {
	if (!eventId.startsWith("$") || eventId.length < 2) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional - reject control chars from wire input.
	return !/[\s\x00-\x1f\x7f]/.test(eventId);
}
