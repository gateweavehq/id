import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	const result = await getAuth().api.getSession({ headers: getRequestHeaders() });
	if (!result) return null;
	// This ends up in the page. The cookie keeps the token out of reach of scripts, and no page needs
	// it.
	const { token: _token, ...session } = result.session;
	return { user: result.user, session };
});

export const getAuthOptions = createServerFn({ method: "GET" }).handler(async () => {
	const { emailEnabled, githubEnabled, turnstileSiteKey } = await import("#/server/auth");
	return { github: githubEnabled, email: emailEnabled, turnstileSiteKey };
});

/** How the signed-in person can sign in: `credential` for a password, `github`, and so on. */
export const signInMethods = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	const accounts = await getAuth().api.listUserAccounts({ headers: getRequestHeaders() });
	return accounts.map((account) => account.providerId);
});

/** Whether the signed-in person can sign in with a password. */
export const hasPassword = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	const accounts = await getAuth().api.listUserAccounts({ headers: getRequestHeaders() });
	return accounts.some((account) => account.providerId === "credential");
});
