import { describe, expect, it } from "vitest";
import { isValidHttpsUrl } from "./urlValidation";

describe("isValidHttpsUrl", () => {
	it.each([
		"https://example.com/image.gif",
		"HTTPS://EXAMPLE.COM/image.gif",
		"https://example.com:8443/path?q=one#two",
		"https://127.0.0.1/image.gif",
	])("accepts an absolute HTTPS URL: %s", (url) => {
		expect(isValidHttpsUrl(url)).toBe(true);
	});

	it.each([
		"http://example.com/image.gif",
		"https:",
		"https:example.com/image.gif",
		"https:/example.com/image.gif",
		"https:///path",
		"javascript:alert(1)",
		"data:image/gif;base64,R0lGODlh",
		"//example.com/image.gif",
		"/relative/image.gif",
		"not a URL",
		"",
	])("rejects a non-HTTPS or malformed URL: %s", (url) => {
		expect(isValidHttpsUrl(url)).toBe(false);
	});
});
