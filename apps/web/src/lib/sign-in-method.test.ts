import { describe, expect, it } from "vitest";
import { isTwoFactor, signedInWith } from "./sign-in-method";

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

describe("how a session was made, in words", () => {
	it.each([
		["password", "with a password"],
		["passkey", "with a passkey"],
		["github", "with GitHub"],
		["code", "with a code sent by email"],
		["totp", "with a password and an authenticator code"],
		["recovery_code", "with a password and a recovery code"],
		["invitation", "from an invitation"],
		["claim", "with a password"],
	])("says %s as %s", (method, words) => {
		expect(signedInWith(method)).toBe(words);
	});

	it("says nothing of a session that does not say, or says something unheard of", () => {
		expect(signedInWith(null)).toBeUndefined();
		expect(signedInWith(undefined)).toBeUndefined();
		expect(signedInWith("gitlab")).toBeUndefined();
		expect(signedInWith("constructor")).toBeUndefined();
		expect(signedInWith(["passkey"])).toBeUndefined();
	});
});
