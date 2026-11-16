import { useState } from "react";
import { LiveButton } from "#/components/live-button";
import { SignInProgress } from "#/components/sign-in-progress";
import { authClient } from "#/lib/auth-client";
import { flowSearch, inFlow, onItsWay, type Search } from "#/lib/oauth-flow";
import { stringifySearch } from "#/lib/search";
import { getSession } from "#/lib/session";
import { type SignInLatch, useSignInBusy, useSignInLatch } from "#/lib/sign-in-latch";

type Props = { next: string; search: Search };

/**
 * "Continue with GitHub". A page that has another way of signing in beside it passes the latch they
 * share, and says how the attempt is going itself. Where this is the only one, it does both.
 */
export function GitHubSignIn({ latch, ...props }: Props & { latch?: SignInLatch }) {
	return latch ? <GitHubButton {...props} latch={latch} /> : <GitHubAlone {...props} />;
}

function GitHubAlone(props: Props) {
	const latch = useSignInLatch();
	return (
		<>
			<GitHubButton {...props} latch={latch} />
			<SignInProgress latch={latch} />
		</>
	);
}

/** Whose session the browser has, if anyone's. */
async function whoIsSignedIn(): Promise<string | null> {
	return (await getSession())?.session.id ?? null;
}

function GitHubButton({ next, search, latch }: Props & { latch: SignInLatch }) {
	const [error, setError] = useState<string | null>(null);
	const busy = useSignInBusy(latch);

	async function onClick() {
		const attempt = latch.take();
		if (!attempt) return;
		setError(null);
		// Who was signed in when they pressed, which on the way to an app that asks them to sign in
		// again can be someone. Not knowing is an answer too: then the page is never given back.
		const before = whoIsSignedIn().then(
			(session) => ({ session }),
			() => null,
		);
		try {
			const result = await authClient.signIn.social({
				provider: "github",
				callbackURL: next,
				// A refusal ends in a redirect, so it needs a page to come back to. See `signInRefusal`. On the
				// way to an app that page has to bring the signed query back, or the app's request is lost.
				errorCallbackURL: inFlow(search)
					? `/login${stringifySearch(flowSearch(search))}`
					: `/login?redirect=${encodeURIComponent(next)}`,
			});
			if (!result.error && onItsWay(result.data)) {
				// The browser is leaving for GitHub, and from there to ID and on to the app, all of it
				// redirects: this page shows until the last of them answers, and stays taken for all of
				// it. Nobody is signed in until GitHub's answer has reached ID, which makes a session. So
				// a page still showing much later, with the session it began with, is one whose trip
				// came to nothing, and can be used again. See `leave`.
				attempt.leave(async () => {
					const began = await before;
					return began !== null && (await whoIsSignedIn()) === began.session;
				});
				return;
			}
			setError(result.error?.message ?? "Something went wrong");
		} catch {
			// The request was never answered. What the browser says about that is not for people.
			setError("Something went wrong");
		}
		attempt.release();
	}

	return (
		<>
			<LiveButton variant="outline" className="w-full" disabled={busy} onClick={onClick}>
				Continue with GitHub
			</LiveButton>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</>
	);
}
