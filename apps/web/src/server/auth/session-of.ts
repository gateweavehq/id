import type { GenericEndpointContext } from "better-auth";
import { APIError, getSessionFromCtx } from "better-auth/api";

/**
 * The session a request came with, for a guard that decides by it and leaves a request with none
 * to the endpoint. Such a guard has to be sure that nobody is signed in before it steps aside, so
 * "nobody" is only the answer when it is known: "When a guard cannot read the session" in
 * docs/architecture.md.
 *
 * - No session cookie: nobody, and the endpoint answers as it does.
 * - A cookie, and the database has no session for it, or one that has ended: nobody, the same.
 * - A cookie, and the database cannot be asked: the failure is thrown, and the request is answered
 *   500 like any other whose query failed.
 * - A cookie, and the database has its session after all: the read before this one did not get an
 *   answer, so the request is refused with a 500 rather than decided without it.
 *
 * With a session that reads, this asks nothing more than the read every endpoint makes.
 */
export async function sessionOf(ctx: GenericEndpointContext) {
	const session = await getSessionFromCtx(ctx);
	if (session) return session;
	const { authCookies, secret, internalAdapter } = ctx.context;
	const token = await ctx.getSignedCookie(authCookies.sessionToken.name, secret);
	if (!token) return null;
	const stored = await internalAdapter.findSession(token);
	if (!stored || stored.session.expiresAt < new Date()) return null;
	throw APIError.from("INTERNAL_SERVER_ERROR", {
		code: "FAILED_TO_GET_SESSION",
		message: "Failed to get session",
	});
}
