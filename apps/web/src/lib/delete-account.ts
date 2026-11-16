// What stands between someone and deleting their account, in the words the server refuses with and
// the account page shows before it asks for anything.

export const RUNS_THE_SERVER = {
	code: "RUNS_THE_SERVER",
	message:
		"You run this server, so this account has to stay until someone else does. The self-hosting guide says how to hand it over.",
};

/** What the page is told before it asks for a password. The server checks again when it deletes. */
export interface DeleteAccountCheck {
	runsServer: boolean;
	/** The workspaces that would be left with no owner. */
	onlyOwnerOf: { name: string; slug: string }[];
}

/** Which workspaces need another owner first. "Of each" is for more than one. */
export function onlyOwnerWords(names: string[]): string {
	return names.length === 1
		? `You are the only owner of ${names[0]}. Make someone else an owner, or delete it, first.`
		: `You are the only owner of ${names.join(", ")}. Make someone else an owner of each, or delete it, first.`;
}
