import { and, eq, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";

// "Who owns a deployment" in docs/architecture.md. The triggers in `0014_deployment_hold.sql` hold this
// however an account comes to be made. What is here asks first, to answer in words and tell the pages.

export const SIGN_UP_CLOSED = {
	code: "SIGN_UP_CLOSED",
	message: "This server takes new accounts by invitation. Ask whoever runs it to invite you.",
};

export const ONLY_THE_OWNER_MAKES_WORKSPACES = {
	code: "ONLY_THE_OWNER_MAKES_WORKSPACES",
	message: "On this server, only the person who runs it makes workspaces.",
};

/** What the page that makes accounts has to tell someone. */
export type SignUpState = "open" | "by-invitation" | "unclaimed";

/**
 * Whether this address may have a new account: the rule of the trigger `user_needs_a_way_in`. It says
 * nothing about an address that has one already, so what asks has to look at that itself.
 */
export async function mayMakeAccount(db: Database, email: string): Promise<boolean> {
	const address = email.toLowerCase();
	const now = Date.now();
	const row = await db.get<{ allowed: number }>(sql`
		SELECT (
			COALESCE((SELECT sign_up FROM deployment WHERE id = 1), 'closed') = 'open'
			OR NOT EXISTS (SELECT 1 FROM user)
			OR EXISTS (SELECT 1 FROM deployment_invitation WHERE email = ${address} AND expires_at > ${now})
			OR EXISTS (
				SELECT 1 FROM invitation
				WHERE email = ${address} AND status = 'pending' AND expires_at > ${now}
			)
		) AS allowed
	`);
	return row?.allowed === 1;
}

/**
 * A workspace invitation is a way in, so on a closed server someone who could make a workspace could let
 * in anyone at all. That leaves the owner, and whoever they make an admin of a workspace.
 */
export async function mayMakeWorkspaces(db: Database, userId: string): Promise<boolean> {
	const { deployment } = schema;
	const row = await db
		.select({ id: deployment.id })
		.from(deployment)
		.where(
			and(eq(deployment.id, 1), or(eq(deployment.signUp, "open"), eq(deployment.ownerId, userId))),
		)
		.get();
	return row !== undefined;
}

export async function signUpState(db: Database): Promise<SignUpState> {
	const row = await db.get<{ signUp: string | null; hasAccounts: number }>(sql`
		SELECT (SELECT sign_up FROM deployment WHERE id = 1) AS signUp,
			EXISTS (SELECT 1 FROM user) AS hasAccounts
	`);
	if (row?.signUp === "open") return "open";
	return row?.hasAccounts === 0 ? "unclaimed" : "by-invitation";
}
