import {
	ClientEvent,
	type MatrixClient,
	type MatrixEvent,
} from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
	state: { urlPreviews: true },
	updateSetting: vi.fn((key: string, value: boolean) => {
		if (key === "urlPreviews") settings.state.urlPreviews = value;
	}),
}));

vi.mock("../stores/settings", () => ({
	userSettings: () => settings.state,
	updateSetting: settings.updateSetting,
}));

import {
	attachUrlPreviewAccountDataSync,
	pushLocalUrlPreviewSetting,
} from "./urlPreviewSync";

const EVENT_TYPE = "m.room.preview_urls";
const MISSING_ACCOUNT_DATA = Symbol("missing account data");

type AccountDataListener = (event: MatrixEvent) => void;

function makeEvent(content: unknown, type = EVENT_TYPE): MatrixEvent {
	return {
		getContent: () => content,
		getType: () => type,
	} as unknown as MatrixEvent;
}

interface FakeClient {
	client: MatrixClient;
	emit(content: unknown, type?: string): void;
	getAccountData: ReturnType<typeof vi.fn>;
	setAccountData: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	removeListener: ReturnType<typeof vi.fn>;
}

function makeClient(
	initialContent: unknown | typeof MISSING_ACCOUNT_DATA = MISSING_ACCOUNT_DATA,
	setImpl: (type: string, content: unknown) => Promise<unknown> = async () =>
		undefined,
): FakeClient {
	const listeners = new Set<AccountDataListener>();
	const getAccountData = vi.fn(() =>
		initialContent === MISSING_ACCOUNT_DATA
			? undefined
			: makeEvent(initialContent),
	);
	const setAccountData = vi.fn(setImpl);
	const on = vi.fn((event: string, listener: AccountDataListener) => {
		if (event === ClientEvent.AccountData) listeners.add(listener);
	});
	const removeListener = vi.fn(
		(event: string, listener: AccountDataListener) => {
			if (event === ClientEvent.AccountData) listeners.delete(listener);
		},
	);
	return {
		client: {
			getAccountData,
			setAccountData,
			on,
			removeListener,
		} as unknown as MatrixClient,
		emit(content, type = EVENT_TYPE) {
			for (const listener of listeners) listener(makeEvent(content, type));
		},
		getAccountData,
		setAccountData,
		on,
		removeListener,
	};
}

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: () => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	settings.state.urlPreviews = true;
	settings.updateSetting.mockClear();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("attachUrlPreviewAccountDataSync", () => {
	it.each([
		["missing", undefined],
		["null", null],
		["primitive", "disabled"],
		["missing disable", {}],
		["non-boolean disable", { disable: "true" }],
	] as const)(
		"treats %s account data as previews enabled",
		(_label, content) => {
			settings.state.urlPreviews = false;
			const fake = content === undefined ? makeClient() : makeClient(content);

			const dispose = attachUrlPreviewAccountDataSync(fake.client);

			expect(settings.state.urlPreviews).toBe(true);
			expect(settings.updateSetting).toHaveBeenCalledWith("urlPreviews", true);
			dispose();
		},
	);

	it.each([
		[{ disable: true }, false],
		[{ disable: false }, true],
	] as const)("inverts the remote disable flag %#", (content, expected) => {
		settings.state.urlPreviews = !expected;
		const fake = makeClient(content);

		const dispose = attachUrlPreviewAccountDataSync(fake.client);

		expect(settings.state.urlPreviews).toBe(expected);
		dispose();
	});

	it("applies matching account-data events and ignores unrelated types", () => {
		const fake = makeClient();
		const dispose = attachUrlPreviewAccountDataSync(fake.client);
		settings.updateSetting.mockClear();

		fake.emit({ disable: true }, "m.push_rules");
		expect(settings.updateSetting).not.toHaveBeenCalled();

		fake.emit({ disable: true });
		expect(settings.state.urlPreviews).toBe(false);
		expect(settings.updateSetting).toHaveBeenCalledOnce();
		dispose();
	});

	it("removes its listener and per-client debounce state on dispose", async () => {
		const fake = makeClient();
		const dispose = attachUrlPreviewAccountDataSync(fake.client);
		await pushLocalUrlPreviewSetting(fake.client, false);
		dispose();

		expect(fake.removeListener).toHaveBeenCalledWith(
			ClientEvent.AccountData,
			expect.any(Function),
		);
		settings.state.urlPreviews = true;
		fake.emit({ disable: true });
		expect(settings.state.urlPreviews).toBe(true);

		const disposeAgain = attachUrlPreviewAccountDataSync(fake.client);
		settings.updateSetting.mockClear();
		fake.emit({ disable: true });
		expect(settings.state.urlPreviews).toBe(false);
		disposeAgain();
	});
});

