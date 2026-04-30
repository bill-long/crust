/**
 * Resolve a homeserver base URL from user input using .well-known discovery.
 * Accepts bare domain ("no.strange.pizza"), user ID ("@user:no.strange.pizza"),
 * or full URL ("https://no.strange.pizza").
 */
export async function discoverHomeserver(input: string): Promise<string> {
	let server = input.trim();

	// Extract server from @user:server format
	if (server.startsWith("@")) {
		const colonIdx = server.indexOf(":", 1);
		if (colonIdx > 0) {
			server = server.substring(colonIdx + 1);
		}
	}

	// If the input looks like a URL, parse it properly to extract origin + strip path
	let scheme = "https";
	if (/^https?:\/\//i.test(server)) {
		try {
			const parsed = new URL(server);
			scheme = parsed.protocol.replace(":", "");
			server = parsed.host;
		} catch {
			// Malformed URL — strip prefix and hope for the best
			scheme = /^http:\/\//i.test(server) ? "http" : "https";
			server = server.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
		}
	}

	// Strip trailing slashes from bare input
	server = server.replace(/\/+$/, "");

	// Try .well-known discovery (always over HTTPS per Matrix spec)
	try {
		const res = await fetch(`https://${server}/.well-known/matrix/client`);
		if (res.ok) {
			const data = await res.json();
			const baseUrl: string | undefined = data?.["m.homeserver"]?.base_url;
			if (baseUrl) {
				return baseUrl.replace(/\/+$/, "");
			}
		}
	} catch {
		// .well-known unavailable — fall through to direct URL
	}

	return `${scheme}://${server}`;
}
