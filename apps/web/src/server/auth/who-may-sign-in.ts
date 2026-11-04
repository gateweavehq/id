/**
 * Whether this person may sign in to this app: "Who may sign in" in docs/architecture.md. Workspace
 * apps and their rules join it later, in this one place.
 *
 * It fails closed. If it cannot name the app or the person, it refuses. An earlier version read the
 * client id in the wrong form, got nothing, and let everyone through while its tests for permitted
 * people still passed. So a test of this check always includes someone it refuses.
 */
export function maySignIn({
	user,
	app,
}: {
	user: { emailVerified?: unknown } | null | undefined;
	app: string | undefined;
}): boolean {
	if (!app || !user) return false;
	// Apps and Cloudflare Access trust the `email` claim, and rules such as "anyone at acme.com" rest
	// on it. No account exists without a verified address, and this holds even if one did.
	return user.emailVerified === true;
}
