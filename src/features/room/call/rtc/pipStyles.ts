/**
 * Copy the opener document's styles into a Document Picture-in-Picture window.
 *
 * A PiP window is a fresh, empty same-origin document with none of the app's
 * stylesheets — so a component rendered into it would be unstyled (and, worse,
 * the design tokens defined on `:root` in `global.css` would be missing, so
 * every `bg-surface-*`/`text-*` utility would resolve to nothing). We mirror the
 * opener's stylesheets and the relevant `<html>` attributes so the overlay
 * renders identically to the main app, including the active color scheme and
 * any applied zoom.
 *
 * Same-origin sheets (Tailwind's output + `global.css`, whether injected as a
 * `<style>` in dev or served as a `<link>` in prod) expose `cssRules`, so we
 * inline each one into its own `<style>` element in the PiP head. The `<link>`
 * fallback covers any sheet whose `cssRules` access throws (e.g. a cross-origin
 * sheet), so we never drop styling silently.
 */

function inlineStyleSheet(sheet: CSSStyleSheet, target: Document): boolean {
	try {
		// Accessing cssRules throws a SecurityError for cross-origin sheets.
		const rules = sheet.cssRules;
		let css = "";
		for (let i = 0; i < rules.length; i++) {
			css += rules[i].cssText;
		}
		const style = target.createElement("style");
		style.textContent = css;
		target.head.appendChild(style);
		return true;
	} catch {
		return false;
	}
}

function linkStyleSheet(sheet: CSSStyleSheet, target: Document): void {
	if (!sheet.href) return;
	const link = target.createElement("link");
	link.rel = "stylesheet";
	if (sheet.media?.mediaText) link.media = sheet.media.mediaText;
	link.href = sheet.href;
	target.head.appendChild(link);
}

/**
 * Mirror every stylesheet from `source` into `target`'s head, plus the `<html>`
 * inline style (carries `zoom` / `--app-zoom`), class list, and `lang`, so the
 * PiP document matches the main app's theme and scale. The active color scheme
 * carries over through the copied stylesheets and the mirrored inline style — it
 * is not copied as a separate attribute.
 */
export function copyStylesIntoPipDocument(
	source: Document,
	target: Document,
): void {
	const sheets = source.styleSheets;
	for (let i = 0; i < sheets.length; i++) {
		const sheet = sheets[i];
		if (!(sheet instanceof CSSStyleSheet)) continue;
		if (!inlineStyleSheet(sheet, target)) {
			linkStyleSheet(sheet, target);
		}
	}

	// Mirror the root element's inline style (zoom is applied there) and class
	// list so rem-based sizing and any theme class carry into the PiP document.
	const srcRoot = source.documentElement;
	const dstRoot = target.documentElement;
	const inlineStyle = srcRoot.getAttribute("style");
	if (inlineStyle) dstRoot.setAttribute("style", inlineStyle);
	if (srcRoot.className) dstRoot.className = srcRoot.className;
	const lang = srcRoot.getAttribute("lang");
	if (lang) dstRoot.setAttribute("lang", lang);

	// Reset the PiP body so the panel fills it edge-to-edge with no default
	// margin and inherits the app surface color (avoids a white flash).
	target.body.style.margin = "0";
	target.body.style.height = "100vh";
	target.body.style.overflow = "hidden";
}
