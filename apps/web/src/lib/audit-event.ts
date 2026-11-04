/** What the audit log records, and how the account page says it. */
export const AUDIT_EVENT_TYPES = [
	"account_created",
	"sign_in",
	"sign_in_failed",
	"two_factor_asked",
	"app_sign_in",
	"refused",
	"consent_granted",
	"consent_denied",
	"token_revoked",
	"sessions_revoked",
	"password_changed",
	"passkey_added",
	"passkey_removed",
	"two_factor_enabled",
	"two_factor_disabled",
	"recovery_codes_replaced",
	"provider_linked",
	"provider_unlinked",
	"app_added",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditActivity {
	id: string;
	/** When, as the server serializes a date. */
	at: string | Date;
	type: string;
	/** The app's name where it still has one, and its id otherwise. */
	app: string | null;
	ip: string | null;
	device: string | null;
	detail: string | null;
}

const SIGNED_IN_WITH: Record<string, string> = {
	password: "a password",
	passkey: "a passkey",
	github: "GitHub",
	code: "a code sent by email",
	totp: "an authenticator app",
	recovery_code: "a recovery code",
};

/** A person's own event, in their words. A type this build has not heard of says so plainly. */
export function describeActivity({ type, app, detail }: AuditActivity): string {
	const theApp = app ?? "an app";
	switch (type as AuditEventType) {
		case "account_created":
			return "Created this account";
		case "sign_in":
			return detail && SIGNED_IN_WITH[detail]
				? `Signed in with ${SIGNED_IN_WITH[detail]}`
				: "Signed in";
		case "sign_in_failed":
			return detail && SIGNED_IN_WITH[detail]
				? `A sign-in with ${SIGNED_IN_WITH[detail]} failed`
				: "A sign-in failed";
		case "two_factor_asked":
			return "Entered the right password, and was asked for a code";
		case "app_sign_in":
			return `Signed in to ${theApp}`;
		case "refused":
			return `Was refused entry to ${theApp}`;
		case "consent_granted":
			return `Allowed ${theApp} to see this account`;
		case "consent_denied":
			return `Turned down ${theApp}`;
		case "token_revoked":
			return `Ended ${theApp}'s access`;
		case "sessions_revoked":
			return "Signed out on another device";
		case "password_changed":
			if (detail === "first") return "Added a password";
			return detail === "removed" ? "Removed the password" : "Changed the password";
		case "passkey_added":
			return "Added a passkey";
		case "passkey_removed":
			return "Removed a passkey";
		case "two_factor_enabled":
			return "Turned on two-factor sign-in";
		case "two_factor_disabled":
			return detail === "operator"
				? "Two-factor sign-in was turned off for you, at your request"
				: "Turned off two-factor sign-in";
		case "recovery_codes_replaced":
			return "Replaced the recovery codes";
		case "provider_linked":
			return `Connected ${detail === "github" ? "GitHub" : (detail ?? "a sign-in provider")}`;
		case "provider_unlinked":
			return `Disconnected ${detail === "github" ? "GitHub" : (detail ?? "a sign-in provider")}`;
		case "app_added":
			return `Added ${theApp}`;
		default:
			return type;
	}
}
