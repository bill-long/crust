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

	// Normalize through URL parsing so paths/query/fragments are stripped
	// consistently for both explicit URLs and bare server names.
	let scheme = "https";
	const hasExplicitScheme = /^https?:\/\//i.test(server);
	try {
		const parsed = new URL(hasExplicitScheme ? server : `https://${server}`);
		if (hasExplicitScheme) {
			scheme = parsed.protocol.replace(":", "");
		}
		server = parsed.host;
	} catch {
		// Malformed input — strip scheme/path and fall back
		if (hasExplicitScheme) {
			scheme = /^http:\/\//i.test(server) ? "http" : "https";
		}
		server = server
			.replace(/^https?:\/\//i, "")
			.replace(/[/?#].*$/, "")
			.replace(/\/+$/, "");
	}

	if (!server) {
		throw new Error("Please enter a homeserver address.");
	}

	// Validate server is a usable hostname
	try {
		new URL(`https://${server}`);
	} catch {
		throw new Error("Please enter a valid homeserver address.");
	}

	// Try .well-known discovery (always over HTTPS per Matrix spec)
	try {
		const res = await fetch(`https://${server}/.well-known/matrix/client`);
		if (res.ok) {
			const data = await res.json();
			const baseUrl: string | undefined = data?.["m.homeserver"]?.base_url;
			if (baseUrl) {
				try {
					const parsed = new URL(baseUrl);
					if (parsed.protocol === "http:" || parsed.protocol === "https:") {
						return baseUrl.replace(/\/+$/, "");
					}
				} catch {
					// Invalid well-known URL — fall through to direct
				}
			}
		}
	} catch {
		// .well-known unavailable — fall through to direct URL
	}

	return `${scheme}://${server}`;
}
