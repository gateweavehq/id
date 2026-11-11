import { roleName } from "./workspace";

/** What the audit log records, and how the account page says it. */
export const AUDIT_EVENT_TYPES = [
	"account_created",
	"account_deleted",
	"sign_in",
	"sign_in_failed",
	"two_factor_asked",
	"app_sign_in",
	"refused",
	"consent_granted",
	"consent_denied",
	"consent_revoked",
	"token_revoked",
	"sessions_revoked",
	"password_changed",
	"password_refused",
	"password_link_made",
	"passkey_added",
	"passkey_removed",
	"two_factor_enabled",
	"two_factor_disabled",
	"recovery_codes_replaced",
	"provider_linked",
	"provider_unlinked",
	"app_added",
	"app_changed",
	"app_secret_replaced",
	"app_deleted",
	"app_groups_changed",
	"group_created",
	"group_renamed",
	"group_deleted",
	"group_member_added",
	"group_member_removed",
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
	"deployment_sign_up_changed",
	"deployment_invitation_created",
	"deployment_invitation_canceled",
	"deployment_allow_added",
	"deployment_allow_removed",
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

/** What an app's event keeps in `detail`: its name is all that is left once it is deleted. */
function appDetail(detail: string | null, app: string | null): { app: string; workspace?: string } {
	let parsed: { workspace?: unknown; name?: unknown } = {};
	try {
		parsed = JSON.parse(detail ?? "{}");
	} catch {
		// Words without the names are still better than nothing.
	}
	return {
		app: typeof parsed?.name === "string" ? parsed.name : (app ?? "an app"),
		...(typeof parsed?.workspace === "string" && { workspace: parsed.workspace }),
	};
}

/** The groups an app was kept to, once it has said. None is every member. */
function groupsNamedIn(detail: string | null): string[] | undefined {
	try {
		const groups: unknown = JSON.parse(detail ?? "{}")?.groups;
		return Array.isArray(groups) && groups.every((group) => typeof group === "string")
			? groups
			: undefined;
	} catch {
		return undefined;
	}
}

/** What a group's event keeps in `detail`. The group may be gone, and the workspace with it. */
function groupDetail(detail: string | null): {
	group: string;
	name: string | undefined;
	was: string;
	workspace: string;
} {
	let parsed: { group?: unknown; was?: unknown } = {};
	try {
		parsed = JSON.parse(detail ?? "{}");
	} catch {
		// Words without the name are still better than nothing.
	}
	return {
		group: typeof parsed?.group === "string" ? `the group ${parsed.group}` : "a group",
		name: typeof parsed?.group === "string" ? parsed.group : undefined,
		was: typeof parsed?.was === "string" ? `the group ${parsed.was}` : "a group",
		workspace: workspaceDetail(detail).workspace,
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
		case "account_deleted":
			return "Deleted this account";
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
		case "consent_revoked":
			return `Stopped allowing ${appDetail(detail, app).app} to see this account`;
		case "token_revoked":
			return `Ended ${theApp}'s access`;
		case "sessions_revoked":
			return detail === "everywhere" ? "Signed out everywhere" : "Signed out on another device";
		case "password_changed":
			if (detail === "first") return "Added a password";
			if (detail === "link")
				return "A new password was chosen with a link from this server's owner";
			return detail === "removed" ? "Removed the password" : "Changed the password";
		case "password_refused":
			return "A wrong password was entered while signed in";
		case "password_link_made":
			if (byOther) return `${someone} made a link to choose a new password for this account`;
			return `Made a link to choose a new password for ${other ?? "someone"}`;
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
		case "app_added": {
			const added = appDetail(detail, app);
			return added.workspace ? `Added ${added.app} to ${added.workspace}` : `Added ${added.app}`;
		}
		case "app_changed":
			return `Changed the app ${appDetail(detail, app).app}`;
		case "app_secret_replaced":
			return `Replaced the secret of ${appDetail(detail, app).app}`;
		case "app_deleted":
			return `Deleted the app ${appDetail(detail, app).app}`;
		case "app_groups_changed": {
			const called = appDetail(detail, app).app;
			const groups = groupsNamedIn(detail);
			if (!groups) return `Changed who can use ${called}`;
			return groups.length > 0
				? `Kept ${called} to ${groups.join(", ")}`
				: `Opened ${called} to everyone in ${workspaceDetail(detail).workspace}`;
		}
		case "group_created": {
			const { group, workspace } = groupDetail(detail);
			return `Made ${group} in ${workspace}`;
		}
		case "group_renamed": {
			const { name, was, workspace } = groupDetail(detail);
			return name ? `Renamed ${was} to ${name} in ${workspace}` : `Renamed ${was} in ${workspace}`;
		}
		case "group_deleted": {
			const { group, workspace } = groupDetail(detail);
			return `Deleted ${group} from ${workspace}`;
		}
		case "group_member_added": {
			const { group, workspace } = groupDetail(detail);
			if (byOther) return `${someone} added you to ${group} in ${workspace}`;
			return other
				? `Added ${other} to ${group} in ${workspace}`
				: `Joined ${group} in ${workspace}`;
		}
		case "group_member_removed": {
			const { group, workspace } = groupDetail(detail);
			if (byOther) return `${someone} took you out of ${group} in ${workspace}`;
			return other
				? `Took ${other} out of ${group} in ${workspace}`
				: `Left ${group} in ${workspace}`;
		}
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
		case "deployment_sign_up_changed":
			return detail === "open" ? "Opened sign-up on this server" : "Closed sign-up on this server";
		case "deployment_invitation_created":
			return "Invited someone to this server";
		case "deployment_invitation_canceled":
			return "Withdrew an invitation to this server";
		case "deployment_allow_added":
			return detail === "domain"
				? "Added a domain to this server's sign-up list"
				: "Added an address to this server's sign-up list";
		case "deployment_allow_removed":
			return detail === "domain"
				? "Removed a domain from this server's sign-up list"
				: "Removed an address from this server's sign-up list";
		default:
			return type;
	}
}
