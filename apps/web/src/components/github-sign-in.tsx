import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";

/** "Continue with GitHub", and the divider that sets it apart from the form below it. */
export function GitHubSignIn({ next }: { next: string }) {
	return (
		<>
			<Button
				variant="outline"
				className="w-full"
				onClick={() => authClient.signIn.social({ provider: "github", callbackURL: next })}
			>
				Continue with GitHub
			</Button>
			<div className="flex items-center gap-3 text-xs text-muted-foreground">
				<span className="h-px flex-1 bg-border" />
				or
				<span className="h-px flex-1 bg-border" />
			</div>
		</>
	);
}
