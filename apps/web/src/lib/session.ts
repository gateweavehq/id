import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	const result = await getAuth().api.getSession({ headers: getRequestHeaders() });
	if (!result) return null;
	// This ends up in the page. The cookie keeps the token out of reach of scripts, and no page needs
	// it.
	const { token: _token, ...session } = result.session;
	// The two-factor plugin adds this, and the list of plugins is too conditional for its type to show.
	const user = result.user as typeof result.user & { twoFactorEnabled?: boolean | null };
	return { user, session };
});

export const getAuthOptions = createServerFn({ method: "GET" }).handler(async () => {
	const { emailEnabled, githubEnabled, oidcEnabled, passkeysEnabled, turnstileSiteKey } =
		await import("#/server/auth");
	return {
		github: githubEnabled,
		email: emailEnabled,
		passkeys: passkeysEnabled,
		apps: oidcEnabled,
		turnstileSiteKey,
	};
});

/** Who can make an account here. Apart from the options, which ask nothing of the database. */
export const getSignUpState = createServerFn({ method: "GET" }).handler(async () => {
	const { db } = await import("#/server/auth");
	const { signUpState } = await import("#/server/auth/deployment");
	return signUpState(db);
});

/**
 * Where to ask for an account, while sign-up is closed and the server's owner has set an address for it
 * (`SIGN_UP_REQUEST_URL`). Null otherwise, so an open server links nowhere.
 */
export const getAccessRequestUrl = createServerFn({ method: "GET" }).handler(async () => {
	const { env } = await import("cloudflare:workers");
	const { signUpRequestUrl } = await import("#/lib/sign-up-request");
	const url = signUpRequestUrl(env.SIGN_UP_REQUEST_URL);
	if (!url) return null;
	const { db } = await import("#/server/auth");
	const { signUpState } = await import("#/server/auth/deployment");
	return (await signUpState(db)) === "by-invitation" ? url : null;
});

/** Whether the signed-in person is the one who runs this server. */
export const ownsThisServer = createServerFn({ method: "GET" }).handler(async () => {
	const { db, getAuth } = await import("#/server/auth");
	const { ownsDeployment } = await import("#/server/auth/deployment");
	const signedIn = await getAuth().api.getSession({ headers: getRequestHeaders() });
	return signedIn ? ownsDeployment(db, signedIn.user.id) : false;
});

export const getLegalLinks = createServerFn({ method: "GET" }).handler(async () => {
	const { legalLinks } = await import("#/server/legal");
	return legalLinks();
});

/** How the signed-in person can sign in: `credential` for a password, `github`, `passkey`. */
export const signInMethods = createServerFn({ method: "GET" }).handler(async () => {
	const { db, getAuth } = await import("#/server/auth");
	const { hasPasskey } = await import("#/server/auth/passkeys");
	const headers = getRequestHeaders();
	const [accounts, signedIn] = await Promise.all([
		getAuth().api.listUserAccounts({ headers }),
		getAuth().api.getSession({ headers }),
	]);
	const methods = accounts.map((account) => account.providerId);
	if (signedIn && (await hasPasskey(db, signedIn.user.id))) methods.push("passkey");
	return methods;
});

/** Whether the signed-in person can sign in with a password. */
export const hasPassword = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	const accounts = await getAuth().api.listUserAccounts({ headers: getRequestHeaders() });
	return accounts.some((account) => account.providerId === "credential");
});
