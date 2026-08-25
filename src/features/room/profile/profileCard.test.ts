import { describe, expect, it } from "vitest";
import { profileAnchorKey } from "./profileCard";

describe("profileAnchorKey", () => {
	it("survives the attribute round-trip the re-anchor watch uses", () => {
		// A regression here is invisible in review (an unprintable separator
		// once made git treat the file as binary) and silently breaks the
		// open card's re-anchoring, so pin the exact runtime path: set as an
		// attribute, read back, compare byte-for-byte.
		const key = profileAnchorKey("!room:example.com", "@alice:example.com");
		const el = document.createElement("button");
		el.setAttribute("data-profile-anchor", key);
		document.body.appendChild(el);
		try {
			const match = [
				...document.querySelectorAll("[data-profile-anchor]"),
			].find((e) => e.getAttribute("data-profile-anchor") === key);
			expect(match).toBe(el);
		} finally {
			el.remove();
		}
	});

	it("distinguishes the same user across rooms", () => {
		expect(profileAnchorKey("!a:hs", "@u:hs")).not.toBe(
			profileAnchorKey("!b:hs", "@u:hs"),
		);
	});
});