describe("pushLocalUrlPreviewSetting", () => {
	it.each([
		[undefined, true],
		[{ disable: false }, true],
		[{ disable: true }, false],
	] as const)(
		"skips a write when remote state %# already matches",
		async (content, enabled) => {
			const fake = content === undefined ? makeClient() : makeClient(content);

			await pushLocalUrlPreviewSetting(fake.client, enabled);

			expect(fake.setAccountData).not.toHaveBeenCalled();
		},
	);

	it.each([
		[false, true],
		[true, false],
	] as const)("writes enabled=%s as disable=%s", async (enabled, disable) => {
		const fake = makeClient({ disable: enabled });

		await pushLocalUrlPreviewSetting(fake.client, enabled);

		expect(fake.setAccountData).toHaveBeenCalledWith(EVENT_TYPE, { disable });
	});

	it("keeps a rapid second toggle even while the remote value is stale", async () => {
		const first = deferred();
		const second = deferred();
		const fake = makeClient(
			undefined,
			vi
				.fn()
				.mockReturnValueOnce(first.promise)
				.mockReturnValueOnce(second.promise),
		);

		const turnOff = pushLocalUrlPreviewSetting(fake.client, false);
		const turnOn = pushLocalUrlPreviewSetting(fake.client, true);

		expect(fake.setAccountData.mock.calls).toEqual([
			[EVENT_TYPE, { disable: true }],
			[EVENT_TYPE, { disable: false }],
		]);
		first.resolve();
		second.resolve();
		await Promise.all([turnOff, turnOn]);
	});

	it("does not let an older out-of-order resolution replace the latest echo guard", async () => {
		const first = deferred();
		const second = deferred();
		const fake = makeClient(
			undefined,
			vi
				.fn()
				.mockReturnValueOnce(first.promise)
				.mockReturnValueOnce(second.promise),
		);
		const dispose = attachUrlPreviewAccountDataSync(fake.client);

		const turnOff = pushLocalUrlPreviewSetting(fake.client, false);
		const turnOn = pushLocalUrlPreviewSetting(fake.client, true);
		second.resolve();
		await turnOn;
		first.resolve();
		await turnOff;

		settings.state.urlPreviews = true;
		settings.updateSetting.mockClear();
		fake.emit({ disable: true });
		expect(settings.updateSetting).toHaveBeenCalledWith("urlPreviews", false);
		dispose();
	});

	it("suppresses only a matching recent echo and expires that guard", async () => {
		const fake = makeClient();
		const dispose = attachUrlPreviewAccountDataSync(fake.client);
		await pushLocalUrlPreviewSetting(fake.client, false);
		settings.updateSetting.mockClear();

		fake.emit({ disable: true });
		expect(settings.updateSetting).not.toHaveBeenCalled();

		settings.state.urlPreviews = false;
		fake.emit({ disable: false });
		expect(settings.updateSetting).toHaveBeenCalledWith("urlPreviews", true);

		settings.updateSetting.mockClear();
		settings.state.urlPreviews = true;
		vi.advanceTimersByTime(251);
		fake.emit({ disable: true });
		expect(settings.updateSetting).toHaveBeenCalledWith("urlPreviews", false);
		dispose();
	});

	it("clears a failed in-flight target so the same setting can be retried", async () => {
		const fake = makeClient(
			undefined,
			vi.fn().mockRejectedValue(new Error("offline")),
		);

		await pushLocalUrlPreviewSetting(fake.client, false);
		await pushLocalUrlPreviewSetting(fake.client, false);

		expect(fake.setAccountData).toHaveBeenCalledTimes(2);
	});
});
