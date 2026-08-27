/**
 * The shape a search result takes once it has left the Matrix layer, and the
 * query handling that goes with it.
 *
 * Deliberately free of SDK types: both the per-room search panel and the
 * global one render the same row, and a component in `components/` may not
 * know about Matrix (AGENTS.md). The projection that turns a `MatrixEvent`
 * into one of these lives in `client/searchProjection.ts`.
 */
export interface SearchHit {
	eventId: string;
	sender: string;
	senderName: string;
	timestamp: number;
	body: string;
	/** Set when the hit is a thread reply: the root whose panel shows it.
	 *  Jumps carry it so the room pane opens the thread panel instead of
	 *  anchoring the main timeline (issue #334). */
	threadRootId?: string;
}

/**
 * Longest query we will send or scan for.
 *
 * The field is user input that reaches both a server request and a
 * per-message substring scan, and neither gets better past this length.
 */
export const MAX_QUERY_LEN = 256;

/** Splits a query into trimmed lowercase tokens. */
export function splitQueryTokens(q: string): string[] {
	return q
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
}

/** True iff `body` contains every token (case-insensitive). */
export function matchesAllTokens(body: string, tokens: string[]): boolean {
	if (tokens.length === 0) return false;
	const haystack = body.toLowerCase();
	return tokens.every((n) => haystack.includes(n));
}
