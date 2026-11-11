/**
 * Where someone who wants an account on a closed server can ask for one: `SIGN_UP_REQUEST_URL`, an https
 * address. Anything else is left out, so a `javascript:` address in an href never runs as ID.
 */
export function signUpRequestUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}
