import { render } from "solid-js/web";
import { App } from "./app/App";
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

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

render(() => <App />, root);
