/**
 * What the owner's page says about sign-up. An account needs a proven address, which takes email or
 * GitHub, so on a server with neither, opening sign-up would let nobody in, whatever it said.
 */
export function signUpWords({
	signUp,
	email,
	github,
}: {
	signUp: "open" | "closed";
	email: boolean;
	github: boolean;
}): {
	/** Who can make an account now. */
	now: string;
	/** Who opening it would let in, to ask first, or null when it would let in nobody. */
	opening: string | null;
} {
	const proves = email || github;
	if (signUp === "open") {
		if (!proves) {
			return {
				now: "Sign-up is open, but this server has neither email nor GitHub to prove an address with, so nobody can use it.",
				opening: null,
			};
		}
		return {
			now: email
				? "Anyone can make an account here, and make workspaces."
				: "Anyone with a GitHub account can make an account here, and make workspaces.",
			opening: null,
		};
	}
	if (!proves) {
		return {
			now: "Only people you invite can make an account here. Only you can make workspaces. Opening sign-up takes email or GitHub, to prove an address with, and this server has neither.",
			opening: null,
		};
	}
	return {
		now: "Only people invited, by you or by a workspace, can make an account here. Only you can make workspaces.",
		opening: email
			? "Anyone who finds this server could then make an account and a workspace."
			: "Anyone with a GitHub account could then make an account and a workspace.",
	};
}
