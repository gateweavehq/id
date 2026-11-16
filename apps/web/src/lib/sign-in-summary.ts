/** What an account has to sign in with, as its page needs to know it. */
export interface WaysToSignIn {
	password: boolean;
	/** Whether a password here is followed by a code from an authenticator. */
	authenticator: boolean;
	passkeys: number;
	/** Whether a GitHub account is connected, on a server that signs people in with GitHub. */
	github: boolean;
}

/** What this server offers at all. A way it does not offer gets no line. */
export interface WaysOffered {
	passkeys: boolean;
	github: boolean;
}

export interface SignInSummary {
	/** One or two sentences that say it all, for someone who reads nothing else. */
	lead: string;
	/** Each way with how it stands, in the order the page has them. */
	ways: { name: string; state: string; on: boolean }[];
}

function listed(items: string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/**
 * How someone signs in, for the top of that part of their account page. It has to read true for an
 * account with no password, which most pages about signing in assume: one that came through GitHub,
 * and one that left before choosing a password and may have nothing to come back with.
 */
export function signInSummary(has: WaysToSignIn, offered: WaysOffered): SignInSummary {
	const others = [
		// A passkey kept from when this server offered them signs nobody in now.
		...(offered.passkeys && has.passkeys > 0 ? ["a passkey"] : []),
		...(has.github ? ["GitHub"] : []),
	];
	const ways = [
		{ name: "Password", state: has.password ? "Set" : "Not set", on: has.password },
		{
			name: "Authenticator app",
			state: has.password && has.authenticator ? "On" : has.password ? "Off" : "Needs a password",
			on: has.password && has.authenticator,
		},
		...(offered.passkeys
			? [
					{
						name: "Passkeys",
						state:
							has.passkeys === 0
								? "None"
								: has.passkeys === 1
									? "1 passkey"
									: `${has.passkeys} passkeys`,
						on: has.passkeys > 0,
					},
				]
			: []),
		...(offered.github
			? [{ name: "GitHub", state: has.github ? "Connected" : "Not connected", on: has.github }]
			: []),
	];

	if (has.password) {
		const password = has.authenticator
			? "your password and a code from your authenticator app"
			: "your password";
		return { lead: `You sign in with ${listed([password, ...others])}.`, ways };
	}
	if (others.length > 0) {
		return {
			lead: `You sign in with ${listed(others)}. A password is optional: add one to sign in with your email address as well, and to turn on two-factor sign-in.`,
			ways,
		};
	}
	return {
		lead: offered.passkeys
			? "This account has nothing to sign in with again yet. Add a password or a passkey before you sign out."
			: "This account has nothing to sign in with again yet. Add a password before you sign out.",
		ways,
	};
}
