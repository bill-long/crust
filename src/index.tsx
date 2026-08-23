import { render } from "solid-js/web";
import { App } from "./app/App";
import { registerNativeServiceWorker } from "./app/registerNativeServiceWorker";
import { initMediaAuthSw } from "./lib/authedMedia";
import { loadSession } from "./stores/session";
import { initZoom } from "./stores/settings";
import "./styles/global.css";

initZoom();
// Answer service-worker media-auth pulls (and re-push on SW ready) so the
// worker can attach the session token to authenticated-media requests
// (MSC3916) even after it has been restarted. See lib/authedMedia.ts.
initMediaAuthSw(() => {
	const session = loadSession();
	return session
		? { accessToken: session.accessToken, homeserverUrl: session.homeserverUrl }
		: null;
});
// In the desktop shell the worker that answers those pulls is registered here
// (the browser build's registration lives in app/UpdatePrompt.tsx); a no-op in
// a browser. See app/registerNativeServiceWorker.ts.
void registerNativeServiceWorker();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

render(() => <App />, root);
