import { describe, expect, it } from "vitest";
// Load Layout's source text via Vite's `?raw` import (the repo types `*?raw`
// through vite/client; it has no @types/node, so no fs/path here).
import layoutSource from "../../../app/Layout.tsx?raw";

/**
 * Lock for the composer's room-isolation assumption (issue #382).
 *
 * The composer has no in-place room-switch guards: its send paths write
 * completion state (onSent, setError, setSending, focus) unconditionally, and
 * there is no "reset on roomId change" effect. That is only correct because
 * Layout renders the room subtree under a `keyed` `<Show>` gated on `roomId()`,
 * so a room switch REMOUNTS Composer/TimelineView and each room gets fresh
 * state. If someone drops `keyed` (e.g. a perf change to avoid remounting the
 * timeline), the guards would need to come back - this test fails loudly first,
 * rather than letting a silent cross-room state bug ship.
 *
 * It is a source-structure assertion (the invariant is a JSX prop, not runtime
 * behavior, and the codebase deliberately has no full-Layout render test).
 */
// Tolerates whitespace variations (e.g. `when={ roomId() }`).
const WHEN_ROOM_ID = /when=\{\s*roomId\(\)\s*\}/;

describe("Layout room-pane <Show> keeps the composer's remount contract", () => {
	it("renders the room pane via a <Show> gated on roomId()", () => {
		expect(
			WHEN_ROOM_ID.test(layoutSource),
			"Layout must render the room pane via <Show when={roomId()}> - the composer's room isolation depends on it (#382).",
		).toBe(true);
	});

	it("keeps that <Show> `keyed` so a room switch remounts the composer", () => {
		const whenMatch = WHEN_ROOM_ID.exec(layoutSource);
		if (!whenMatch) {
			// Guarded so this fails with a clear message rather than a null deref
			// (the first test already covers the missing-invariant case).
			throw new Error(
				"Layout must render the room pane via <Show when={roomId()}> - the composer's room isolation depends on it (#382).",
			);
		}
		const whenIdx = whenMatch.index;
		const tagStart = layoutSource.lastIndexOf("<Show", whenIdx);
		// Bound the opening tag by its render-prop child `{(...) => ...}`: `keyed`
		// is one of the attributes before it. This is robust to attribute order,
		// fallback size, and whitespace, and stops well before any other <Show> in
		// the file - unlike a fixed-width window.
		const childrenIdx = layoutSource.indexOf("{(", whenIdx);
		expect(
			childrenIdx,
			"expected the room <Show> to use a keyed render-prop child `{(rid) => ...}`",
		).toBeGreaterThan(whenIdx);
		const openingTag = layoutSource.slice(tagStart, childrenIdx);
		expect(
			/\bkeyed\b/.test(openingTag),
			"The room-pane <Show when={roomId()}> must stay `keyed` so a room switch REMOUNTS Composer/TimelineView. It was removed - restore `keyed`, or re-add the composer's in-place room-switch guards (see #382).",
		).toBe(true);
	});
});
