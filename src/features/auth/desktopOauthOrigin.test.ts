import { describe, expect, it } from "vitest";
import desktopConf from "../../../desktop/src-tauri/tauri.conf.json";

/**
 * Locks the desktop webview to the https origin (issue #486).
 *
 * OAuth dynamic registration sends `window.location.origin` as client_uri,
 * and the OP rejects non-HTTPS ("Client URI must be HTTPS."), which made
 * OAuth login unusable in the desktop shell while it served
 * http://tauri.localhost. `useHttpsScheme` is also an origin change: turning
 * it off again would orphan every installed client's storage a second time,
 * so it must never be flipped casually.
 */
describe("desktop webview origin", () => {
	it("serves the packaged app over https://tauri.localhost", () => {
		for (const win of desktopConf.app.windows) {
			expect(win.useHttpsScheme).toBe(true);
		}
	});
});
