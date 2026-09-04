// The self-signed localhost certificate behind `pnpm dev:https` (#468).
//
// Continuwuity rejects an OAuth dynamic client registration whose
// `client_uri` is not HTTPS ("Client URI must be HTTPS."), so the OAuth login
// flow cannot be exercised from the plain `pnpm dev` origin. `pnpm dev:https`
// is `vite --mode https`; vite.config.ts turns that mode into `server.https`
// backed by the pair this module keeps. The certificate is self-signed, so the
// browser warns once per profile; that is the accepted trade for a dev-only
// mode, and it adds no dependency. Nothing here runs in the build.
//
// The rules worth a test: the pair is regenerated when it is missing, half
// present (an interrupted run), unparseable, mismatched, or within a day of
// expiry; and OpenSSL is found where Windows keeps it when it is not on PATH.

import { execFileSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `.pem` on both halves on purpose, and it is the whole mitigation: Vite's
// default `server.fs.deny` refuses to serve `*.pem` (and `*.crt`), while a
// `.key` file inside the project root would be served like any other file.
// vite.config.ts does not extend `fs.deny`, because setting it replaces the
// default list rather than adding to it.
export const DEV_CERT_FILES = {
	key: "localhost-key.pem",
	cert: "localhost-cert.pem",
};

/**
 * Regenerate this close to expiry rather than at it: Vite resolves the
 * certificate once at startup and Node never re-checks its dates, so a pair
 * that crosses `validTo` mid-session leaves the browser on
 * NET::ERR_CERT_DATE_INVALID until the server is restarted.
 */
const RENEWAL_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Where to find `openssl`. On PATH is the normal answer; on Windows, Git for
 * Windows ships one but only puts `Git\cmd` on PATH, so the mingw64 and usr
 * copies are probed as well. `null` when none is found.
 */
export function resolveOpenssl({
	platform = process.platform,
	env = process.env,
	onPath = runsFromPath,
	exists = existsSync,
} = {}) {
	if (onPath("openssl")) return "openssl";
	if (platform !== "win32") return null;
	const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
		.filter(Boolean)
		.map((base) =>
			join(base, base === env.LOCALAPPDATA ? "Programs/Git" : "Git"),
		);
	for (const root of roots) {
		for (const sub of ["mingw64/bin", "usr/bin"]) {
			const candidate = join(root, sub, "openssl.exe");
			if (exists(candidate)) return candidate;
		}
	}
	return null;
}

function runsFromPath(cmd) {
	try {
		execFileSync(cmd, ["version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether the stored pair can back a dev server: both files readable, the
 * certificate parses, the key parses and belongs to it, and the certificate
 * has more than the renewal margin left. Anything else (a missing half from
 * an interrupted run included) is regenerated rather than handed to Vite,
 * which would fail at startup on a corrupt or mismatched pair with an OpenSSL
 * decoder error and no hint to delete .dev-certs/.
 */
export function pairIsUsable(keyPath, certPath, now = new Date()) {
	try {
		const cert = new X509Certificate(readFileSync(certPath));
		if (!cert.checkPrivateKey(createPrivateKey(readFileSync(keyPath)))) {
			return false;
		}
		return new Date(cert.validTo).getTime() - now.getTime() > RENEWAL_MARGIN_MS;
	} catch {
		return false;
	}
}

/**
 * Make sure `dir` holds a usable key/cert pair, generating one with OpenSSL
 * otherwise. `run(cmd, args)` executes a command and throws on failure;
 * injected, like the OpenSSL lookup and `now`, so the rules are testable
 * without a real OpenSSL. The lookup runs only when a pair has to be
 * generated (it spawns a process, and this is evaluated with the Vite
 * config), and finding nothing throws a message that says what to install.
 */
export function ensureDevCert(
	dir,
	{ run, findOpenssl = resolveOpenssl, now = new Date() },
) {
	const keyPath = join(dir, DEV_CERT_FILES.key);
	const certPath = join(dir, DEV_CERT_FILES.cert);
	if (!pairIsUsable(keyPath, certPath, now)) {
		const bin = findOpenssl();
		if (!bin) {
			throw new Error(
				"dev:https needs OpenSSL to generate the localhost certificate: put " +
					"`openssl` on PATH (Git for Windows ships one under Git\\mingw64\\bin, " +
					"which is probed automatically; on Linux/macOS it is a package away).",
			);
		}
		mkdirSync(dir, { recursive: true });
		console.log(
			`dev:https: generating a self-signed localhost certificate in ${dir}`,
		);
		// A SAN for the name and both loopback addresses, since Chrome ignores
		// the CN; `-nodes` because a dev key with a passphrase is one nobody can
		// use; a year, after which `pairIsUsable` has it regenerated.
		run(bin, [
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-days",
			"365",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
		]);
	}
	return { key: keyPath, cert: certPath };
}
