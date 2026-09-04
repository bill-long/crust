import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "../lib/storageKeys";
import {
	forgetRemoteConfig,
	REMOTE_CONFIG_MAX_AGE_MS,
	recallRemoteConfig,
	rememberRemoteConfig,
} from "./remoteConfigCache";

const REMOTE = "https://ops.example.com/config.json";
const BODY = { defaultHomeserver: "example.org", gif: { enabled: true } };
const NOW = 1_700_000_000_000;

const stored = () => localStorage.getItem(STORAGE_KEYS.remoteConfig);

describe("remoteConfigCache (#581)", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		localStorage.clear();
	});

	it("recalls what it remembered, for the same URL", () => {
		rememberRemoteConfig(REMOTE, BODY, NOW);
		expect(recallRemoteConfig(REMOTE, NOW + 1000)).toEqual(BODY);
	});

	it("recalls nothing when nothing was remembered", () => {
		expect(recallRemoteConfig(REMOTE, NOW)).toBeNull();
	});

	it("forgets on demand", () => {
		rememberRemoteConfig(REMOTE, BODY, NOW);
		forgetRemoteConfig();
		expect(recallRemoteConfig(REMOTE, NOW)).toBeNull();
	});

	it("does not serve one deployment's config for another URL, and drops it", () => {
		// An installer pointed at a different deployment must not boot on the
		// previous one's keys and endpoints - nor keep them in storage.
		rememberRemoteConfig(REMOTE, BODY, NOW);
		expect(
			recallRemoteConfig("https://other.example.com/config.json", NOW),
		).toBeNull();
		expect(stored()).toBeNull();
	});

	it("uses a config up to the staleness cap and skips one past it", () => {
		rememberRemoteConfig(REMOTE, BODY, NOW);
		expect(recallRemoteConfig(REMOTE, NOW + REMOTE_CONFIG_MAX_AGE_MS)).toEqual(
			BODY,
		);
		expect(
			recallRemoteConfig(REMOTE, NOW + REMOTE_CONFIG_MAX_AGE_MS + 1),
		).toBeNull();
		// Skipped, not forgotten: the clock that judged it stale may be the
		// thing that is wrong (an RTC reset on an offline launch), and a fresh
		// copy must survive that. The next live read replaces it anyway.
		expect(stored()).not.toBeNull();
	});

	it("measures the cap in both directions", () => {
		// A clock moved back by less than the cap still reads as fresh - the
		// config was the live one when it was read. One that was far ahead when
		// the config was read must not keep it fresh long past the cap.
		rememberRemoteConfig(REMOTE, BODY, NOW);
		expect(recallRemoteConfig(REMOTE, NOW - REMOTE_CONFIG_MAX_AGE_MS)).toEqual(
			BODY,
		);
		expect(
			recallRemoteConfig(REMOTE, NOW - REMOTE_CONFIG_MAX_AGE_MS - 1),
		).toBeNull();
	});

	it("drops an entry that is not shaped like a Crust config", () => {
		localStorage.setItem(
			STORAGE_KEYS.remoteConfig,
			JSON.stringify({ url: REMOTE, fetchedAt: NOW, body: { hello: "x" } }),
		);
		expect(recallRemoteConfig(REMOTE, NOW)).toBeNull();
		expect(stored()).toBeNull();
	});

	it("drops an entry missing its URL, read time or body", () => {
		for (const raw of [
			{ url: REMOTE, body: BODY },
			{ url: REMOTE, fetchedAt: "yesterday", body: BODY },
			{ url: REMOTE, fetchedAt: Number.NaN, body: BODY },
			{ url: REMOTE, fetchedAt: NOW },
			{ fetchedAt: NOW, body: BODY },
			"not json",
		]) {
			const json = typeof raw === "string" ? raw : JSON.stringify(raw);
			localStorage.setItem(STORAGE_KEYS.remoteConfig, json);
			expect(recallRemoteConfig(REMOTE, NOW), json).toBeNull();
			expect(stored(), json).toBeNull();
		}
	});
});
