import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_TYPES, type AuditActivity, describeActivity } from "./audit-event";

function activity(fields: Partial<AuditActivity>): AuditActivity {
	return {
		id: "1",
		at: new Date(),
		type: "sign_in",
		app: null,
		ip: null,
		device: null,
		detail: null,
		...fields,
	};
}

describe("describeActivity", () => {
	it("has words for every type the log records", () => {
		for (const type of AUDIT_EVENT_TYPES) {
			expect(describeActivity(activity({ type }))).not.toBe(type);
		}
	});

	it.each([
		["password", "Signed in with a password"],
		["passkey", "Signed in with a passkey"],
		["github", "Signed in with GitHub"],
		["code", "Signed in with a code sent by email"],
		["something-new", "Signed in"],
		[null, "Signed in"],
	])("says how someone signed in: %s", (detail, words) => {
		expect(describeActivity(activity({ type: "sign_in", detail }))).toBe(words);
	});

	it("says what two-factor sign-in did, and that an operator's change was not the person's", () => {
		const event = { id: "1", at: "2026-11-04", app: null, ip: null, device: null };
		const words = (type: string, detail: string | null = null) =>
			describeActivity({ ...event, type, detail });
		expect(words("sign_in", "totp")).toBe("Signed in with an authenticator app");
		expect(words("sign_in", "recovery_code")).toBe("Signed in with a recovery code");
		expect(words("sign_in_failed", "totp")).toBe("A sign-in with an authenticator app failed");
		expect(words("two_factor_disabled")).toBe("Turned off two-factor sign-in");
		expect(words("two_factor_disabled", "operator")).toContain("for you");
	});

	it("says which way of signing in failed", () => {
		expect(describeActivity(activity({ type: "sign_in_failed", detail: "passkey" }))).toBe(
			"A sign-in with a passkey failed",
		);
	});

	it("names the app", () => {
		expect(describeActivity(activity({ type: "app_sign_in", app: "Gateweave Track" }))).toBe(
			"Signed in to Gateweave Track",
		);
		expect(describeActivity(activity({ type: "refused", app: "Gateweave Track" }))).toBe(
			"Was refused entry to Gateweave Track",
		);
	});

	it("tells a first password from a changed one", () => {
		expect(describeActivity(activity({ type: "password_changed", detail: "first" }))).toBe(
			"Added a password",
		);
		expect(describeActivity(activity({ type: "password_changed", detail: "reset" }))).toBe(
			"Changed the password",
		);
		expect(describeActivity(activity({ type: "password_changed", detail: "removed" }))).toBe(
			"Removed the password",
		);
	});

	it("says what it does not know, as it is, from an event newer than this page", () => {
		expect(describeActivity(activity({ type: "workspace_left" }))).toBe("workspace_left");
	});
});
