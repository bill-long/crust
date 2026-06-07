/**
 * Path extensions treated as directly-playable HTML5 video. Detection is
 * by URL path only — the query string is ignored so signed/expiring CDN
 * links (e.g. Discord's `?ex=&is=&hm=` attachment params) still match.
 *
 * `.ogg` is ambiguous (audio or video) but commonly carries Theora video;
 * the `<video>` element plays audio-only Ogg as well, so it's included.
 */
const VIDEO_EXTENSIONS: readonly string[] = [
	".mp4",
	".m4v",
	".webm",
	".ogv",
	".ogg",
	".mov",
];

/**
 * True iff `url` is an `https:` link whose path ends in a known direct-video
 * extension. The query string and fragment are ignored so signed CDN links
 * (Discord attachment URLs carry `?ex=&is=&hm=`) are still recognized.
 *
 * `https:` only: the inline player's CSP (`media-src ... https:`) and the
 * mixed-content rules of an HTTPS-served app would block an `http:` source
 * anyway, so treating `http:` links as playable would only produce a broken
 * player. This mirrors the `https:`-only check in `gifUrl.ts`.
 *
 * Extension sniffing on the path is simple but imperfect — a more accurate
 * check would HEAD the URL for its `Content-Type`, but that would leak the
 * user's IP to the third-party origin before they opt in, which defeats the
 * click-to-load privacy posture.
 */
export function isDirectVideoUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") {
		return false;
	}
	const path = parsed.pathname.toLowerCase();
	return VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext));
}
