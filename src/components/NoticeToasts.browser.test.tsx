/**
 * Browser-mode tests for NoticeToasts: it renders notices from the store, and a
 * notice can be dismissed. Runs in browser mode for real DOM/click behavior.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import "../styles/global.css";
import { clearNotices, pushNotice } from "../stores/notices";
import { NoticeToasts } from "./NoticeToasts";

afterEach(() => {
	cleanup();
	clearNotices();
});

/** The single aria-live region that wraps the toasts. */
function liveRegion(): HTMLElement {
	const el = document.querySelector<HTMLElement>('[aria-live="polite"]');
	if (!el) throw new Error("notice live region not found");
	return el;
}

describe("NoticeToasts", () => {
	it("renders a pushed notice inside the aria-live region", async () => {
		const { findByText } = render(() => <NoticeToasts />);
		pushNotice("Couldn't send GIF to Room A", "error");
		const message = await findByText("Couldn't send GIF to Room A");
		// Announced once, via the container live region (children are not
		// themselves role=status, to avoid a double announcement).
		expect(liveRegion().contains(message)).toBe(true);
	});

	it("removes a notice when its dismiss button is clicked", async () => {
		const { findByLabelText, queryByText } = render(() => <NoticeToasts />);
		pushNotice("dismiss me");
		const dismiss = await findByLabelText("Dismiss notification");
		dismiss.click();
		expect(queryByText("dismiss me")).toBeNull();
	});

	it("renders multiple notices in push order", async () => {
		const { findByText } = render(() => <NoticeToasts />);
		pushNotice("first");
		pushNotice("second");
		await findByText("second");
		const text = liveRegion().textContent ?? "";
		expect(text.indexOf("first")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("second")).toBeGreaterThan(text.indexOf("first"));
	});
});
