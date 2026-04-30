/**
 * Resolve a homeserver base URL from user input using .well-known discovery.
 * Accepts bare domain ("no.strange.pizza") or user ID ("@user:no.strange.pizza").
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

	// Strip any protocol prefix the user may have typed
	server = server.replace(/^https?:\/\//, "").replace(/\/+$/, "");

	// Try .well-known discovery
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

	return `https://${server}`;
}
