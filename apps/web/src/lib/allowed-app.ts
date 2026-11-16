/** What someone sees of an app they allowed. Only a workspace's apps are listed: the others do not ask. */
export interface AllowedApp {
	clientId: string;
	name: string | null;
	workspace: string;
	host: string | null;
	scopes: string[];
	/** When they last agreed, as the server serializes a date. */
	allowedAt: string | Date;
	/** When it last learned who they are, for as long as the activity log says. */
	lastSignIn: string | Date | null;
}

/**
 * One of the deployment's own apps that someone has signed in to. These do not ask, so there is nothing
 * to take back: the list says where the account is in use, and leads back there.
 */
export interface UsedProduct {
	/** The app's own id, such as `track`. */
	app: string;
	name: string;
	host: string | null;
	/** The origin the app is registered at, and never anything a sign-in brought along. */
	openUrl: string | null;
	/** When it last learned who they are, as the server serializes a date. */
	lastSignIn: string | Date;
}

/** What each scope lets an app have, in the words of the person it is about. */
const SCOPES: Record<string, string> = {
	profile: "See your name and picture",
	email: "See your email address",
	groups: "See which of this workspace's groups you are in",
	offline_access: "Keep you signed in while you are away",
};

export function scopeWords(scopes: string[]): string[] {
	return scopes.flatMap((name) => {
		const words = Object.hasOwn(SCOPES, name) ? SCOPES[name] : undefined;
		return words ? [words] : [];
	});
}
