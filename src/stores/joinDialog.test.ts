import { afterEach, describe, expect, it } from "vitest";
import {
	_resetJoinDialogForTests,
	clearJoinDialogRequest,
	joinDialogRequest,
	requestJoinDialog,
} from "./joinDialog";

afterEach(() => {
	_resetJoinDialogForTests();
});

describe("joinDialog store", () => {
	it("starts empty", () => {
		expect(joinDialogRequest()).toBeNull();
	});

	it("requestJoinDialog with an address publishes the prefill", () => {
		requestJoinDialog({
			idOrAlias: "#general:example.org",
			viaServers: ["s1.org"],
		});
		expect(joinDialogRequest()).toEqual({
			prefill: {
				idOrAlias: "#general:example.org",
				viaServers: ["s1.org"],
			},
		});
	});

	it("requestJoinDialog with no argument asks for a blank (manual) open", () => {
		requestJoinDialog();
		expect(joinDialogRequest()).toEqual({ prefill: null });
	});

	it("a later request replaces the earlier one", () => {
		requestJoinDialog({ idOrAlias: "!a:example.org", viaServers: [] });
		requestJoinDialog({ idOrAlias: "!b:example.org", viaServers: [] });
		expect(joinDialogRequest()?.prefill?.idOrAlias).toBe("!b:example.org");
	});

	it("clearJoinDialogRequest resets to null", () => {
		requestJoinDialog({ idOrAlias: "!a:example.org", viaServers: [] });
		clearJoinDialogRequest();
		expect(joinDialogRequest()).toBeNull();
	});
});
