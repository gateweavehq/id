/**
 * How a session was made, which a workspace that requires two-factor sign-in goes by. See "A workspace
 * that requires two-factor sign-in" in docs/architecture.md.
 *
 * A passkey is two factors by itself, since user verification is required of every one. A code from an
 * authenticator and a recovery code are only ever taken after the right password. Everything else is
 * one factor: a password alone, a code sent by email, a link from the server's owner, and GitHub, whose
 * own second factor this server cannot see.
 */
const TWO_FACTOR_METHODS: readonly string[] = ["passkey", "totp", "recovery_code"];

/**
 * What the audit log adds to why someone was refused an app, when a second factor was all they lacked.
 * It follows where it happened: `authorization`, `authorization_code` or `refresh_token`.
 */
export const SECOND_FACTOR_MISSING = "+two_factor";

/**
 * Whether a session made this way showed two factors. One that does not say how it was made did not:
 * it is older than the column, or came from a path nobody has decided about, and asking that person to
 * sign in again costs little where letting them through would undo the rule.
 */
export function isTwoFactor(method: unknown): boolean {
	return typeof method === "string" && TWO_FACTOR_METHODS.includes(method);
}
