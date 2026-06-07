import { afterEach, describe, expect, it } from "vitest";
import { copyStylesIntoPipDocument } from "./pipStyles";

function makeTargetDoc(): Document {
	return document.implementation.createHTMLDocument("pip");
}

const appended: Element[] = [];

afterEach(() => {
	for (const el of appended) el.remove();
	appended.length = 0;
	document.documentElement.removeAttribute("style");
	document.documentElement.removeAttribute("lang");
	document.documentElement.className = "";
});

describe("copyStylesIntoPipDocument", () => {
	it("copies an inline <style> sheet's rules into the target head", () => {
		const style = document.createElement("style");
		style.textContent = ".pip-test{color:rgb(1,2,3)}";
		document.head.appendChild(style);
		appended.push(style);

		const target = makeTargetDoc();
		copyStylesIntoPipDocument(document, target);

		const copied = [...target.head.querySelectorAll("style")];
		const combined = copied.map((s) => s.textContent ?? "").join("");
		expect(combined).toContain(".pip-test");
	});

	it("mirrors the root inline style, class, and lang onto the target", () => {
		document.documentElement.setAttribute("style", "zoom: 1.25;");
		document.documentElement.className = "theme-x";
		document.documentElement.setAttribute("lang", "en");

		const target = makeTargetDoc();
		copyStylesIntoPipDocument(document, target);

		expect(target.documentElement.getAttribute("style")).toContain("zoom");
		expect(target.documentElement.className).toBe("theme-x");
		expect(target.documentElement.getAttribute("lang")).toBe("en");
	});

	it("resets the target body for an edge-to-edge panel", () => {
		const target = makeTargetDoc();
		copyStylesIntoPipDocument(document, target);

		expect(target.body.style.margin).toBe("0px");
		expect(target.body.style.overflow).toBe("hidden");
	});

	it("does not throw when the source has no stylesheets", () => {
		const emptySource = document.implementation.createHTMLDocument("src");
		const target = makeTargetDoc();
		expect(() => copyStylesIntoPipDocument(emptySource, target)).not.toThrow();
	});
});
