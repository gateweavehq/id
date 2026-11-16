import { useState } from "react";
import { LiveButton } from "#/components/live-button";
import { authClient } from "#/lib/auth-client";
import { flowSearch, inFlow, onItsWay, type Search } from "#/lib/oauth-flow";
import { stringifySearch } from "#/lib/search";
import { type SignInLatch, useSignInBusy, useSignInLatch } from "#/lib/sign-in-latch";

/**
 * "Continue with GitHub". A page that has another way of signing in beside it passes the latch they
 * share. Where this is the only one, it keeps its own.
 */
export function GitHubSignIn({
	next,
	search,
	latch: shared,
}: {
	next: string;
	search: Search;
	latch?: SignInLatch;
}) {
	const [error, setError] = useState<string | null>(null);
	const own = useSignInLatch();
	const latch = shared ?? own;
	const busy = useSignInBusy(latch);

	async function onClick() {
		const release = latch.take();
		if (!release) return;
		setError(null);
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
			// The browser is leaving for GitHub, and from there to ID and on to the app, all of it
			// redirects: this page shows until the last of them answers. The latch stays taken for all of
			// that. Going back from GitHub brings the page back usable (see `useSignInLatch`).
			if (!result.error && onItsWay(result.data)) return;
			setError(result.error?.message ?? "Something went wrong");
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Something went wrong");
		}
		release();
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
