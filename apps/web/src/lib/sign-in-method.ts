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
 * What someone who already has a second factor is told when they ask for another from a session that
 * showed only one factor: "Adding a second factor" in docs/architecture.md. The account page says the
 * first of these before anyone presses anything. The second covers someone whose authenticator is
 * already on as well, who has nothing to turn on, and is refused before their password is looked at.
 */
export const TWO_FACTORS_TO_ADD_A_PASSKEY = {
	code: "TWO_FACTORS_TO_ADD_A_PASSKEY",
	message: "Sign in with your passkey or your authenticator code first, then add another passkey.",
};
export const TWO_FACTORS_TO_ADD_AN_AUTHENTICATOR = {
	code: "TWO_FACTORS_TO_ADD_AN_AUTHENTICATOR",
	message: "Sign in with your passkey first, then turn on two-factor sign-in.",
};

/**
 * What a session that showed one factor is told when it asks to take a second factor away: "Taking a
 * second factor away" in docs/architecture.md. Whoever holds one of a person's factors could otherwise
 * remove the other and enrol their own in its place. The account page says these in place of the
 * controls.
 */
export const TWO_FACTORS_TO_REMOVE_A_PASSKEY = {
	code: "TWO_FACTORS_TO_REMOVE_A_PASSKEY",
	message: "Sign in with your passkey or your authenticator code first, then remove a passkey.",
};
export const TWO_FACTORS_TO_CHANGE_TWO_FACTOR = {
	code: "TWO_FACTORS_TO_CHANGE_TWO_FACTOR",
	message:
		"Sign in with your authenticator code, a recovery code or your passkey first, then turn off two-factor sign-in or replace your recovery codes.",
};

const SIGNED_IN: Record<string, string> = {
	password: "with a password",
	passkey: "with a passkey",
	github: "with GitHub",
	code: "with a code sent by email",
	totp: "with a password and an authenticator code",
	recovery_code: "with a password and a recovery code",
	invitation: "from an invitation",
	claim: "with a password",
};

/**
 * How a session was made, to finish "Chrome on Windows · …" in the list of someone's sessions.
 * Nothing for a session that does not say, or says something this build has not heard of.
 */
export function signedInWith(method: unknown): string | undefined {
	return typeof method === "string" && Object.hasOwn(SIGNED_IN, method)
		? SIGNED_IN[method]
		: undefined;
}

/**
 * Whether a session made this way showed two factors. One that does not say how it was made did not:
 * it is older than the column, or came from a path nobody has decided about, and asking that person to
 * sign in again costs little where letting them through would undo the rule.
 */
export function isTwoFactor(method: unknown): boolean {
	return typeof method === "string" && TWO_FACTOR_METHODS.includes(method);
}
