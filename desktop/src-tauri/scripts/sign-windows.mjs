#!/usr/bin/env node
// Authenticode-signs one Windows artifact in place, using the SSL.com eSigner
// cloud HSM. The private key never leaves SSL.com: jsign sends only the file's
// hash to the eSigner CSC API and writes the returned signature back into the
// file (PE .exe and .msi alike).
//
// The Tauri bundler invokes this once per artifact via
// `bundle > windows > signCommand` in tauri.conf.json, passing the artifact
// path in place of "%1". It offers 11 files per release build; see SKIP_RULES
// below for the ones this declines to sign and why. The five that are signed
// are the main binary (twice - the bundler re-patches and re-signs it for each
// package type), the .msi, the NSIS -setup.exe, and the uninstaller makensis
// builds in a temp file.
//
// Credentials come from the environment, never from the config file:
//   ESIGNER_USERNAME       SSL.com account username
//   ESIGNER_PASSWORD       SSL.com account password
//   ESIGNER_CREDENTIAL_ID  eSigner signing credential (certificate) UUID
//   ESIGNER_TOTP_SECRET    base64 TOTP secret from the eSigner automation setup
//   JSIGN_JAR              path to jsign-<version>.jar
//   ESIGNER_ENDPOINT       optional; https://cs-try.ssl.com for the sandbox
//
// With none of the four credentials set, this skips signing and exits 0 so
// local builds and PR/fork CI still produce (unsigned) installers. Release
// builds are protected the other way round: the workflow refuses to build a
// desktop-v* tag without the secrets, and verifies the signatures afterwards.
// See .github/workflows/desktop-release.yml and desktop/README.md.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Pinned by the workflow; kept here only for the error message. */
const JSIGN_HINT =
	"Download jsign (https://ebourg.github.io/jsign/) and point JSIGN_JAR at the jar.";

/** SSL.com's RFC 3161 timestamp authority. */
const TIMESTAMP_URL = "http://ts.ssl.com";

// eSigner subscriptions meter signatures (the entry tiers are 20/month), so
// the bundler's default "sign every PE it touches" is too expensive. These two
// categories are declined; anything else the bundler offers is signed, so a
// new shipped artifact is signed by default rather than silently skipped.
const SKIP_RULES = [
	{
		// WiX toolset extensions: inputs to candle/light on the build machine,
		// never part of the installed app.
		test: (path) => /[\\/]target[\\/]release[\\/]wix[\\/]/i.test(path),
		reason: "WiX build-time toolset, not shipped",
	},
	{
		// NSIS plugins do ship inside the installer, but are unpacked into
		// $PLUGINSDIR and loaded by the already-signed installer; Windows does
		// not check their signatures.
		test: (path) => /[\\/]nsis[\\/].*[\\/]Plugins[\\/]/i.test(path),
		reason: "NSIS plugin loaded by the signed installer",
	},
];

const CREDENTIAL_VARS = [
	"ESIGNER_USERNAME",
	"ESIGNER_PASSWORD",
	"ESIGNER_CREDENTIAL_ID",
	"ESIGNER_TOTP_SECRET",
];

/** Signing attempts. Only a failed eSigner authorization is retried: that step
 * runs before the hash is submitted, so a rejected OTP (a runner clock sitting
 * near a window boundary) costs no metered signature and clears in the next
 * 30-second window. A later failure - a timestamping timeout, say - has already
 * spent one, and jsign retries the TSA itself (--tsretries below), so retrying
 * the whole invocation would only burn the monthly allowance. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 31_000;

/** jsign's wording for the authorization failures, all raised pre-signature. */
const RETRYABLE =
	/invalid otp|authentication failed with ssl\.com|signing authorization/i;

const fail = (message) => {
	console.error(`[sign] ${message}`);
	process.exit(1);
};

const target = process.argv[2];
if (!target) fail("no artifact path given (expected the bundler's %1).");
if (!existsSync(target)) fail(`artifact not found: ${target}`);

