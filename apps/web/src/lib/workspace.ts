import { z } from "zod";

/** What a workspace is and who may do what in it. The server and the pages decide alike from here. */

export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Who an invitation can make someone. An owner is made afterwards, by another owner, on purpose. */
export const INVITED_ROLES = ["admin", "member"] as const;

const NAME_LIMIT = 60;
const SLUG_LIMIT = 40;

/**
 * Control characters, and those that are there to hide or reorder text. The two joiners stay out of
 * this: Persian and the languages of India need them to spell words, and emoji to draw some.
 */
const HIDDEN_CHARACTERS = /[\p{Cc}\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;

/**
 * A workspace's name goes into invitations, to addresses its members do not need to know. Letting it
 * hold a link or hidden characters would make those a way to send anyone anything from this domain.
 */
export const workspaceName = z
	.string()
	.min(1, "Enter a name.")
	.max(NAME_LIMIT, `Enter a name of at most ${NAME_LIMIT} characters.`)
	.refine((name) => name === name.trim(), "A name cannot start or end with a space.")
	.refine((name) => !name.includes("://"), "A name cannot hold a link.")
	.refine((name) => !HIDDEN_CHARACTERS.test(name), "A name cannot hold control characters.");

export const workspaceSlug = z
	.string()
	.regex(
		/^[a-z0-9]+(-[a-z0-9]+)*$/,
		"An address can hold lowercase letters, digits and single hyphens.",
	)
	.min(2, "Enter an address of at least 2 characters.")
	.max(SLUG_LIMIT, `Enter an address of at most ${SLUG_LIMIT} characters.`);

/** The address a name would have, for someone who has not chosen one. */
export function slugFrom(name: string): string {
	return (
		name
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			// The one Turkish letter that does not come apart into a Latin letter and a mark.
			.replaceAll("ı", "i")
			.replace(/[^a-z0-9]+/g, "-")
			.slice(0, SLUG_LIMIT)
			.replace(/^-+|-+$/g, "")
	);
}

export interface Resources {
	see: undefined;
	leave: undefined;
	rename: undefined;
	delete: undefined;
	invite: undefined;
	seeInvitations: undefined;
	cancelInvitation: undefined;
	changeRole: { role: string; to: WorkspaceRole };
	removeMember: { role: string };
}
export type WorkspaceAction = keyof Resources;

/** Someone's place in a workspace, or null for someone with none. */
export type Actor = { role: string } | null;

function isRole(role: string): role is WorkspaceRole {
	return (WORKSPACE_ROLES as readonly string[]).includes(role);
}

/**
 * Whether this person may do this. Rights are granted by name, so a role this build has not heard of
 * has none, and nothing here asks whether someone is a plain member.
 */
export function can<Action extends WorkspaceAction>(
	actor: Actor,
	action: Action,
	...[resource]: Resources[Action] extends undefined ? [] : [Resources[Action]]
): boolean {
	if (!actor || !isRole(actor.role)) return false;
	const owner = actor.role === "owner";
	const admin = owner || actor.role === "admin";
	switch (action as WorkspaceAction) {
		case "see":
		case "leave":
			return true;
		case "rename":
		case "invite":
		case "seeInvitations":
		case "cancelInvitation":
			return admin;
		case "delete":
			return owner;
		case "changeRole": {
			const change = resource as Resources["changeRole"];
			return admin && (owner || (change.role !== "owner" && change.to !== "owner"));
		}
		case "removeMember":
			return admin && (owner || (resource as Resources["removeMember"]).role !== "owner");
		default:
			return false;
	}
}

/** A role in words, for the pages and for email. One this build has not heard of stays as it is. */
export function roleName(role: string | null): string {
	switch (role) {
		case "owner":
			return "Owner";
		case "admin":
			return "Admin";
		// The table allows an invitation with none, and the plugin makes those members.
		case null:
		case "member":
			return "Member";
		default:
			return role;
	}
}

/** What the pages read: only what they show, whatever the tables hold. */
export interface WorkspaceSummary {
	id: string;
	name: string;
	slug: string;
	role: string;
}

/** An invitation as the person it is for sees it. */
export interface InvitationForYou {
	id: string;
	workspace: string;
	role: string | null;
	/** The address of whoever sent it, which they had to prove, unlike a name they can choose. */
	inviter: string | null;
}

export interface WorkspaceMember {
	id: string;
	name: string;
	email: string;
	role: string;
}

/** An invitation as a workspace's admins see it. */
export interface PendingInvitation {
	id: string;
	email: string;
	role: string | null;
	expiresAt: string | Date;
}

export interface WorkspaceDetails {
	workspace: { id: string; name: string; slug: string };
	/** Who is asking. */
	you: { memberId: string; role: string };
	members: WorkspaceMember[];
	/** Empty for someone who may not see them. */
	invitations: PendingInvitation[];
}

const FAILURES: Record<string, string> = {
	ORGANIZATION_ALREADY_EXISTS: "That address is taken. Try another.",
	YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS:
		"You own as many workspaces as one person can. Delete one to make another.",
	USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "That person is already a member.",
	ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: "This workspace has as many members as it can hold.",
	INVITATION_LIMIT_REACHED:
		"This workspace has as many open invitations as it can hold. Withdraw some first.",
	SESSION_NOT_FRESH: "You signed in a while ago. Sign out and sign in again, then try this again.",
};

/** What to tell someone whose request failed. The plugin's own words speak of organizations. */
export function workspaceFailure(error: { code?: string | undefined; message?: string }): string {
	return (error.code && FAILURES[error.code]) || error.message || "Something went wrong";
}
