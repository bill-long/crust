import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEV_CERT_FILES,
	ensureDevCert,
	pairIsUsable,
	resolveOpenssl,
} from "./dev-https-lib.mjs";

/**
 * A self-signed localhost pair valid until 2126-08-11, generated for this
 * test and used for nothing else; the key is a fixture, not a secret.
 */
const KEY_2126 = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCp3X+//x+4y+Bi
NGoIFjWkCM7S38ch50qOj5q24ZtDn9d7iiPK24fkIOqe5CGcBeMGTcfVULGrWb49
pOoj1s7TfshWoRNejubQkjBg4LAhCVsbEAKCPoEsQR49+26NLdxEWDSEHC6cS7PC
uFczhoGOd36Pn3GhV+uqo0r3Q/ZwD8tG+un0URSAE1djJSBK2ti1sl/S4lKVxi/Q
aRCtzyY0VE5lr4i/mvxwHZF93Pg84sDz09kl9fDaOXy2UUsJDiBLVGWv577p8vFw
rvrW2yG+DOjUwXEdGf7v9zmi0cVoAudykPK6o0D+9P3u5hhYWnimSZcDnt6CCnvR
HooASkCjAgMBAAECggEAOfsTOhP5XfipVJwTfUMneCBRiIU90YLDXjoCU15awxBy
WwbiBMI+dk4OB8JS/pC711EBXvy2SIjPePcrvKP74RErjPZaSDJ68sKTpN3NANnS
sUAbux1eth5cFkgWijYXM3TwKA/+kPb+Gv8VNM86tchv+NIx1SLPnGU0l4YpPkJ2
oeEsfThBQBDRtO0QEb+Z3VTuwLZTfvw6sGGuFx9GaSKROoMVyrt5Jx1snGInmerC
Nzsed0E93j2uUDgX3RrES8PY8aRc82ms59TtXfxS9+d1qrrCLo5NpD3TwSF41tK/
cBAIWI6njGWhIi5JcASWf6tBXnBwIKHYJW9sDtSgEQKBgQDo/j5rEInaCl900p37
rjOWv0+94OITQnwnM9+GeoArVPE1Bk4XBB7Q2f+9AiPHrY5LiN4aKCEv+wn+vvUT
FcNPxn/Lg/SD00xBz33X8R4CIErRctR5CWxgy7rSx5a+uCLd9fp+t9KX7lxGJ9/B
j3X2hjYtdGFvlRcRK7s70G8UnwKBgQC6o3c7pBKvHX4IWvBS7XN3jhOTwkpbDOO0
vlx352WfEKFlQZO/h7LIJ7L+L+MqhEVfxB2TBREkNfVT7CnXcROMH8GewU0JJl4s
gtg59TbmBybNc+kdDGrOVkZVy0OEkQbxfbFABqvyehKrX9pr89RvZm+L9qBZDjUG
6MZHLi1xfQKBgQCE+CRzQdsKfwT/TPwwmLiEfeZqfR9I0pa8YNRekSb4k9+c3V5P
sGBN3TwgiEoXOSuOXCw1TVWzZlfL9Ps0yyTOMIDaixJO8ZYBsQMm7Eqt9/P7GMe9
0+zwSRT0GkgjzD7J4gn1q78aSkSLHVKLyu4NpYbh5ht9bN7fQ8/1UP00DQKBgDyR
V9xO/pE9rOzhNiRzUol13fyRjLfHkw3QyQlQWrYoG3hUs7HwQ6CY4YmD2OCvVCQj
7MUNW+a4bAj0FxAHbiSHGbp/WJSjkuQ3Ahys60fzAjCicQAwS2jyrpihAiQ/PFWa
SK9SevKRkwVycdueoU4VnBV7z8WWyraXS+FFpxGxAoGAYvjRFbXApIuMiy0X0DuS
kdoXeqYHV/x/PZfZOCEgMQYKveEgsx/K9q7VvI+i7hDTSYhaMnvRvnkc6ozOVAHq
2fblPmOILH4NveIFuUUICH8hBquiyoDpKhTa6GTbLg48ahfthAy+apP1OLq8/Rxj
LgzzZomNZBWlBcKLbLPYqsw=
-----END PRIVATE KEY-----
`;
const CERT_2126 = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIURtTCrz+H1jS/Er8vr4dsP23h8d8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkwNDAwNTYwN1oYDzIxMjYw
ODExMDA1NjA3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCp3X+//x+4y+BiNGoIFjWkCM7S38ch50qOj5q24ZtD
n9d7iiPK24fkIOqe5CGcBeMGTcfVULGrWb49pOoj1s7TfshWoRNejubQkjBg4LAh
CVsbEAKCPoEsQR49+26NLdxEWDSEHC6cS7PCuFczhoGOd36Pn3GhV+uqo0r3Q/Zw
D8tG+un0URSAE1djJSBK2ti1sl/S4lKVxi/QaRCtzyY0VE5lr4i/mvxwHZF93Pg8
4sDz09kl9fDaOXy2UUsJDiBLVGWv577p8vFwrvrW2yG+DOjUwXEdGf7v9zmi0cVo
AudykPK6o0D+9P3u5hhYWnimSZcDnt6CCnvRHooASkCjAgMBAAGjaTBnMB0GA1Ud
DgQWBBTdZM3NtFl0Tzz7eWSxYU3r+OQn0DAfBgNVHSMEGDAWgBTdZM3NtFl0Tzz7
eWSxYU3r+OQn0DAPBgNVHRMBAf8EBTADAQH/MBQGA1UdEQQNMAuCCWxvY2FsaG9z
dDANBgkqhkiG9w0BAQsFAAOCAQEAJXZJ95k2fESUSP1redFKrlL5W01J+AUBYjTY
TZqxewe4XujkuT81BPhUDZHv/EfLN3WmlZpm9IKHWbgBrqo6NNZ5oS5J9fjPb7bN
nfNfDA6sg7W6z6NxhNDnbiVgQ7YAR4d7bbX9K8hugeeTSn5mbnngrDWPfo439TW2
rS5zmCuaHjlRRtD7/1xGlfSQGBvY6yBQO3fMmC5qFM+bBgOjQyTTD3kzi6AVmxJf
x9qsnW8bUvH0fChPFVaT3G5wC2d62Bv4545062GObNz2BJdrCOVhRGh/xuKFm/hA
uv+Nx6ARFz7uXmZ0ErpYV7UIIjbCAZJZq0HoF/fET1sMqzsfPg==
-----END CERTIFICATE-----
`;
/** An unrelated certificate (different key) that parses fine on its own. */
const OTHER_CERT = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUBIu9wFjSnRCobDa20dEHKcB/1hIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkwNDAwNDE0NVoYDzIxMjYw
ODExMDA0MTQ1WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCO97/e/71r7VVAbvDE8c7YvcoNuz5M5C6weEfS3KP4
HrwFAR06aWu55v3QfP0HZln0pRV/nZ7yKQbJVK/pEslqFdcWN1X584m3CORdAvz3
nE015hlKNSWzXBQRHu5UPA5stBKRxp/o2D4W3J1vzPmd+zOSWnM+Hrt5UpnNzdEk
CctugE2QoepGMTuk7ZXJdkS5RxS1MH6PPqjnHa3SdPGN4uskD2wGoqQ7f7BvEjZV
S4/ahXASQN4TcjqrDpP562tArkeZUlw1knqMqXr47CVe2M+/0isGDkpD6uccSYRw
Ofb3ZnCu1bQedEj9ZkaqJnMrjgO81vB5I3WzAEtnQQrJAgMBAAGjaTBnMB0GA1Ud
DgQWBBTzMizDPDzIlrxeoctx2LfPTH4qmzAfBgNVHSMEGDAWgBTzMizDPDzIlrxe
octx2LfPTH4qmzAPBgNVHRMBAf8EBTADAQH/MBQGA1UdEQQNMAuCCWxvY2FsaG9z
dDANBgkqhkiG9w0BAQsFAAOCAQEAb2OrZl97e3f4vZ3oVNWBB1VWqm8M14bJoEOb
QrZxvVrruxtZKl8mPv65kJnCLSd1/qRwlFwEsUECi93Afs3PrI5aPFOOgmKMSR9x
TpW/FSrrn4EBbPVm1DJ/yUr15K9lbjXRkmw+mgfKks1QJl6WeSEL8sAWujP+sjnn
CI7XoheeP09iEkVeuFkONlniYCC+B/4WJqnjO7cleHtjKCUColxJ+caW2b5Byln4
jIb7YNEsDF+TWiHUzgOjhRbiqQxJTHXpGGpv8q1OGJVNPan07Vx+vNtq6Fa9/EC0
wG5Veyj0nSSARxIxL7Qyep/N0kTZ/4IU5ec4s0gjU+iSpmgwzA==
-----END CERTIFICATE-----
`;

const NOW = new Date("2026-09-04T00:00:00Z");
let dir;
const keyOf = (d) => join(d, DEV_CERT_FILES.key);
const certOf = (d) => join(d, DEV_CERT_FILES.cert);
const writePair = (d, key = KEY_2126, cert = CERT_2126) => {
	writeFileSync(keyOf(d), key);
	writeFileSync(certOf(d), cert);
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "crust-dev-https-"));
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe("pairIsUsable", () => {
	it("is true only for a complete, matching, parseable pair with time left", () => {
		expect(pairIsUsable(keyOf(dir), certOf(dir), NOW)).toBe(false);
		writeFileSync(keyOf(dir), KEY_2126);
		expect(pairIsUsable(keyOf(dir), certOf(dir), NOW)).toBe(false);
		writeFileSync(certOf(dir), "not a certificate");
		expect(pairIsUsable(keyOf(dir), certOf(dir), NOW)).toBe(false);
		writeFileSync(certOf(dir), CERT_2126);
		expect(pairIsUsable(keyOf(dir), certOf(dir), NOW)).toBe(true);
	});

	it("rejects a key that is corrupt or belongs to another certificate", () => {
		// Vite would otherwise die at startup on an OpenSSL decoder or
		// key-mismatch error with no hint to delete .dev-certs/.
		writePair(dir, "not a key", CERT_2126);
		expect(pairIsUsable(keyOf(dir), certOf(dir), NOW)).toBe(false);
		writePair(dir, KEY_2126, OTHER_CERT);
		expect(pairIsUsable(keyOf(dir), certOf(dir), NOW)).toBe(false);
	});

	it("treats the last day before expiry as expired", () => {
		// Vite resolves the certificate once at startup and Node never
		// re-checks its dates, so a pair that expires mid-session would leave
		// the browser on NET::ERR_CERT_DATE_INVALID until a restart.
		writePair(dir);
		const validTo = new Date("2126-08-11T00:56:07Z");
		expect(
			pairIsUsable(
				keyOf(dir),
				certOf(dir),
				new Date(validTo.getTime() - 2 * 24 * 60 * 60 * 1000),
			),
		).toBe(true);
		expect(
			pairIsUsable(
				keyOf(dir),
				certOf(dir),
				new Date(validTo.getTime() - 12 * 60 * 60 * 1000),
			),
		).toBe(false);
	});
});

describe("ensureDevCert", () => {
	it("generates the pair with openssl when it is missing, into a created dir", () => {
		const run = vi.fn();
		const target = join(dir, "nested", ".dev-certs");

		const { key, cert } = ensureDevCert(target, {
			run,
			findOpenssl: () => "openssl",
			now: NOW,
		});

		expect(run).toHaveBeenCalledOnce();
		const [cmd, args] = run.mock.calls[0];
		expect(cmd).toBe("openssl");
		expect(args[args.indexOf("-keyout") + 1]).toBe(key);
		expect(args[args.indexOf("-out") + 1]).toBe(cert);
		expect(key).toBe(keyOf(target));
	});

	it("reuses a usable pair without touching openssl, or even looking for it", () => {
		writePair(dir);
		const run = vi.fn();
		const findOpenssl = vi.fn(() => "openssl");

		// The lookup spawns a process and this runs with every Vite config
		// evaluation, so it must not happen when the pair is fine.
		ensureDevCert(dir, { run, findOpenssl, now: NOW });

		expect(run).not.toHaveBeenCalled();
		expect(findOpenssl).not.toHaveBeenCalled();
	});

	it("regenerates an unusable pair rather than handing it to Vite", () => {
		writePair(dir, "not a key", CERT_2126);
		const run = vi.fn();

		ensureDevCert(dir, { run, findOpenssl: () => "openssl", now: NOW });

		expect(run).toHaveBeenCalledOnce();
	});

	it("says what to install when a pair is needed and there is no openssl", () => {
		const run = vi.fn();
		expect(() =>
			ensureDevCert(dir, { run, findOpenssl: () => null, now: NOW }),
		).toThrow(/openssl/i);
		expect(run).not.toHaveBeenCalled();
	});

	it("uses the resolved openssl path, not the bare name", () => {
		const run = vi.fn();
		ensureDevCert(dir, {
			run,
			findOpenssl: () => "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
			now: NOW,
		});
		expect(run.mock.calls[0][0]).toBe(
			"C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
		);
	});
});

describe("resolveOpenssl", () => {
	it("prefers the one on PATH", () => {
		expect(
			resolveOpenssl({
				platform: "linux",
				onPath: () => true,
				exists: () => false,
			}),
		).toBe("openssl");
	});

	it("falls back to Git for Windows' copy, which its installer leaves off PATH", () => {
		const env = { ProgramFiles: "C:\\Program Files" };
		const found = join(
			"C:\\Program Files",
			"Git",
			"mingw64/bin",
			"openssl.exe",
		);
		expect(
			resolveOpenssl({
				platform: "win32",
				env,
				onPath: () => false,
				exists: (p) => p === found,
			}),
		).toBe(found);
	});

	it("is null when nothing is found, and never probes Git paths off Windows", () => {
		const exists = vi.fn(() => true);
		expect(
			resolveOpenssl({ platform: "linux", onPath: () => false, exists }),
		).toBeNull();
		expect(exists).not.toHaveBeenCalled();
		expect(
			resolveOpenssl({
				platform: "win32",
				env: { ProgramFiles: "C:\\Program Files" },
				onPath: () => false,
				exists: () => false,
			}),
		).toBeNull();
	});
});
