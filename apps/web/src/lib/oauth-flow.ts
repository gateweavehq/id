// A page reached on the way to an app carries the app's request in its query, signed by the provider.
// The auth client sends that query back with every POST from the page, and the provider answers with
// where to go next. Better Auth's client follows that answer by itself, so these pages only have to
// keep the query, and to get out of the way.

export type Search = Record<string, unknown>;

/** What the provider adds to a request to sign it. */
const SIGNATURE = new Set(["sig", "exp", "ba_iat", "ba_pl", "ba_param"]);

/** What ID's own pages put beside it, which the signature ignores. */
const PAGE_OWN = new Set(["error", "error_description", "email", "redirect"]);

function without(search: Search, names: Set<string>): Search {
	return Object.fromEntries(Object.entries(search).filter(([name]) => !names.has(name)));
}

/** Whether someone is on this page on their way to an app. */
export function inFlow(search: Search): boolean {
	return typeof search.sig === "string";
}

/** The part of a page's query to take along to another page of the flow. */
export function flowSearch(search: Search): Search {
	return inFlow(search) ? without(search, PAGE_OWN) : {};
}

/** The app's request as it first arrived, to ask again when the signature has run out. */
export function restartHref(search: Search): string {
	const request = new URLSearchParams();
	for (const [name, value] of Object.entries(without(without(search, SIGNATURE), PAGE_OWN))) {
		for (const item of Array.isArray(value) ? value : [value]) {
			if (typeof item === "string") request.append(name, item);
		}
	}
	return `/api/auth/oauth2/authorize?${request}`;
}

/**
 * Whether a response says where to go. The auth client has already sent the browser there, so a page
 * that navigated as well would cancel it.
 */
export function onItsWay(data: unknown): boolean {
	return (
		typeof data === "object" &&
		data !== null &&
		"redirect" in data &&
		data.redirect === true &&
		"url" in data &&
		typeof data.url === "string"
	);
}

/** Whether a request failed because the page's signature ran out, which it does after 10 minutes. */
export function linkExpired(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"error" in error &&
		error.error === "invalid_signature"
	);
}

/**
 * Whether someone has nothing left to do on the page that asks for a first password. An app has no
 * business asking one of someone who signs in with GitHub, who can add one from their account.
 */
export function welcomeIsDone(search: Search, signInMethods: string[]): boolean {
	return inFlow(search) ? signInMethods.length > 0 : signInMethods.includes("credential");
}

/** Whether the app asked for an account to be made rather than for someone to sign in. */
export function asksForNewAccount(search: Search): boolean {
	return typeof search.prompt === "string" && search.prompt.split(" ").includes("create");
}
