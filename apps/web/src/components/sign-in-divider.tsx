/** Sets the ways of signing in with a single press apart from the form below them. */
export function SignInDivider() {
	return (
		<div className="flex items-center gap-3 text-xs text-muted-foreground">
			<span className="h-px flex-1 bg-border" />
			or
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}
