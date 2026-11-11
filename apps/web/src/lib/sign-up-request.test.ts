import { describe, expect, it } from "vitest";
import { signUpRequestUrl } from "./sign-up-request";

describe("where to ask for an account", () => {
	it("takes an https address", () => {
		expect(signUpRequestUrl("https://gateweave.com/waitlist")).toBe(
			"https://gateweave.com/waitlist",
		);
		expect(signUpRequestUrl("  https://example.com/ask?from=id ")).toBe(
			"https://example.com/ask?from=id",
		);
	});

	it.each([
		undefined,
		"",
		"http://example.com/ask",
		"javascript:alert(1)",
		"data:text/html,hi",
		"//example.com/ask",
		"example.com/ask",
		"https://user:secret@example.com/ask",
		"not a url",
	])("leaves out %s", (value) => {
		expect(signUpRequestUrl(value)).toBeUndefined();
	});
});
