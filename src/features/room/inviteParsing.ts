import { validateMatrixUserId } from "./inviteValidation";

export interface ParsedInvites {
	mxids: string[];
	error: string | null;
}

/**
 * Split a free-form invite string on whitespace / comma / semicolon, validate
 * each token as a Matrix user ID, drop the caller's own ID, and dedupe.
 * Returns the first invalid token's error if any token fails validation.
 */
export function parseInvites(
	raw: string,
	selfId: string | null,
): ParsedInvites {
	const tokens = raw
		.split(/[\s,;]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (tokens.length === 0) return { mxids: [], error: null };
	const out = new Set<string>();
	for (const tok of tokens) {
		const r = validateMatrixUserId(tok);
		if (!r.ok) return { mxids: [], error: `${tok}: ${r.error}` };
		if (r.userId === selfId) continue;
		out.add(r.userId);
	}
	return { mxids: Array.from(out), error: null };
}
