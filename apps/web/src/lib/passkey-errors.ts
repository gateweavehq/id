// The plugin's client gives every way a passkey can fail the same shape. Some of them are a person
// changing their mind, which a page should not treat as a problem.

import { TWO_FACTORS_TO_ADD_A_PASSKEY, TWO_FACTORS_TO_REMOVE_A_PASSKEY } from "./sign-in-method";

/** What the browser reports when someone closes its window, or the wait runs out. */
const NOTHING_HAPPENED = new Set([
	"AUTH_CANCELLED",
	"ERROR_CEREMONY_ABORTED",
	"ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
]);

function codeOf(error: object): string | undefined {
	return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Whether a passkey ceremony just did not go anywhere, so that there is nothing to explain. */
export function nothingHappened(error: object): boolean {
	return NOTHING_HAPPENED.has(codeOf(error) ?? "");
}

/** What to tell someone whose passkey failed to do what they asked. */
export function passkeyFailure(error: object & { message?: string | undefined }): string {
	switch (codeOf(error)) {
		case "SESSION_NOT_FRESH":
			return "You signed in a while ago. Sign out and sign in again, then try this again.";
		// The account page says this before the button is pressed. A page loaded before another passkey
		// was added elsewhere has not heard, and gets it from the server.
		case TWO_FACTORS_TO_ADD_A_PASSKEY.code:
			return TWO_FACTORS_TO_ADD_A_PASSKEY.message;
		case TWO_FACTORS_TO_REMOVE_A_PASSKEY.code:
			return TWO_FACTORS_TO_REMOVE_A_PASSKEY.message;
		// The browser says so when the authenticator it reached holds one already. The plugin's words
		// for it are "Previously registered".
		case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
			return "This device already has a passkey for this account.";
		// A browser can go on offering a passkey that the account no longer has.
		case "PASSKEY_NOT_FOUND":
			return "That passkey is not on an account here any more. Sign in another way, and add it again from your account.";
		default:
			return error.message ?? "Something went wrong";
	}
}
