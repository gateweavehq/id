import { roleName } from "./workspace";

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
	"workspace_created",
	"workspace_renamed",
	"workspace_deleted",
	"member_invited",
	"invitation_canceled",
	"invitation_accepted",
	"invitation_declined",
	"member_role_changed",
	"member_removed",
	"member_left",
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
	/** Whether someone else did this to the person reading it. */
	byOther?: boolean | undefined;
	/** The name of the other person in it, while they have an account. */
	other?: string | null | undefined;
}

/** What a workspace's event keeps in `detail`, read with care: the log outlives what wrote it. */
function workspaceDetail(detail: string | null): { workspace: string; role: string | undefined } {
	let parsed: { workspace?: unknown; role?: unknown } = {};
	try {
		parsed = JSON.parse(detail ?? "{}");
	} catch {
		// Words without the name are still better than nothing.
	}
	return {
		workspace: typeof parsed?.workspace === "string" ? parsed.workspace : "a workspace",
		role: typeof parsed?.role === "string" ? roleName(parsed.role).toLowerCase() : undefined,
	};
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
export function describeActivity({ type, app, detail, byOther, other }: AuditActivity): string {
	const theApp = app ?? "an app";
	const someone = other ?? "Someone";
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
		case "workspace_created":
			return `Created the workspace ${workspaceDetail(detail).workspace}`;
		case "workspace_renamed":
			return `Renamed a workspace to ${workspaceDetail(detail).workspace}`;
		case "workspace_deleted":
			return `Deleted the workspace ${workspaceDetail(detail).workspace}`;
		case "member_invited": {
			const { workspace, role } = workspaceDetail(detail);
			return `Invited someone to ${workspace}${role ? ` as ${role}` : ""}`;
		}
		case "invitation_canceled":
			return `Withdrew an invitation to ${workspaceDetail(detail).workspace}`;
		case "invitation_accepted":
			return `Joined ${workspaceDetail(detail).workspace}`;
		case "invitation_declined":
			return `Turned down an invitation to ${workspaceDetail(detail).workspace}`;
		case "member_left":
			return `Left ${workspaceDetail(detail).workspace}`;
		case "member_role_changed": {
			const { workspace, role = "something else" } = workspaceDetail(detail);
			if (byOther) return `${someone} made you ${role} of ${workspace}`;
			return other ? `Made ${other} ${role} of ${workspace}` : `Became ${role} of ${workspace}`;
		}
		case "member_removed": {
			const { workspace } = workspaceDetail(detail);
			if (byOther) return `${someone} removed you from ${workspace}`;
			return `Removed ${other ?? "someone"} from ${workspace}`;
		}
		default:
			return type;
	}
}
