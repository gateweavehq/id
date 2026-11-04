import { useState } from "react";
import { LiveButton } from "#/components/live-button";
import { authClient } from "#/lib/auth-client";
import { flowSearch, inFlow, type Search } from "#/lib/oauth-flow";
import { stringifySearch } from "#/lib/search";

/** "Continue with GitHub". */
export function GitHubSignIn({ next, search }: { next: string; search: Search }) {
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onClick() {
		setPending(true);
		setError(null);
		const result = await authClient.signIn.social({
			provider: "github",
			callbackURL: next,
			// A refusal ends in a redirect, so it needs a page to come back to. See `signInRefusal`. On the
			// way to an app that page has to bring the signed query back, or the app's request is lost.
			errorCallbackURL: inFlow(search)
				? `/login${stringifySearch(flowSearch(search))}`
				: `/login?redirect=${encodeURIComponent(next)}`,
		});
		if (result.error) setError(result.error.message ?? "Something went wrong");
		// Going back from GitHub can bring this page back as it was, so it must not stay disabled.
		setPending(false);
	}

	return (
		<>
			<LiveButton variant="outline" className="w-full" disabled={pending} onClick={onClick}>
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
