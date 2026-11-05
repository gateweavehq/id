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
	const inAcme = JSON.stringify({ workspace: "Acme", role: "admin" });

	it.each([
		["workspace_created", "Created the workspace Acme"],
		["workspace_renamed", "Renamed a workspace to Acme"],
		["workspace_deleted", "Deleted the workspace Acme"],
		["member_invited", "Invited someone to Acme as admin"],
		["invitation_canceled", "Withdrew an invitation to Acme"],
		["invitation_accepted", "Joined Acme"],
		["invitation_declined", "Turned down an invitation to Acme"],
		["member_left", "Left Acme"],
	])("says what %s was", (type, words) => {
		expect(describeActivity(activity({ type, detail: inAcme }))).toBe(words);
	});

	it.each([
		["app_added", "Added Tool to Acme"],
		["app_changed", "Changed the app Tool"],
		["app_secret_replaced", "Replaced the secret of Tool"],
		["app_deleted", "Deleted the app Tool"],
		["consent_revoked", "Stopped allowing Tool to see this account"],
	])("says what %s was, by the name it had", (type, words) => {
		const detail = JSON.stringify({ workspace: "Acme", name: "Tool" });
		expect(describeActivity(activity({ type, detail, app: "client-id" }))).toBe(words);
	});

	it("says what an app added by a deployment was, which has no details", () => {
		expect(describeActivity(activity({ type: "app_added", app: "Track" }))).toBe("Added Track");
	});

	it("gets by when an app's details cannot be read", () => {
		const words = describeActivity(activity({ type: "app_deleted", detail: "{", app: "Tool" }));
		expect(words).toBe("Deleted the app Tool");
	});

	it("says a change of role from each side", () => {
		const type = "member_role_changed";
		expect(describeActivity(activity({ type, detail: inAcme, other: "Bob" }))).toBe(
			"Made Bob admin of Acme",
		);
		expect(describeActivity(activity({ type, detail: inAcme, byOther: true, other: "Ada" }))).toBe(
			"Ada made you admin of Acme",
		);
		expect(describeActivity(activity({ type, detail: inAcme }))).toBe("Became admin of Acme");
	});

	it("says a removal from each side, and when the other person has gone", () => {
		const type = "member_removed";
		expect(describeActivity(activity({ type, detail: inAcme, other: "Bob" }))).toBe(
			"Removed Bob from Acme",
		);
		expect(describeActivity(activity({ type, detail: inAcme, byOther: true, other: "Ada" }))).toBe(
			"Ada removed you from Acme",
		);
		expect(describeActivity(activity({ type, detail: inAcme, byOther: true, other: null }))).toBe(
			"Someone removed you from Acme",
		);
		expect(describeActivity(activity({ type, detail: inAcme, other: null }))).toBe(
			"Removed someone from Acme",
		);
	});

	it.each(["not json", "null", "[]", '{"workspace":7}', null])(
		"still has words when a workspace's detail reads %s",
		(detail) => {
			expect(describeActivity(activity({ type: "workspace_created", detail }))).toBe(
				"Created the workspace a workspace",
			);
		},
	);

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
