const NO_VERIFIED_ADDRESS =
	"GitHub did not give us a verified email address for you. Verify one on GitHub, then try again.";

const REFUSALS: Record<string, string> = {
	access_denied: "You chose not to sign in with GitHub.",
	// Making an account, and reaching one that already has this address.
	EMAIL_NOT_VERIFIED: NO_VERIFIED_ADDRESS,
	account_not_linked:
		"An account here already has that address, and GitHub could not be linked to it. Sign in with its password or a passkey instead.",
	email_not_found: NO_VERIFIED_ADDRESS,
	SIGN_UP_CLOSED:
		"This server takes new accounts by invitation. Ask whoever runs it to invite you.",
};

/**
 * What to tell someone whose GitHub sign-in came back with this code. Only ever words of ours, and
 * never the `error_description` beside it: anyone can make a link, and it would put their text on
 * the sign-in page.
 */
export function signInRefusal(code: string | undefined): string | null {
	if (!code) return null;
	return Object.hasOwn(REFUSALS, code)
		? (REFUSALS[code] ?? null)
		: "Signing in with GitHub did not work. Try again.";
}
