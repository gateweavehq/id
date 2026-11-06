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

const NOTHING_SHARED = "Nothing was shared with it. Let whoever runs the app know.";
const NOT_DONE_HERE = `The app asked for something this server does not do. ${NOTHING_SHARED}`;
const NOT_KNOWN = "This server does not know that app, or it has been turned off.";

/**
 * The provider sends what it cannot answer to the same address as GitHub's refusals, and these are the
 * ones where it has nowhere safe to send someone back to. They are about the app and not about signing in.
 */
const REQUEST_REFUSALS: Record<string, string> = {
	invalid_redirect: `The app asked to send you back to an address it has not registered here. ${NOTHING_SHARED}`,
	invalid_client: NOT_KNOWN,
	client_disabled: NOT_KNOWN,
	unauthorized_client: NOT_DONE_HERE,
	unsupported_response_type: NOT_DONE_HERE,
	unsupported_prompt_select_account: NOT_DONE_HERE,
	invalid_request: NOT_DONE_HERE,
	request_not_supported: NOT_DONE_HERE,
	request_uri_not_supported: NOT_DONE_HERE,
	invalid_request_uri: NOT_DONE_HERE,
};

/** Words of ours for an app's request that stopped here, or null if this code is not one. */
export function requestRefusal(code: string | undefined): string | null {
	if (!code || !Object.hasOwn(REQUEST_REFUSALS, code)) return null;
	return REQUEST_REFUSALS[code] ?? null;
}

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
