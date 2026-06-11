import { createSignal } from "solid-js";

// Below Tailwind's `md` breakpoint (768px) we collapse the three-pane desktop
// layout into a single-pane, route-driven mobile layout. A module-level signal
// keeps one matchMedia listener for the whole app lifetime and lets any
// component react to viewport changes (orientation, window resize, dev tools).
const MOBILE_QUERY = "(max-width: 767px)";

function createMatcher(): MediaQueryList | null {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return null;
	}
	return window.matchMedia(MOBILE_QUERY);
}

const mql = createMatcher();
const [isMobile, setIsMobile] = createSignal(mql?.matches ?? false);

if (mql) {
	mql.addEventListener("change", (e) => setIsMobile(e.matches));
}

/** Whether the viewport is narrow enough to use the single-pane mobile layout. */
export { isMobile };