// Notices go to stdout: the bundler pipes both streams and echoes only stdout,
// under "Output of signing command". On a failing run it echoes neither, which
// is why CI builds pass --verbose (that logs both at debug level).
const skip = SKIP_RULES.find((rule) => rule.test(target));
if (skip) {
	console.log(`[sign] skipped ${target} (${skip.reason})`);
	process.exit(0);
}

// Trimmed, so a secret pasted with a stray newline reads as absent here and
// trips the guard below rather than surfacing as an eSigner auth failure much
// later. This matches the workflow's own IsNullOrWhiteSpace check. The values
// themselves are passed to jsign untouched.
const isSet = (name) => Boolean(process.env[name]?.trim());
const present = CREDENTIAL_VARS.filter(isSet);
if (present.length === 0) {
	console.log(
		`[sign] SKIPPED (no eSigner credentials in the environment): ${target}`,
	);
	process.exit(0);
}
if (present.length !== CREDENTIAL_VARS.length) {
	const missing = CREDENTIAL_VARS.filter((name) => !isSet(name));
	// Half-configured credentials are a mistake, not a request for an unsigned
	// build -- silently skipping here would ship an unsigned release.
	fail(`eSigner credentials are partially set; missing: ${missing.join(", ")}`);
}

const jar = process.env.JSIGN_JAR;
if (!jar) fail(`JSIGN_JAR is not set. ${JSIGN_HINT}`);
if (!existsSync(jar)) fail(`JSIGN_JAR does not exist: ${jar}. ${JSIGN_HINT}`);

// Prefer the JDK the build selected over whatever `java` resolves to on PATH.
const java = process.env.JAVA_HOME
	? join(process.env.JAVA_HOME, "bin", "java.exe")
	: "java";

const args = [
	"-jar",
	jar,
	"--storetype",
	"ESIGNER",
	// jsign takes the eSigner account as a single "user|password" credential.
	"--storepass",
	`${process.env.ESIGNER_USERNAME}|${process.env.ESIGNER_PASSWORD}`,
	"--alias",
	process.env.ESIGNER_CREDENTIAL_ID,
	"--keypass",
	process.env.ESIGNER_TOTP_SECRET,
	"--alg",
	"SHA-256",
	// Timestamp so signatures stay valid after the certificate expires.
	"--tsaurl",
	TIMESTAMP_URL,
	"--tsmode",
	"RFC3161",
	"--tsretries",
	"5",
	"--tsretrywait",
	"10",
	// The bundler re-signs the main binary once per package type, and an
	// incremental local build reuses an already-signed exe; replace rather than
	// stack a second signature.
	"--replace",
	// Shown in the UAC prompt and the file's Digital Signatures tab.
	"--name",
	"Crust",
	"--url",
	"https://github.com/bill-long/crust",
];
if (process.env.ESIGNER_ENDPOINT) args.push("--keystore", process.env.ESIGNER_ENDPOINT);
args.push(target);

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
	// Captured rather than inherited so the retry decision can read it, then
	// echoed to stdout where the bundler looks. The command itself is never
	// echoed -- the credentials are in argv.
	const result = spawnSync(java, args, { encoding: "utf8" });

	if (result.error) fail(`could not run ${java}: ${result.error.message}`);
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	if (output.trim()) console.log(output.trim());

	if (result.status === 0) {
		console.log(`[sign] signed ${target}`);
		process.exit(0);
	}

	if (attempt === ATTEMPTS || !RETRYABLE.test(output)) {
		fail(
			`jsign failed with exit code ${result.status} on attempt ${attempt}/${ATTEMPTS}: ${target}`,
		);
	}
	console.log(
		`[sign] eSigner rejected the authorization (attempt ${attempt}/${ATTEMPTS}); retrying in ${RETRY_DELAY_MS / 1000}s.`,
	);
	// Block the loop: this process exists only to produce one signature, and
	// the bundler is waiting on its exit code.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_MS);
}
