// The plugin's client gives every way a passkey can fail the same shape. Some of them are a person
// changing their mind, which a page should not treat as a problem.

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
		// A browser can go on offering a passkey that the account no longer has.
		case "PASSKEY_NOT_FOUND":
			return "That passkey is not on an account here any more. Sign in another way, and add it again from your account.";
		default:
			return error.message ?? "Something went wrong";
	}
}
