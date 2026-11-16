import { describe, expect, it } from "vitest";
import { signInSummary, type WaysToSignIn } from "./sign-in-summary";

const EVERYTHING = { passkeys: true, github: true };
const NOTHING: WaysToSignIn = { password: false, authenticator: false, passkeys: 0, github: false };

function statesOf(has: Partial<WaysToSignIn>, offered = EVERYTHING) {
	const { ways } = signInSummary({ ...NOTHING, ...has }, offered);
	return Object.fromEntries(ways.map(({ name, state }) => [name, state]));
}

function leadOf(has: Partial<WaysToSignIn>, offered = EVERYTHING) {
	return signInSummary({ ...NOTHING, ...has }, offered).lead;
}

describe("signInSummary", () => {
	it("says a password alone", () => {
		expect(leadOf({ password: true })).toBe("You sign in with your password.");
		expect(statesOf({ password: true })).toEqual({
			Password: "Set",
			"Authenticator app": "Off",
			Passkeys: "None",
			GitHub: "Not connected",
		});
	});

	it("says the code that follows a password", () => {
		expect(leadOf({ password: true, authenticator: true })).toBe(
			"You sign in with your password and a code from your authenticator app.",
		);
		expect(statesOf({ password: true, authenticator: true })["Authenticator app"]).toBe("On");
	});

	it("lists every way of a filled account, and counts its passkeys", () => {
		const has = { password: true, authenticator: true, passkeys: 2, github: true };
		expect(leadOf(has)).toBe(
			"You sign in with your password and a code from your authenticator app, a passkey or GitHub.",
		);
		expect(statesOf(has)).toEqual({
			Password: "Set",
			"Authenticator app": "On",
			Passkeys: "2 passkeys",
			GitHub: "Connected",
		});
		expect(statesOf({ passkeys: 1 }).Passkeys).toBe("1 passkey");
	});

	it("tells someone who came through GitHub that a password is optional", () => {
		expect(leadOf({ github: true })).toBe(
			"You sign in with GitHub. A password is optional: add one to sign in with your email address as well, and to turn on two-factor sign-in.",
		);
		expect(statesOf({ github: true })).toEqual({
			Password: "Not set",
			"Authenticator app": "Needs a password",
			Passkeys: "None",
			GitHub: "Connected",
		});
	});

	it("says the same of a passkey with no password behind it", () => {
		expect(leadOf({ passkeys: 1 })).toMatch(/^You sign in with a passkey\. A password is optional/);
		expect(leadOf({ passkeys: 3, github: true })).toMatch(
			/^You sign in with a passkey or GitHub\./,
		);
	});

	it("warns someone who has nothing to come back with", () => {
		expect(leadOf({})).toBe(
			"This account has nothing to sign in with again yet. Add a password or a passkey before you sign out.",
		);
		expect(leadOf({}, { passkeys: false, github: false })).toBe(
			"This account has nothing to sign in with again yet. Add a password before you sign out.",
		);
	});

	it("never says an authenticator is on for an account with no password to follow", () => {
		// A code is only ever asked for after a password, whatever the account's row says.
		expect(statesOf({ authenticator: true })["Authenticator app"]).toBe("Needs a password");
		expect(leadOf({ authenticator: true, github: true })).not.toContain("authenticator");
	});

	it("has no line for what this server does not offer", () => {
		const names = signInSummary(NOTHING, { passkeys: false, github: false }).ways.map(
			({ name }) => name,
		);
		expect(names).toEqual(["Password", "Authenticator app"]);
	});

	// Passkeys are only on with a pinned address. One made before that was taken away signs nobody in,
	// and saying it did would send someone to sign out with no way back.
	it("does not count a passkey on a server that no longer offers them", () => {
		const offered = { passkeys: false, github: true };
		expect(leadOf({ passkeys: 2 }, offered)).toBe(
			"This account has nothing to sign in with again yet. Add a password before you sign out.",
		);
		expect(leadOf({ passkeys: 2, password: true }, offered)).toBe(
			"You sign in with your password.",
		);
		expect(leadOf({ passkeys: 2, github: true }, offered)).toMatch(/^You sign in with GitHub\./);
	});
});
