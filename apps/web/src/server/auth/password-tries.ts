import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { type RecordEvent, whereFrom } from "./audit";

/** Where someone with a session shows a password, and what the request calls it. */
const PASSWORD_FIELDS: Record<string, string> = {
	"/account/delete": "password",
	"/change-password": "currentPassword",
	"/two-factor/disable": "password",
	"/two-factor/enable": "password",
	"/two-factor/generate-backup-codes": "password",
	"/unlink-account": "password",
};

const TOO_MANY_TRIES = {
	code: "TOO_MANY_PASSWORD_TRIES",
	message: "Too many tries at your password lately. Try again later.",
};

function offersAPassword(path: string, body: Record<string, unknown> | undefined): boolean {
	const field = PASSWORD_FIELDS[path];
	return field !== undefined && typeof body?.[field] === "string";
}

export interface PasswordTriesSettings {
	record: RecordEvent;
	/** Whether someone signed in as this person may offer another password. Unlimited without it. */
	allow: ((userId: string) => Promise<boolean>) | undefined;
}

/**
 * Better Auth counts per client address, and a stolen cookie can be sent from many, so these paths also
 * share an allowance per person. It is spent before the password is checked, because spending it after
 * would let requests sent together all through.
 *
 * Only someone with a session for that account can spend it, so nobody can lock a person out with their
 * address alone, which is why signing in is not part of it. Whoever holds the cookie can spend it, but
 * signing out everywhere asks for no password and a reset asks for no session, so the way to take the
 * account back stays open.
 *
 * What it allows also bounds the rows a wrong password writes.
 */
export function passwordTries({ record, allow }: PasswordTriesSettings) {
	const matcher = ({ path = "" }: { path?: string | undefined }) => path in PASSWORD_FIELDS;
	return {
		id: "password-tries",
		hooks: {
			before: [
				{
					matcher,
					handler: createAuthMiddleware(async (ctx) => {
						if (!allow || !offersAPassword(ctx.path, ctx.body)) return;
						// Someone with no session gets the route's answer.
						const session = await getSessionFromCtx(ctx);
						if (session && !(await allow(session.user.id))) {
							throw APIError.from("TOO_MANY_REQUESTS", TOO_MANY_TRIES);
						}
					}),
				},
			],
			after: [
				{
					matcher,
					handler: createAuthMiddleware(async (ctx) => {
						const { returned } = ctx.context;
						if (!isAPIError(returned) || returned.body?.code !== "INVALID_PASSWORD") return;
						if (!offersAPassword(ctx.path, ctx.body)) return;
						const session = await getSessionFromCtx(ctx);
						if (!session) return;
						record("password_refused", { userId: session.user.id, ...whereFrom(ctx.headers) });
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}
