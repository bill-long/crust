import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	appendDevCspSources,
	comparePolicies,
	DEV_EXTRA_SOURCES,
	extractHtmlCsp,
	extractNginxCsp,
	extractTauriCsps,
	parseCsp,
} from "./csp-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

describe("parseCsp", () => {
	it("splits directives and sources", () => {
		const parsed = parseCsp(
			"default-src 'self'; connect-src 'self' https: wss:",
		);
		expect(parsed.get("default-src")).toEqual(["'self'"]);
		expect(parsed.get("connect-src")).toEqual(["'self'", "https:", "wss:"]);
	});

	it("tolerates a trailing semicolon and extra whitespace", () => {
		const parsed = parseCsp("  default-src   'self' ;  ");
		expect(parsed.get("default-src")).toEqual(["'self'"]);
		expect(parsed.size).toBe(1);
	});

	it("lower-cases directive names", () => {
		expect(parseCsp("Default-Src 'self'").has("default-src")).toBe(true);
	});

	it("throws on a duplicate directive", () => {
		expect(() => parseCsp("img-src 'self'; img-src https:")).toThrow(
			/duplicate/,
		);
	});

	it("throws on an empty policy", () => {
		expect(() => parseCsp("  ;  ")).toThrow(/empty/);
	});
});

describe("comparePolicies", () => {
	const baseline = parseCsp("default-src 'self'; connect-src 'self' https:");

	it("accepts an identical policy regardless of source order", () => {
		const actual = parseCsp("connect-src https: 'self'; default-src 'self'");
		expect(comparePolicies(baseline, actual)).toEqual([]);
	});

	it("flags a missing source", () => {
		const actual = parseCsp("default-src 'self'; connect-src 'self'");
		expect(comparePolicies(baseline, actual)).toEqual([
			`directive "connect-src" is missing source "https:"`,
		]);
	});

	it("flags a missing directive", () => {
		const actual = parseCsp("default-src 'self'");
		expect(comparePolicies(baseline, actual)).toEqual([
			`missing directive "connect-src"`,
		]);
	});

	it("flags an unexpected source", () => {
		const actual = parseCsp(
			"default-src 'self'; connect-src 'self' https: ws:",
		);
		expect(comparePolicies(baseline, actual)).toEqual([
			`directive "connect-src" has unexpected source "ws:"`,
		]);
	});

	it("flags an unexpected directive", () => {
		const actual = parseCsp(
			"default-src 'self'; connect-src 'self' https:; frame-src https:",
		);
		expect(comparePolicies(baseline, actual)).toEqual([
			`unexpected directive "frame-src"`,
		]);
	});

	it("allows listed extra sources only on their directive", () => {
		const extras = { "connect-src": ["ws:"] };
		const withWs = parseCsp(
			"default-src 'self'; connect-src 'self' https: ws:",
		);
		expect(comparePolicies(baseline, withWs, extras)).toEqual([]);
		const wsElsewhere = parseCsp(
			"default-src 'self' ws:; connect-src 'self' https:",
		);
		expect(comparePolicies(baseline, wsElsewhere, extras)).toEqual([
			`directive "default-src" has unexpected source "ws:"`,
		]);
	});
});

