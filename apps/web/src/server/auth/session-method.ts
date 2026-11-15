import type { GenericEndpointContext } from "better-auth";
import { isTwoFactor } from "../../lib/sign-in-method";
import { PROVIDER_CALLBACK, SIGN_IN_METHODS } from "./audit";

/**
 * A session's own column for how it was made. Only the hook below writes it: a field that takes no
 * input is refused from a request, and `/update-session` would otherwise let anyone name their own.
 */
export const SIGN_IN_METHOD_FIELD = {
	signInMethod: { type: "string", required: false, input: false },
} as const;

const CHANGE_PASSWORD = "/change-password";
const TWO_FACTOR_OFF = "/two-factor/disable";

/** The session a request came with, read before anything it does could end it. */
function replacedSession(context: GenericEndpointContext, userId: string): string | null {
	const current = context.context.session?.session as
		| { userId?: unknown; signInMethod?: unknown }
		| undefined;
	// Someone else's session says nothing about this one.
	if (!current || current.userId !== userId) return null;
	return typeof current.signInMethod === "string" ? current.signInMethod : null;
}

/**
 * How the session being made came about, in the audit log's words, or null where nothing says.
 *
 * Three paths replace a session rather than sign anyone in. Confirming an authenticator to turn
 * two-factor on comes after the password and with a code, so it is what a sign-in with both would be.
 * Changing a password keeps what the session it replaces had. Turning two-factor off takes the code
 * away again, and what is left is the password that was asked for.
 *
 * Any other path gets nothing, which counts as one factor. A path added later has to be decided here
 * before it can pass a workspace's rule.
 */
function methodOf(context: GenericEndpointContext | null, userId: string): string | null {
	if (!context) return null;
	const { path } = context;
	if (path === PROVIDER_CALLBACK) {
		const provider = context.params?.id;
		// A provider is one factor whatever it is called, so one named like a way of signing in that
		// counts as two says nothing rather than pass for it.
		return typeof provider === "string" && !isTwoFactor(provider) ? provider : null;
	}
	const signsIn = SIGN_IN_METHODS[path];
	if (signsIn) return signsIn;
	if (path === CHANGE_PASSWORD) return replacedSession(context, userId);
	if (path === TWO_FACTOR_OFF) {
		const replaced = replacedSession(context, userId);
		// A passkey is still what it was. A code is no longer something this person can show.
		return replaced !== "passkey" && isTwoFactor(replaced) ? "password" : replaced;
	}
	return null;
}

/**
 * For Better Auth's `databaseHooks`: writes how a session was made onto its row as it is made, so
 * that the two are one write and the row never says something else first. What the session was given
 * is replaced, since the plugins copy an old session's fields into the one that follows it.
 */
export async function withSignInMethod<Session extends { userId: string }>(
	session: Session,
	context: GenericEndpointContext | null,
) {
	return { data: { ...session, signInMethod: methodOf(context, session.userId) } };
}
