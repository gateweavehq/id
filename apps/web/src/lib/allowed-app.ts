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

/** What each scope lets an app have, in the words of the person it is about. */
const SCOPES: Record<string, string> = {
	profile: "See your name and picture",
	email: "See your email address",
	offline_access: "Keep you signed in while you are away",
};

export function scopeWords(scopes: string[]): string[] {
	return scopes.flatMap((name) => {
		const words = Object.hasOwn(SCOPES, name) ? SCOPES[name] : undefined;
		return words ? [words] : [];
	});
}
