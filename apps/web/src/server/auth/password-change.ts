import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import type { Mailer } from "../email/mailer";
import { passwordChangedEmail } from "../email/templates";

const CHANGE_PASSWORD = "/change-password";

/** What the route answers with once it has worked, and an error is not. */
const passwordChanged = z.object({ user: z.object({ email: z.string() }) });

/**
 * What changing a password does beyond changing it, with a stolen cookie in mind. It ends every
 * session whatever the request asks, since whoever knew the old password may be why it is changing
 * and may be the one asking. And it emails the person, which may be how they first hear of it.
 */
export function passwordChange(mailer: Mailer | undefined): BetterAuthPlugin {
	const matcher = ({ path }: { path?: string | undefined }) => path === CHANGE_PASSWORD;
	return {
		id: "password-change",
		hooks: {
			before: [
				{
					matcher,
					handler: createAuthMiddleware(async () => ({
						context: { body: { revokeOtherSessions: true } },
					})),
				},
			],
			after: [
				{
					matcher,
					handler: createAuthMiddleware(async (ctx) => {
						const changed = passwordChanged.safeParse(ctx.context.returned);
						if (!changed.success || !mailer) return;
						const { email } = changed.data.user;
						// The password has changed by now, so a failed email must not say otherwise.
						const told = mailer
							.send({ to: email, ...passwordChangedEmail({ email }) })
							.catch((error: unknown) => {
								const kind = error instanceof Error ? error.name : "unknown";
								console.warn(`could not send the email about a changed password: ${kind}`);
							});
						await ctx.context.runInBackgroundOrAwait(told);
					}),
				},
			],
		},
		rateLimit: [{ pathMatcher: (path) => path === CHANGE_PASSWORD, window: 60, max: 5 }],
	};
}
