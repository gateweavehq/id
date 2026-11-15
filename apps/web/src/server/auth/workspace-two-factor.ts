import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { isTwoFactor } from "../../lib/sign-in-method";
import { can } from "../../lib/workspace";
import type { Database } from "../db";
import { schema } from "../db";
import { type RecordEvent, whereFrom } from "./audit";
import {
	NO_WORKSPACE,
	noStore,
	parseBody,
	requireFreshSession,
	requireMember,
	requireRight,
	type Session,
} from "./workspace-access";

// "A workspace that requires two-factor sign-in" in docs/architecture.md. This is only the switch:
// what it turns on is `signedInAsAsked`, which runs wherever the check for who may sign in does.

/** Shared with the page, which says the same before anyone presses anything. */
export const SECOND_FACTOR_FIRST = {
	code: "SECOND_FACTOR_FIRST",
	message:
		"Sign in with a passkey, or with your password and a code, before changing this. As you are signed in now, this workspace's apps would turn you away too.",
};

/** Whether the session asking would itself pass a workspace that requires two-factor sign-in. */
export function showedTwoFactors(session: Session): boolean {
	return isTwoFactor((session.session as { signInMethod?: unknown }).signInMethod);
}

interface TwoFactorRuleConfig {
	db: Database;
	record: RecordEvent;
}

export function workspaceTwoFactorPlugin({ db, record }: TwoFactorRuleConfig) {
	return {
		id: "workspace-two-factor",
		endpoints: {
			requireWorkspaceTwoFactor: createAuthEndpoint(
				"/workspaces/require-two-factor",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					const { organizationId, required } = parseBody(
						z.strictObject({ organizationId: z.string().min(1).max(100), required: z.boolean() }),
						ctx.body,
					);
					requireRight(can(await requireMember(db, organizationId, session), "requireTwoFactor"));
					// Turning it on can end everyone's access, and turning it off lets a password alone back in.
					requireFreshSession(session, ctx);
					// In both directions. An admin who could not pass it would find themselves outside the
					// moment it was on, and whoever holds a cookie this rule would refuse must not be the
					// one to take the rule away.
					if (!showedTwoFactors(session)) throw APIError.from("FORBIDDEN", SECOND_FACTOR_FIRST);
					const was = await db
						.select({ name: schema.organization.name })
						.from(schema.organization)
						.where(eq(schema.organization.id, organizationId))
						.get();
					// Gone since the member was read. To whoever asked, it is as if it had never been.
					if (!was) throw APIError.from("NOT_FOUND", NO_WORKSPACE);
					// One statement says whether this changed anything, so that two requests saying the
					// same thing at once cannot both find it unsaid.
					const [changed] = await db
						.update(schema.organization)
						.set({ requireTwoFactor: required })
						.where(
							and(
								eq(schema.organization.id, organizationId),
								ne(schema.organization.requireTwoFactor, required),
							),
						)
						.returning({ id: schema.organization.id });
					// Saying again what it already says changes nothing, and is nothing to write down.
					if (!changed) return { required };
					record("workspace_two_factor_changed", {
						userId: session.user.id,
						actorId: session.user.id,
						workspaceId: organizationId,
						detail: JSON.stringify({ workspace: was.name, required }),
						...whereFrom(ctx.headers),
					});
					return { required };
				},
			),
		},
		rateLimit: [
			{ pathMatcher: (path) => path === "/workspaces/require-two-factor", window: 60, max: 10 },
		],
	} satisfies BetterAuthPlugin;
}
