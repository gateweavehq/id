import { describe, expect, it } from "vitest";
import { safeRedirect } from "./redirect";

describe("safeRedirect", () => {
	it("keeps paths on this site", () => {
		expect(safeRedirect("/account")).toBe("/account");
		expect(safeRedirect("/account?tab=security#top")).toBe("/account?tab=security#top");
	});

	it("refuses other sites, however they are spelled", () => {
		for (const value of [
			"https://evil.example",
			"//evil.example",
			"/\\evil.example",
			"\\\\evil.example",
			"javascript:alert(1)",
			" /account",
		]) {
			expect(safeRedirect(value)).toBeNull();
		}
	});

	it("refuses a missing value", () => {
		expect(safeRedirect(undefined)).toBeNull();
		expect(safeRedirect("")).toBeNull();
	});
});
