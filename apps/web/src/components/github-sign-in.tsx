import { useState } from "react";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";

/** "Continue with GitHub", and the divider that sets it apart from the form below it. */
export function GitHubSignIn({ next }: { next: string }) {
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onClick() {
		setPending(true);
		setError(null);
		const result = await authClient.signIn.social({
			provider: "github",
			callbackURL: next,
			// A refusal ends in a redirect, so it needs a page to come back to. See `signInRefusal`.
			errorCallbackURL: `/login?redirect=${encodeURIComponent(next)}`,
		});
		if (result.error) setError(result.error.message ?? "Something went wrong");
		// Going back from GitHub can bring this page back as it was, so it must not stay disabled.
		setPending(false);
	}

	return (
		<>
			<Button variant="outline" className="w-full" disabled={pending} onClick={onClick}>
				Continue with GitHub
			</Button>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="flex items-center gap-3 text-xs text-muted-foreground">
				<span className="h-px flex-1 bg-border" />
				or
				<span className="h-px flex-1 bg-border" />
			</div>
		</>
	);
}
