/**
 * Sanitize a file-provided name for use as a Matrix `filename`/`body` and as a
 * UI/ARIA label: drop ASCII control characters (C0 range + DEL) and path
 * separators, trim surrounding whitespace, and fall back to "file" when
 * nothing usable remains. Mirrors the receive-side control-char guard so
 * whitespace-only or control-bearing names don't produce blank labels or odd
 * filenames in other clients.
 */
export function sanitizeFilename(name: string | undefined | null): string {
	if (!name) return "file";
	let out = "";
	for (let i = 0; i < name.length; i++) {
		const c = name.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) continue; // ASCII control chars
		const ch = name[i];
		if (ch === "/" || ch === "\\") continue; // path separators
		out += ch;
	}
	out = out.trim();
	return out || "file";
}
