import { describe, expect, it } from "vitest";
import { isTwoFactor } from "./sign-in-method";

describe("a session that showed two factors", () => {
	it.each(["passkey", "totp", "recovery_code"])("is one made with %s", (method) => {
		expect(isTwoFactor(method)).toBe(true);
	});

	it.each(["password", "github", "code", "invitation", "claim"])(
		"is not one made with %s",
		(method) => {
			expect(isTwoFactor(method)).toBe(false);
		},
	);

	it("is not one that does not say how it was made, or says it oddly", () => {
		expect(isTwoFactor(null)).toBe(false);
		expect(isTwoFactor(undefined)).toBe(false);
		expect(isTwoFactor("")).toBe(false);
		expect(isTwoFactor("Passkey")).toBe(false);
		expect(isTwoFactor("passkey ")).toBe(false);
		expect(isTwoFactor(["passkey"])).toBe(false);
		expect(isTwoFactor(true)).toBe(false);
	});
});