describe("extractors", () => {
	it("reads the meta tag from html", () => {
		const html = `<head><meta\n\thttp-equiv="Content-Security-Policy"\n\tcontent="default-src 'self'"\n/></head>`;
		expect(extractHtmlCsp(html)).toBe("default-src 'self'");
	});

	it("throws when the meta tag is absent", () => {
		expect(() => extractHtmlCsp("<head></head>")).toThrow(/no <meta/);
	});

	it("throws when the meta tag has no policy content", () => {
		const html = `<meta http-equiv="Content-Security-Policy" content="" />`;
		expect(() => extractHtmlCsp(html)).toThrow(/no content/);
	});

	it("ignores a commented-out meta tag", () => {
		const html = `<!-- <meta http-equiv="Content-Security-Policy" content="default-src 'self'" /> -->`;
		expect(() => extractHtmlCsp(html)).toThrow(/no <meta/);
	});

	it("throws on more than one meta tag", () => {
		const tag = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'" />`;
		expect(() => extractHtmlCsp(tag + tag)).toThrow(/more than one/);
	});

	it("reads the add_header value from nginx conf", () => {
		const conf = `server {\n\tadd_header Content-Security-Policy\n\t\t"default-src 'self'"\n\t\talways;\n}`;
		expect(extractNginxCsp(conf)).toBe("default-src 'self'");
	});

	it("throws when the nginx header is absent", () => {
		expect(() => extractNginxCsp("server {}")).toThrow(/no `add_header/);
	});

	it("ignores a commented-out add_header", () => {
		const conf = `server {\n\t# add_header Content-Security-Policy "default-src 'self'" always;\n}`;
		expect(() => extractNginxCsp(conf)).toThrow(/no `add_header/);
	});

	it("throws when the header is set more than once", () => {
		const line = `add_header Content-Security-Policy "default-src 'self'" always;\n`;
		expect(() => extractNginxCsp(line + line)).toThrow(/more than once/);
	});

	it("reads csp and devCsp from tauri config", () => {
		const json = JSON.stringify({
			app: {
				security: { csp: "default-src 'self'", devCsp: "img-src https:" },
			},
		});
		expect(extractTauriCsps(json)).toEqual({
			csp: "default-src 'self'",
			devCsp: "img-src https:",
		});
	});

	it("throws when the tauri policies are absent", () => {
		expect(() => extractTauriCsps("{}")).toThrow(/no app.security.csp/);
	});
});

describe("appendDevCspSources", () => {
	it("adds every dev extra to its directive and nothing else", () => {
		const patched = appendDevCspSources(read("index.html"));
		const baseline = parseCsp(extractHtmlCsp(read("index.html")));
		const dev = parseCsp(extractHtmlCsp(patched));
		// The patched policy must be exactly baseline + DEV_EXTRA_SOURCES -
		// the same contract the tauri devCsp is held to.
		expect(comparePolicies(baseline, dev, DEV_EXTRA_SOURCES)).toEqual([]);
		for (const [directive, sources] of Object.entries(DEV_EXTRA_SOURCES)) {
			for (const source of sources) {
				expect(dev.get(directive)).toContain(source);
			}
		}
	});

	it("leaves the rest of the document untouched", () => {
		const html = read("index.html");
		const patched = appendDevCspSources(html);
		const strip = (s) => s.replace(/content="[^"]*"/g, "");
		expect(strip(patched)).toBe(strip(html));
	});

	it("throws when the baseline tag is missing", () => {
		expect(() => appendDevCspSources("<head></head>")).toThrow(/no <meta/);
	});

	it("throws when a directive to extend is missing", () => {
		const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'" />`;
		expect(() => appendDevCspSources(html)).toThrow(/no "connect-src"/);
	});
});

// Wiring guard: appendDevCspSources being correct is worthless if the
// dev-only plugin is dropped from the Vite config, and nothing else would
// notice (the dev server would just serve the bare baseline, breaking HMR
// and loopback dev). The config itself can't be imported here - it pulls
// node-only dependencies into the jsdom suite - so assert the wiring at
// source level: the plugin exists, is serve-only, delegates to
// appendDevCspSources, and sits in the plugins array.
describe("vite dev CSP plugin wiring", () => {
	it("registers the serve-only dev CSP plugin", () => {
		const config = read("vite.config.ts");
		expect(config).toMatch(/name: "crust:dev-csp"/);
		expect(config).toMatch(/apply: "serve"/);
		expect(config).toMatch(/return appendDevCspSources\(html\);/);
		expect(config).toMatch(/plugins:\s*\[\s*devCsp\(\),/);
	});
});

// The real files, checked with the exact comparisons check-csp-sync.mjs runs.
// This is the drift guard running inside the unit suite as well as the build.
describe("repository CSP copies", () => {
	const baseline = parseCsp(extractHtmlCsp(read("index.html")));

	it("baseline covers the app's needs", () => {
		// Spot-check load-bearing sources so a careless baseline edit fails
		// here with a named reason, not just via a desynced copy elsewhere.
		expect(baseline.get("script-src")).toContain("'wasm-unsafe-eval'");
		expect(baseline.get("connect-src")).toContain("wss:");
		expect(baseline.get("object-src")).toEqual(["'none'"]);
	});

	it("docker-nginx.conf matches the baseline exactly", () => {
		const nginx = parseCsp(extractNginxCsp(read("docker-nginx.conf")));
		expect(comparePolicies(baseline, nginx)).toEqual([]);
	});

	it("tauri csp matches the baseline; devCsp only adds the dev extras", () => {
		const { csp, devCsp } = extractTauriCsps(
			read("desktop/src-tauri/tauri.conf.json"),
		);
		expect(comparePolicies(baseline, parseCsp(csp))).toEqual([]);
		expect(
			comparePolicies(baseline, parseCsp(devCsp), DEV_EXTRA_SOURCES),
		).toEqual([]);
	});
});

// End-to-end runs of the actual checker script, so a wiring bug in
// check-csp-sync.mjs itself (dropped check, wrong path, swallowed exit code)
// cannot pass the suite while the build gate silently weakens.
describe("check-csp-sync.mjs", () => {
	const script = join(ROOT, "scripts", "check-csp-sync.mjs");
	const run = (root) => {
		try {
			const stdout = execFileSync("node", [script, ...(root ? [root] : [])], {
				encoding: "utf8",
			});
			return { status: 0, output: stdout };
		} catch (err) {
			return { status: err.status, output: `${err.stdout}${err.stderr}` };
		}
	};

	const fixtureTree = () => {
		const dir = mkdtempSync(join(tmpdir(), "csp-sync-"));
		cpSync(join(ROOT, "index.html"), join(dir, "index.html"));
		cpSync(join(ROOT, "docker-nginx.conf"), join(dir, "docker-nginx.conf"));
		cpSync(
			join(ROOT, "desktop/src-tauri/tauri.conf.json"),
			join(dir, "desktop/src-tauri/tauri.conf.json"),
		);
		return dir;
	};

	it("exits 0 against the repository", () => {
		const result = run();
		expect(result.status).toBe(0);
		expect(result.output).toContain("in sync");
	});

	it("exits 1 when a copy drifts", () => {
		const dir = fixtureTree();
		try {
			const conf = join(dir, "docker-nginx.conf");
			writeFileSync(
				conf,
				readFileSync(conf, "utf8").replace("wss:", "wss: evil:"),
			);
			const result = run(dir);
			expect(result.status).toBe(1);
			expect(result.output).toContain(`unexpected source "evil:"`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
