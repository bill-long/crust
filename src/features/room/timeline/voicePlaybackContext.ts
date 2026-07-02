/**
 * Shared AudioContext for voice-message playback. Browsers cap concurrent
 * realtime contexts (and each is heavyweight), so all VoiceMessage
 * instances play through this one lazily-created context instead of one
 * per component. It is intentionally never closed: contexts are designed
 * to live for the page's lifetime, and closing/reopening churns the audio
 * pipeline.
 */

let shared: AudioContext | null = null;

/** The shared playback context, created on first use (call from a user
 *  gesture so strict-autoplay browsers start it running). Returns null
 *  where Web Audio is unavailable. */
export function getVoicePlaybackContext(): AudioContext | null {
	if (typeof AudioContext === "undefined") return null;
	if (!shared) {
		try {
			shared = new AudioContext();
		} catch {
			// Construction can throw in restricted environments or when the
			// browser's context limit is hit. Fail closed; `shared` stays
			// null so a later attempt (Retry) constructs again.
			return null;
		}
	}
	if (shared.state === "suspended") {
		void shared.resume().catch(() => {});
	}
	return shared;
}

/** Test-only: drop the cached context so per-test AudioContext stubs
 *  don't leak across cases. */
export function resetVoicePlaybackContextForTests(): void {
	shared = null;
}
