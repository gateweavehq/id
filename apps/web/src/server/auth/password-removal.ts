import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

const UNLINK_ACCOUNT = "/unlink-account";

/**
 * To `/unlink-account` a password is one more row, and all it asks for is a recent session. Changing a
 * password asks for the old one, and `/account/first-password` only sets one where there is none, so
 * this was the way around both: a stolen cookie could remove the password and then choose its own.
 */
export function passwordRemoval() {
	return {
		id: "password-removal",
		hooks: {
			before: [
				{
					matcher: ({ path }) => path === UNLINK_ACCOUNT,
					handler: createAuthMiddleware(async (ctx) => {
						// Someone with no session, or naming a row that is not theirs, gets the route's answer.
						const session = await getSessionFromCtx(ctx);
						if (!session) return;
						const { internalAdapter, password } = ctx.context;
						const accounts = await internalAdapter.findAccounts(session.user.id);
						const row = accounts.find(({ id }) => id === ctx.body?.accountId);
						if (row?.providerId !== "credential" || !row.password) return;
						const given = ctx.body?.password;
						const right =
							typeof given === "string" &&
							given.length <= password.config.maxPasswordLength &&
							(await password.verify({ hash: row.password, password: given }));
						if (!right) {
							throw APIError.from("BAD_REQUEST", {
								code: "INVALID_PASSWORD",
								message: "That password is not right.",
							});
						}
					}),
				},
			],
		},
		rateLimit: [{ pathMatcher: (path) => path === UNLINK_ACCOUNT, window: 60, max: 5 }],
	} satisfies BetterAuthPlugin;
}
