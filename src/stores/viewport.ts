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
	const onChange = (e: MediaQueryListEvent): void => {
		setIsMobile(e.matches);
	};
	// Safari < 14 and some older WebKit builds only expose the deprecated
	// `addListener` rather than `addEventListener("change", …)`. Feature-detect
	// so viewport detection doesn't throw (and silently break) on those engines.
	if (typeof mql.addEventListener === "function") {
		mql.addEventListener("change", onChange);
	} else {
		mql.addListener(onChange);
	}
}

/** Whether the viewport is narrow enough to use the single-pane mobile layout. */
export { isMobile };
