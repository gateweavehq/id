import { Button } from "#/components/ui/button";
import { type SignInLatch, useSignInPhase } from "#/lib/sign-in-latch";

/**
 * What a page says while the browser is leaving it with someone signed in, when its buttons are off.
 * Usually nobody has the time to read it. Someone who stopped the browser on the way, or whose app
 * never answers, does, and a browser has no event for that: so after a while it offers the one thing
 * that always works.
 */
export function SignInProgress({ latch }: { latch: SignInLatch }) {
	const phase = useSignInPhase(latch);
	if (phase === "leaving") {
		return (
			<p role="status" className="text-center text-sm text-muted-foreground">
				Taking you there…
			</p>
		);
	}
	if (phase === "still-here") {
		return (
			<div role="status" className="space-y-2 text-center text-sm text-muted-foreground">
				<p>Still here? Reload the page to try again.</p>
				<Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
					Reload
				</Button>
			</div>
		);
	}
	return null;
}
