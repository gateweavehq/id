import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, freshSessionMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db";
import { schema } from "../db";
import type { Mailer } from "../email/mailer";
import { accountDeletedEmail } from "../email/templates";
import { type RecordEvent, whereFrom } from "./audit";
import { ownsDeployment } from "./deployment";
import { noStore, parseBody } from "./workspace-access";
import { detailOf } from "./workspaces";

// "Deleting an account" in docs/architecture.md.

const DELETE_ACCOUNT = "/account/delete";

const RUNS_THE_SERVER = {
	code: "RUNS_THE_SERVER",
	message:
		"You run this server, so this account has to stay until someone else does. The self-hosting guide says how to hand it over.",
};

const WRONG_PASSWORD = { code: "INVALID_PASSWORD", message: "That password is not right." };

/** What the trigger `member_delete_keeps_an_owner` would refuse, in names someone can act on. */
async function workspacesOnlyTheyOwn(db: Database, userId: string): Promise<string[]> {
	const rows = await db.all<{ name: string }>(sql`
		SELECT organization.name AS name
		FROM member
		JOIN organization ON organization.id = member.organization_id
		WHERE member.user_id = ${userId}
			AND member.role = 'owner'
			AND NOT EXISTS (
				SELECT 1 FROM member AS other
				WHERE other.organization_id = member.organization_id
					AND other.role = 'owner'
					AND other.user_id <> ${userId}
			)
		ORDER BY organization.name
	`);
	return rows.map(({ name }) => name);
}

interface DeleteAccountConfig {
	db: Database;
	/** Without it, nobody is told by email. */
	mailer: Mailer | undefined;
	record: RecordEvent;
}

/**
 * Better Auth's own `/delete-user` stays off. It lets someone with a password through without it, on a
 * recent session, and it removes a person's ways in before the row a trigger may refuse to delete.
 */
export function deleteAccountPlugin({ db, mailer, record }: DeleteAccountConfig) {
	return {
		id: "delete-account",
		endpoints: {
			deleteAccount: createAuthEndpoint(
				DELETE_ACCOUNT,
				{ method: "POST", use: [freshSessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session, internalAdapter, password } = ctx.context;
					const { user } = session;
					const body = parseBody(
						z.strictObject({
							password: z
								.string()
								.max(password.config.maxPasswordLength, WRONG_PASSWORD.message)
								.optional(),
						}),
						ctx.body,
					);

					if (await ownsDeployment(db, user.id)) {
						throw APIError.from("FORBIDDEN", RUNS_THE_SERVER);
					}
					const onlyTheirs = await workspacesOnlyTheyOwn(db, user.id);
					if (onlyTheirs.length > 0) {
						throw APIError.from("FORBIDDEN", {
							code: "ONLY_OWNER_OF_WORKSPACES",
							message: `You are the only owner of ${onlyTheirs.join(", ")}. Make someone else an owner of each, or delete it, first.`,
						});
					}

					// A cookie from the last day is not enough for this, where there is a password to ask for.
					const accounts = await internalAdapter.findAccounts(user.id);
					const hash = accounts.find(({ providerId }) => providerId === "credential")?.password;
					if (hash) {
						const right =
							body.password !== undefined &&
							(await password.verify({ hash, password: body.password }));
						if (!right) throw APIError.from("BAD_REQUEST", WRONG_PASSWORD);
					}

					const workspaces = await db
						.select({ id: schema.organization.id, name: schema.organization.name })
						.from(schema.member)
						.innerJoin(
							schema.organization,
							eq(schema.organization.id, schema.member.organizationId),
						)
						.where(eq(schema.member.userId, user.id))
						.all();

					// Through the adapter, so the hooks tell the apps. Then one statement takes the rest, and a
					// trigger that refuses it, because someone else has just left a workspace, leaves the
					// person their account. Signing in again gets them the reason.
					await internalAdapter.deleteUserSessions(user.id);
					await db.delete(schema.user).where(eq(schema.user.id, user.id)).run();
					deleteSessionCookie(ctx);

					const from = whereFrom(ctx.headers);
					record("account_deleted", { userId: user.id, ...from });
					for (const workspace of workspaces) {
						record("member_left", {
							userId: user.id,
							actorId: user.id,
							workspaceId: workspace.id,
							detail: detailOf(workspace.name),
							...from,
						});
					}
					if (mailer) {
						// The account has gone by now, so a failed email must not say otherwise.
						const told = mailer
							.send({ to: user.email, ...accountDeletedEmail({ email: user.email }) })
							.catch((error: unknown) => {
								const kind = error instanceof Error ? error.name : "unknown";
								console.warn(`could not send the email about a deleted account: ${kind}`);
							});
						await ctx.context.runInBackgroundOrAwait(told);
					}
					return { deleted: true };
				},
			),
		},
		rateLimit: [{ pathMatcher: (path) => path === DELETE_ACCOUNT, window: 60, max: 5 }],
	} satisfies BetterAuthPlugin;
}
